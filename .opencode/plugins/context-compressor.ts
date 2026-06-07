import type { Plugin } from "@opencode-ai/plugin"

const COMPRESS_COMMAND = "compress-all"
const COMPRESS_AGENT = "Compresser"

interface RawPart {
    partID: string
    messageID: string
    role: string
    type: string
    text?: string
    tool?: string
    callID?: string
    status?: string
    input?: unknown
    output?: string
}

// ---------------------------------------------------------------------------
// SDK-backed helpers — reuse ctx.client's built-in auth
// ---------------------------------------------------------------------------

/** Extract the underlying hey-api Client from the SDK client for PATCH/DELETE. */
function rawClient(ctx: { client: any }): any {
    return (ctx.client as any)._client
}

function dirQuery(directory: string): string {
    return `?directory=${encodeURIComponent(directory)}`
}

async function fetchMessages(ctx: { client: any; directory: string }, sessionID: string): Promise<any> {
    const response = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
    })
    return response?.data ?? response
}

async function clientPATCH(
    client: any,
    directory: string,
    path: string,
    body: Record<string, unknown>,
): Promise<void> {
    const result = await client.patch({
        url: path + dirQuery(directory),
        headers: { "Content-Type": "application/json" },
        body: body,
    })
    if (result.error) throw new Error(`PATCH ${path} failed: ${JSON.stringify(result.error)}`)
}

async function clientDELETE(client: any, directory: string, path: string): Promise<void> {
    const result = await client.delete({
        url: path + dirQuery(directory),
    })
    if (result.error) throw new Error(`DELETE ${path} failed: ${JSON.stringify(result.error)}`)
}

function isAlreadyHandled(part: Record<string, unknown>): boolean {
    // Current format: text part with metadata.compressed = summary anchor (visible to agent, detectable by metadata)
    if (part.type === "text" && typeof part.metadata === "object" && part.metadata !== null && (part.metadata as Record<string, unknown>).compressed === true) return true
    // Legacy: brief period where compressed parts had type="compressed"
    if (part.type === "compressed") return true
    // Legacy: check for old <<<MVP_COMPRESSED_CONTEXT>>> header markers
    return part.type === "text" && typeof part.text === "string" && (part.text as string).includes("<<<MVP_COMPRESSED_CONTEXT")
}

function stripCompressorMetadata(part: Record<string, unknown>): void {
    if (typeof part.metadata !== "object" || part.metadata === null) return
    const metadata = part.metadata as Record<string, unknown>
    if (metadata.compressed !== true && metadata.compressionBoundary !== true) return

    delete metadata.compressed
    delete metadata.compressionBoundary
    if (Object.keys(metadata).length === 0) delete part.metadata
}

async function collectRawParts(
    rc: any,
    directory: string,
    sessionID: string,
    maxMessages?: number,
): Promise<{ rawParts: RawPart[]; messages: Array<{ info: { id: string }; parts: Array<Record<string, unknown>> }> }> {
    const messages: Array<{ info: { id: string; role: string }; parts: Array<Record<string, unknown>> }> = await rc.client.session
        .messages({ path: { id: sessionID }, query: { directory } })
        .then((r: any) => r?.data ?? r)

    const rawParts = collectPartsFromMessages(messages, maxMessages)

    return { rawParts, messages }
}

// ---------------------------------------------------------------------------
// High-fidelity per-part compression
// ---------------------------------------------------------------------------

/** Parts below this many tokens are left as-is (Compresser call overhead exceeds savings). */
const MIN_COMPRESS_TOKENS = 200

function isReadTool(part: RawPart): boolean {
    return part.type === "tool" && part.tool === "read"
}

function isGlobTool(part: RawPart): boolean {
    return part.type === "tool" && part.tool === "glob"
}

function isDirectReplaceTool(part: RawPart): boolean {
    return isReadTool(part) || isGlobTool(part)
}

function extractReadFilePath(input: unknown): string {
    if (typeof input === "object" && input !== null) {
        const obj = input as Record<string, unknown>
        if (typeof obj.filePath === "string") return obj.filePath
        if (typeof obj.path === "string") return obj.path
    }
    if (typeof input === "string") return input
    return JSON.stringify(input)
}

function extractGlobPattern(input: unknown): string {
    if (typeof input === "object" && input !== null) {
        const obj = input as Record<string, unknown>
        if (typeof obj.pattern === "string") return obj.pattern
        if (typeof obj.include === "string") return obj.include
    }
    if (typeof input === "string") return input
    return JSON.stringify(input)
}

/** Rough token estimate: ~1 token per 4 chars for mixed code/English content. */
function estimateRawPartTokens(part: RawPart): number {
    if (part.type === "text" || part.type === "reasoning") {
        return Math.ceil((part.text ?? "").length / 4)
    }
    if (part.type === "tool") {
        const input = JSON.stringify(part.input ?? "")
        const output = part.output ?? ""
        return Math.ceil((input.length + output.length) / 4)
    }
    return 0
}

function buildSinglePartPrompt(part: RawPart): string {
    return [
        "Concisely summarize this piece of conversation history for task continuity.",
        "Preserve key facts, decisions, code references, file paths, errors, and user constraints.",
        "Drop fluff, repeated explanations, and verbose tool output.",
        "Return only the summary, no preamble.",
        "",
        "=== CONTENT ===",
        formatRawPart(part),
        "=== END ===",
    ].join("\n")
}

function formatRawPart(part: RawPart): string {
    if (part.type === "tool") {
        return [
            `<part id="${part.partID}" message="${part.messageID}" role="${part.role}" type="tool" tool="${part.tool}" callID="${part.callID}" status="${part.status}">`,
            `input: ${JSON.stringify(part.input)}`,
            `output: ${part.output ?? ""}`,
            "</part>",
        ].join("\n")
    }

    return [
        `<part id="${part.partID}" message="${part.messageID}" role="${part.role}" type="${part.type}">`,
        part.text ?? "",
        "</part>",
    ].join("\n")
}

// ---------------------------------------------------------------------------
// Plugin helper
// ---------------------------------------------------------------------------

function responseData(response: any) {
    return response?.data ?? response
}

function responseText(response: any): string {
    const data = responseData(response)
    const parts = data?.parts ?? []
    const text = parts
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim()
    if (!text) throw new Error("Compresser returned no text summary")
    return text
}

// ===== Auto-trigger configuration =====

interface CompressorPluginConfig {
    agentContextWindow?: number
    compressTriggerMultiple?: number
}

const CONFIG_DEFAULTS = {
    agentContextWindow: 80000,
    compressTriggerMultiple: 1.5,
} as const

const MIN_WINDOW_TOKENS = 1024
const MIN_MULTIPLE = 1.5
const MESSAGE_FLOOR = 5
const COMPRESS_COOLDOWN = 5

// ===== Token estimation (rough: ~1 token per 4 chars for mixed content) =====

function estimateTokenCount(text: string): number {
    if (!text) return 0
    // OpenCode content is mostly code + English (~1 token / 4 chars).
    // Use length/4 to avoid overestimating tokens, which would cause
    // computeProtectedCount to under-protect (compress messages within the window).
    return Math.ceil(text.length / 4)
}

function estimatePartTokens(part: Record<string, unknown>): number {
    if (part.type === "text" || part.type === "reasoning") {
        return estimateTokenCount(typeof part.text === "string" ? part.text : "")
    }
    if (part.type === "tool") {
        const state = (part.state as Record<string, unknown>) ?? {}
        const input = JSON.stringify(state.input ?? "")
        const output = typeof state.output === "string" ? state.output : ""
        return estimateTokenCount(input) + estimateTokenCount(output)
    }
    return 0
}

/**
 * Count raw tokens for a message, using actual API token data when available.
 *
 * For assistant messages where ALL meaningful parts (text, reasoning, tool) are
 * still uncompressed, we use the real `output + reasoning` token counts from the
 * API — these are exact. Tool results are not part of `output`, so we estimate
 * those separately via `estimatePartTokens`.
 *
 * For user messages, or messages with partially compressed parts, we fall back
 * to the heuristic `length/4` estimator.
 */
function getMessageRawTokens(
    msg: { info: { role: string; tokens?: { output?: number; reasoning?: number } }; parts: Array<Record<string, unknown>> },
): number {
    const meaningfulParts = msg.parts.filter(
        (p) => p.type !== "step-start" && p.type !== "step-finish",
    )
    if (meaningfulParts.length === 0) return 0

    const rawParts = meaningfulParts.filter((p) => !isAlreadyHandled(p))
    const allRaw = rawParts.length === meaningfulParts.length

    // For fully-raw assistant messages, use actual API token data (exact)
    if (msg.info.role === "assistant" && msg.info.tokens && allRaw) {
        let total = (msg.info.tokens.output ?? 0) + (msg.info.tokens.reasoning ?? 0)
        // Tool results are not counted in output+reasoning — estimate them
        for (const part of rawParts) {
            if (part.type === "tool") total += estimatePartTokens(part)
        }
        return total
    }

    // Fall back: estimate all raw parts
    let total = 0
    for (const part of rawParts) total += estimatePartTokens(part)
    return total
}

/** How many of the most recent messages should be protected from compression. */
function computeProtectedCount(
    messages: Array<{ info: { role: string }; parts: Array<Record<string, unknown>> }>,
    tokenBudget: number,
    messageFloor: number,
): number {
    let accumulated = 0
    let protectedCount = 0

    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        protectedCount++

        accumulated += getMessageRawTokens(msg)

        if (protectedCount >= messageFloor && accumulated >= tokenBudget) break
    }

    return Math.min(protectedCount, messages.length)
}

// ===== High-fidelity per-part compression (shared between manual and auto) =====

async function doCompression(
    ctx: { client: any; directory: string },
    directory: string,
    sessionID: string,
    rawParts: RawPart[],
    messages: Array<{ info: { id: string }; parts: Array<Record<string, unknown>> }>,
): Promise<{ compressedCount: number; directReplacedCount: number; skippedCount: number; boundaryMsgID: string }> {
    // Build partID → messageID lookup
    const partToMessage = new Map<string, string>()
    for (const msg of messages) {
        for (const part of msg.parts) {
            partToMessage.set(part.id as string, msg.info.id)
        }
    }

    const cl = rawClient(ctx)
    let compressedCount = 0
    let directReplacedCount = 0
    let skippedCount = 0
    let boundaryMsgID = ""

    // Create temp session (reused for all per-part prompts)
    const created = responseData(
        await ctx.client.session.create({
            body: { title: `Compressor scratch for ${sessionID}` },
            query: { directory },
        }),
    )
    const tempSessionID = created.id

    try {
        for (const rawPart of rawParts) {
            const msgID = partToMessage.get(rawPart.partID)
            if (!msgID) continue

            // Read/glob tools → direct replacement (no LLM call)
            if (isReadTool(rawPart)) {
                const path = extractReadFilePath(rawPart.input)
                await clientPATCH(cl, directory,
                    `/session/${sessionID}/message/${msgID}/part/${rawPart.partID}`,
                    {
                        id: rawPart.partID,
                        sessionID,
                        messageID: msgID,
                        type: "text",
                        text: `read ${path}`,
                        synthetic: false,
                        ignored: false,
                        metadata: { compressed: true },
                    },
                )
                directReplacedCount++
                compressedCount++
                continue
            }

            // Glob tool → direct replacement (no LLM call)
            if (isGlobTool(rawPart)) {
                const pattern = extractGlobPattern(rawPart.input)
                await clientPATCH(cl, directory,
                    `/session/${sessionID}/message/${msgID}/part/${rawPart.partID}`,
                    {
                        id: rawPart.partID,
                        sessionID,
                        messageID: msgID,
                        type: "text",
                        text: `glob ${pattern}`,
                        synthetic: false,
                        ignored: false,
                        metadata: { compressed: true },
                    },
                )
                directReplacedCount++
                compressedCount++
                continue
            }

            // Too few tokens (Compresser call overhead > savings) → keep original as-is
            if (estimateRawPartTokens(rawPart) < MIN_COMPRESS_TOKENS) {
                skippedCount++
                continue
            }

            // Send this single part to Compresser for focused summarization
            const summary = responseText(
                await ctx.client.session.prompt({
                    path: { id: tempSessionID },
                    body: {
                        agent: COMPRESS_AGENT,
                        parts: [{ type: "text", text: buildSinglePartPrompt(rawPart) }],
                    },
                    query: { directory },
                }),
            )

            // PATCH original part with per-part summary
            await clientPATCH(cl, directory,
                `/session/${sessionID}/message/${msgID}/part/${rawPart.partID}`,
                {
                    id: rawPart.partID,
                    sessionID,
                    messageID: msgID,
                    type: "text",
                    text: summary.trim(),
                    synthetic: false,
                    ignored: false,
                    metadata: { compressed: true },
                },
            )
            compressedCount++
        }
        // Create a boundary summary message in the user's session (no LLM, just record keeping)
        // This marks "everything before this message is compressed history"
        const boundaryParts = rawParts.filter(p => !isDirectReplaceTool(p) && estimateRawPartTokens(p) >= MIN_COMPRESS_TOKENS).length
        const boundaryText = [
            `── Compression Boundary ──`,
            `Processed ${compressedCount} part(s)` +
                (directReplacedCount > 0 ? ` (${directReplacedCount} tools replaced directly)` : "") +
                (skippedCount > 0 ? `, ${skippedCount} too short skipped` : ""),
            `${boundaryParts} part(s) summarized by Compresser agent. Original data preserved in message history.`,
        ].join("\n")

        const boundary = responseData(
            await ctx.client.session.prompt({
                path: { id: sessionID },
                body: {
                    noReply: true,
                    parts: [{
                        type: "text",
                        text: boundaryText.trim(),
                        metadata: { compressed: true, compressionBoundary: true },
                    }],
                },
                query: { directory },
            }),
        )
        boundaryMsgID = boundary?.info?.id ?? ""
    } finally {
        await ctx.client.session.delete({ path: { id: tempSessionID } })
    }

    return {
        compressedCount,
        directReplacedCount,
        skippedCount,
        boundaryMsgID,
    }
}

// ===== Shared part extraction (works on pre-fetched messages, avoids re-fetch) =====

function collectPartsFromMessages(
    messages: Array<{ info: { id: string; role: string }; parts: Array<Record<string, unknown>> }>,
    maxMessages?: number,
): RawPart[] {
    const rawParts: RawPart[] = []
    const limit = maxMessages != null ? Math.min(maxMessages, messages.length) : messages.length

    for (let i = 0; i < limit; i++) {
        const msg = messages[i]
        if (msg.info.role === "user") continue  // user messages → preserve verbatim

        for (const part of msg.parts) {
            if (part.type === "step-start" || part.type === "step-finish") continue
            if (isAlreadyHandled(part)) continue
            if ((part as any).synthetic) continue  // system-injected parts → preserve

            if (part.type === "tool") {
                const state = (part.state as Record<string, unknown>) ?? {}
                if (state.status === "error") continue  // error tools → preserve error details verbatim
            }

            const item: RawPart = {
                partID: part.id as string,
                messageID: msg.info.id,
                role: msg.info.role,
                type: part.type as string,
            }

            if (part.type === "text" || part.type === "reasoning") {
                item.text = typeof part.text === "string" ? part.text : ""
            }

            if (part.type === "tool") {
                const state = (part.state as Record<string, unknown>) ?? {}
                item.tool = part.tool as string
                item.callID = part.callID as string
                item.status = state.status as string
                item.input = state.input
                item.output = typeof state.output === "string" ? state.output : ""
            }

            rawParts.push(item)
        }
    }

    return rawParts
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const ContextCompressorPlugin: Plugin = async (ctx, options) => {
    const pluginConfig: CompressorPluginConfig = {
        ...CONFIG_DEFAULTS,
        ...(options as CompressorPluginConfig | undefined),
    }
    const windowTokens = Math.max(
        pluginConfig.agentContextWindow ?? CONFIG_DEFAULTS.agentContextWindow,
        MIN_WINDOW_TOKENS,
    )
    const triggerMultiple = Math.max(
        pluginConfig.compressTriggerMultiple ?? CONFIG_DEFAULTS.compressTriggerMultiple,
        MIN_MULTIPLE,
    )

    let lastCompressedMsgCount = 0
    const compressingSessions = new Set<string>()

    return {
        config: async (config) => {
            config.command ??= {}
            config.command[COMPRESS_COMMAND] = {
                template: "",
                description: "Compressor: compress current-session raw parts with the Compresser agent",
            }
        },

        "experimental.chat.messages.transform": async (_input, output) => {
            for (const msg of output.messages) {
                for (const part of msg.parts) stripCompressorMetadata(part as Record<string, unknown>)
            }
        },

        "chat.message": async (input) => {
            if (!input.sessionID || !input.messageID) return

            // Concurrency guard: only one async compression per session
            if (compressingSessions.has(input.sessionID)) return

            const messages: Array<{ info: { id: string; role: string }; parts: Array<Record<string, unknown>> }> =
                await ctx.client.session
                    .messages({ path: { id: input.sessionID }, query: { directory: ctx.directory } })
                    .then((r: any) => r?.data ?? r)

            // Count total raw tokens across all messages
            // Uses actual API token data for assistant messages where available
            let totalRawTokens = 0
            for (const msg of messages) {
                totalRawTokens += getMessageRawTokens(msg)
            }

            // Check threshold: trigger when total > window × multiple
            const threshold = Math.floor(windowTokens * triggerMultiple)
            if (totalRawTokens <= threshold) return

            // Cooldown: skip if we just compressed
            if (messages.length - lastCompressedMsgCount < COMPRESS_COOLDOWN) return

            // Determine how many of the most recent messages to protect
            const protectedCount = computeProtectedCount(messages, windowTokens, MESSAGE_FLOOR)
            const compressibleCount = messages.length - protectedCount
            if (compressibleCount <= 0) return

            // Collect parts from the oldest (compressible) messages only
            const rawParts = collectPartsFromMessages(messages, compressibleCount)
            if (rawParts.length === 0) return

            // Fire async — do NOT await, so hook returns immediately
            compressingSessions.add(input.sessionID)
            doCompression(ctx, ctx.directory, input.sessionID, rawParts, messages)
                .then((result) => {
                    lastCompressedMsgCount = messages.length
                    let msg = `[Compressor] Auto-compressed ${result.compressedCount} part(s)`
                    if (result.directReplacedCount > 0) msg += ` (${result.directReplacedCount} tools replaced directly)`
                    if (result.skippedCount > 0) msg += `, ${result.skippedCount} too short skipped`
                    console.log(msg)
                })
                .catch((err) => {
                    console.error("[Compressor] Auto-compression failed:", err)
                })
                .finally(() => {
                    compressingSessions.delete(input.sessionID)
                })
        },

        "command.execute.before": async (input, output) => {
            if (input.command !== COMPRESS_COMMAND) return

            const { rawParts, messages } = await collectRawParts(ctx, ctx.directory, input.sessionID)
            if (rawParts.length === 0) {
                output.parts.length = 0
                output.parts.push({ type: "text", text: "Compressor plugin found no raw parts to compress." })
                return
            }

            const result = await doCompression(ctx, ctx.directory, input.sessionID, rawParts, messages)

            output.parts.length = 0
            let msg = `Compressor plugin processed ${result.compressedCount} part(s)`
            if (result.directReplacedCount > 0) msg += ` (${result.directReplacedCount} tools replaced directly)`
            if (result.skippedCount > 0) msg += `, ${result.skippedCount} too short skipped`
            msg += ` for session: ${input.sessionID}. Boundary: ${result.boundaryMsgID}.`
            output.parts.push({ type: "text", text: msg })
        },
    }
}
