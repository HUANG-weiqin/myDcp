import type { Plugin } from "@opencode-ai/plugin"

const PRUNE_COMMAND = "mvp-prune-tools"
const COMPRESS_COMMAND = "mvp-compress-all"
const COMPRESS_AGENT = "Compresser"

interface PruneResult {
    prunedCount: number
}

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

// ---------------------------------------------------------------------------
// Prune: delete all tool parts from a session
// ---------------------------------------------------------------------------

async function pruneToolParts(rc: any, directory: string, sessionID: string): Promise<PruneResult> {
    const messages = await rc.client.session.messages({
        path: { id: sessionID },
        query: { directory },
    }).then((r: any) => r?.data ?? r)

    const cl = rawClient(rc)
    let prunedCount = 0
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type !== "tool") continue

            await clientDELETE(cl, directory, `/session/${sessionID}/message/${msg.info.id}/part/${part.id}`)
            prunedCount++
        }
    }
    return { prunedCount }
}

// ---------------------------------------------------------------------------
// Collect raw parts for compression (skip already compressed / pruned ones)
// ---------------------------------------------------------------------------

function isAlreadyHandled(part: Record<string, unknown>): boolean {
    // Only the anchor summary text part remains after compression;
    // all other compressed/pruned parts are deleted from DB.
    return part.type === "text" && typeof part.text === "string" && (part.text as string).includes("<<<MVP_COMPRESSED_CONTEXT")
}

async function collectRawParts(
    rc: any,
    directory: string,
    sessionID: string,
): Promise<{ rawParts: RawPart[]; messages: Array<{ info: { id: string }; parts: Array<Record<string, unknown>> }> }> {
    const messages: Array<{ info: { id: string; role: string }; parts: Array<Record<string, unknown>> }> = await rc.client.session
        .messages({ path: { id: sessionID }, query: { directory } })
        .then((r: any) => r?.data ?? r)

    const rawParts: RawPart[] = []

    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type === "step-start" || part.type === "step-finish") continue
            if (isAlreadyHandled(part)) continue

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

    return { rawParts, messages }
}

// ---------------------------------------------------------------------------
// Write compression summary back via PATCH
// ---------------------------------------------------------------------------

async function writeCompressionSummary(
    rc: any,
    directory: string,
    sessionID: string,
    partIDs: string[],
    summary: string,
    messages: Array<{ info: { id: string }; parts: Array<Record<string, unknown>> }>,
): Promise<{ compressedCount: number; anchorPartID: string; deletedMessages: number }> {
    const cl = rawClient(rc)
    const anchor = partIDs[0]
    const consumedPartIDs = new Set(partIDs)

    // Build partID → messageID lookup + track which messages lose parts
    const partToMessage = new Map<string, string>()
    const affectedMessages = new Set<string>()
    for (const msg of messages) {
        for (const part of msg.parts) {
            partToMessage.set(part.id as string, msg.info.id)
            if (consumedPartIDs.has(part.id as string) && part.id !== anchor) {
                affectedMessages.add(msg.info.id)
            }
        }
    }

    const wrapped = `<<<MVP_COMPRESSED_CONTEXT v1\nsource_parts=${partIDs.length}\nmode=task-continuity\n>>>\n${summary.trim()}\n<<<END_MVP_COMPRESSED_CONTEXT>>>`

    // Update anchor part with the full summary
    const anchorMsgID = partToMessage.get(anchor)
    if (anchorMsgID) {
        affectedMessages.delete(anchorMsgID)
        await clientPATCH(cl, directory, `/session/${sessionID}/message/${anchorMsgID}/part/${anchor}`, {
            id: anchor,
            sessionID,
            messageID: anchorMsgID,
            type: "text",
            text: wrapped,
            synthetic: false,
            ignored: false,
        })
    }

    // Delete remaining parts (no longer needed — their content is in the summary)
    for (const partID of partIDs.slice(1)) {
        const msgID = partToMessage.get(partID)
        if (msgID) {
            await clientDELETE(cl, directory, `/session/${sessionID}/message/${msgID}/part/${partID}`)
        }
    }

    // Delete any message that ended up with zero meaningful parts
    let deletedMessages = 0
    for (const msgID of affectedMessages) {
        const msg = messages.find((m) => m.info.id === msgID)
        if (!msg) continue

        const untouched = msg.parts.filter((p) => !consumedPartIDs.has(p.id as string))
        // Also strip scaffolding parts (step-start/step-finish/snapshot) that serve no purpose alone
        const bareScaffolding =
            untouched.length > 0 &&
            untouched.every((p) => p.type === "step-start" || p.type === "step-finish" || p.type === "snapshot")
        if (untouched.length === 0 || bareScaffolding) {
            await clientDELETE(cl, directory, `/session/${sessionID}/message/${msgID}`)
            deletedMessages++
        }
    }

    return { compressedCount: partIDs.length, anchorPartID: anchor, deletedMessages }
}

// ---------------------------------------------------------------------------
// Prompt building (unchanged from original)
// ---------------------------------------------------------------------------

function buildCompressionPrompt(parts: RawPart[]): string {
    return [
        "Compress the following OpenCode session history for task continuity.",
        "Return ONLY a concise Markdown state table with these sections:",
        "## Current Objective",
        "## Hard Constraints",
        "## User Decisions",
        "## Completed Progress",
        "## Key Evidence",
        "## Known Pitfalls",
        "## Code / DB Changes",
        "## Verification",
        "## Open Questions",
        "## Next Action",
        "",
        "Rules:",
        "- Preserve user constraints above assistant suggestions.",
        "- Preserve verified progress, pitfalls, key evidence, and next action.",
        "- Drop fluff, repeated explanations, and unused tool output.",
        "- Do not include these instructions in the answer.",
        "",
        "Raw uncompressed parts:",
        ...parts.map(formatRawPart),
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

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export const MvpContextPlugin: Plugin = async (ctx) => {
    return {
        config: async (config) => {
            config.command ??= {}
            config.command[PRUNE_COMMAND] = {
                template: "",
                description: "MVP: destructively replace current-session tool parts with text",
            }
            config.command[COMPRESS_COMMAND] = {
                template: "",
                description: "MVP: compress current-session raw parts with the Compresser agent",
            }
        },

        "command.execute.before": async (input, output) => {
            if (input.command === PRUNE_COMMAND) {
                const result = await pruneToolParts(ctx, ctx.directory, input.sessionID)

                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: `MVP context plugin pruned ${result.prunedCount} tool part(s) for session: ${input.sessionID}.`,
                })
                return
            }

            if (input.command !== COMPRESS_COMMAND) {
                return
            }

            const { rawParts, messages } = await collectRawParts(ctx, ctx.directory, input.sessionID)
            if (rawParts.length === 0) {
                output.parts.length = 0
                output.parts.push({ type: "text", text: "MVP context plugin found no raw parts to compress." })
                return
            }

            const created = responseData(
                await ctx.client.session.create({
                    body: { title: `MVP compression scratch for ${input.sessionID}` },
                    query: { directory: ctx.directory },
                }),
            )
            const tempSessionID = created.id

            try {
                const summary = responseText(
                    await ctx.client.session.prompt({
                        path: { id: tempSessionID },
                        body: {
                            agent: COMPRESS_AGENT,
                            parts: [{ type: "text", text: buildCompressionPrompt(rawParts) }],
                        },
                        query: { directory: ctx.directory },
                    }),
                )
                const result = await writeCompressionSummary(
                    ctx,
                    ctx.directory,
                    input.sessionID,
                    rawParts.map((part) => part.partID),
                    summary,
                    messages,
                )

                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: `MVP context plugin compressed ${result.compressedCount} raw part(s), deleted ${result.deletedMessages} empty message(s) for session: ${input.sessionID}. Anchor: ${result.anchorPartID}.`,
                })
            } finally {
                await ctx.client.session.delete({ path: { id: tempSessionID } })
            }
        },
    }
}
