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
        .then(responseData)

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

/** Safe defaults used when no model context info is available. */
const FALLBACK_DEFAULTS = {
    agentContextWindow: 64000,
    compressTriggerMultiple: 2.0,
} as const

/** Apply a compression event no sooner than this many messages after the last one. */
const COMPRESS_COOLDOWN = 5

/** Protect at least this many most-recent messages from compression. */
const MESSAGE_FLOOR = 5

/**
 * Calculate optimal compression parameters from the model's max context window.
 *
 * Formula:
 *   safe_context    = context_window × 0.7            (30% headroom for system prompt / schemas)
 *   agentContextWindow = safe_context × 0.5            (50% for the raw window)
 *   compressTriggerMultiple = 2.0                      (compress when total > 2× window)
 *
 * After compression: ~1 window of raw content remains, ~1 window of summaries added.
 * Total prompt ≈ window × 1.06 → comfortably fits in provider cache.
 */
function calculateOptimalDefaults(contextWindow: number): { agentContextWindow: number; compressTriggerMultiple: number } {
    const safeContext = Math.floor(contextWindow * 0.7)
    const window = Math.floor(safeContext * 0.5)
    return {
        agentContextWindow: Math.max(16000, Math.min(window, 128000)),
        compressTriggerMultiple: 2.0,
    }
}

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

    // Collect all PATCH operations in a buffer, apply in batch at the end.
    // This avoids the main agent seeing individual parts being modified
    // mid-stream, which would invalidate its cache on every single write.
    const pendingPatches: Array<{ path: string; body: any }> = []

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
            if (isDirectReplaceTool(rawPart)) {
                let label: string
                let text: string
                if (isReadTool(rawPart)) {
                    label = "read"
                    text = extractReadFilePath(rawPart.input)
                } else {
                    label = "glob"
                    text = extractGlobPattern(rawPart.input)
                }
                pendingPatches.push({
                    path: `/session/${sessionID}/message/${msgID}/part/${rawPart.partID}`,
                    body: {
                        id: rawPart.partID,
                        sessionID,
                        messageID: msgID,
                        type: "text",
                        text: `${label} ${text}`,
                        synthetic: false,
                        ignored: false,
                        metadata: { compressed: true },
                    },
                })
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

            // Queue the PATCH (will apply in batch after all parts processed)
            pendingPatches.push({
                path: `/session/${sessionID}/message/${msgID}/part/${rawPart.partID}`,
                body: {
                    id: rawPart.partID,
                    sessionID,
                    messageID: msgID,
                    type: "text",
                    text: summary.trim(),
                    synthetic: false,
                    ignored: false,
                    metadata: { compressed: true },
                },
            })
            compressedCount++
        }

        // Flush all queued patches atomically — single cache invalidation
        for (const p of pendingPatches) {
            await clientPATCH(cl, directory, p.path, p.body)
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

        for (const part of msg.parts) {
            if (part.type === "step-start" || part.type === "step-finish") continue
            if (isAlreadyHandled(part)) continue

            // Whitelist: only these part types enter the compression pipeline.
            // Everything else (user messages, reasoning, synthetic, error tools, etc.) is left as-is.
            const partTool = part.tool as string | undefined
            const isDirectReplace = part.type === "tool" && (partTool === "read" || partTool === "glob")
            const isSynthetic = (part as any).synthetic === true
            const partState = (part.state as Record<string, unknown>) ?? {}
            const isError = partState.status === "error"

            const allow = isDirectReplace
                || (msg.info.role === "assistant" && part.type === "text" && !isSynthetic)
                || (msg.info.role === "assistant" && part.type === "tool" && !isError && partTool !== "edit")

            if (!allow) continue

            const item: RawPart = {
                partID: part.id as string,
                messageID: msg.info.id,
                role: msg.info.role,
                type: part.type as string,
            }

            if (part.type === "text") {
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
    const userConfig: CompressorPluginConfig = {
        ...(options as CompressorPluginConfig | undefined),
    }

    // Detected from model at runtime via chat.params hook
    let detectedContextWindow = 0
    let configLogged = false

    /** Resolve effective config: user override → model-based → fallback. */
    function resolveConfig(): { window: number; multiple: number } {
        const hasWindow = userConfig.agentContextWindow != null
        const hasMultiple = userConfig.compressTriggerMultiple != null

        if (hasWindow || hasMultiple) {
            return {
                window: Math.max(hasWindow ? userConfig.agentContextWindow! : FALLBACK_DEFAULTS.agentContextWindow, 1024),
                multiple: Math.max(hasMultiple ? userConfig.compressTriggerMultiple! : FALLBACK_DEFAULTS.compressTriggerMultiple, 1.5),
            }
        }

        if (detectedContextWindow > 0) {
            const optimal = calculateOptimalDefaults(detectedContextWindow)
            return {
                window: Math.max(optimal.agentContextWindow, 1024),
                multiple: Math.max(optimal.compressTriggerMultiple, 1.5),
            }
        }

        return {
            window: Math.max(FALLBACK_DEFAULTS.agentContextWindow, 1024),
            multiple: Math.max(FALLBACK_DEFAULTS.compressTriggerMultiple, 1.5),
        }
    }

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

        // Detect model context window from the LLM route
        "chat.params": async (input) => {
            const ctxLimit = input.model?.limit?.context
            if (typeof ctxLimit === "number" && ctxLimit > 0 && ctxLimit !== detectedContextWindow) {
                detectedContextWindow = ctxLimit
                if (!configLogged) {
                    const c = resolveConfig()
                    console.log(`[Compressor] Detected context window ${ctxLimit}, using window=${c.window}, trigger=${c.multiple}`)
                    configLogged = true
                }
            }
        },

        "chat.message": async (input) => {
            if (!input.sessionID || !input.messageID) return

            // Concurrency guard: only one async compression per session
            if (compressingSessions.has(input.sessionID)) return

            const c = resolveConfig()

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
            const threshold = Math.floor(c.window * c.multiple)
            if (totalRawTokens <= threshold) return

            // Cooldown: skip if we just compressed
            if (messages.length - lastCompressedMsgCount < COMPRESS_COOLDOWN) return

            // Determine how many of the most recent messages to protect
            const protectedCount = computeProtectedCount(messages, c.window, MESSAGE_FLOOR)
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
