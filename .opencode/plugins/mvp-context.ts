import type { Plugin } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

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

function defaultDatabasePath(): string {
    return (
        process.env.OPENCODE_MVP_DB_PATH ||
        join(homedir(), ".local", "share", "opencode", "opencode.db")
    )
}

function pruneToolPartsInDatabase(dbPath: string, sessionID: string): PruneResult {
    const result = spawnSync(
        "python",
        [
            "-c",
            `import json, sqlite3, sys, time
db_path = sys.argv[1]
session_id = sys.argv[2]
con = sqlite3.connect(db_path, timeout=5)
try:
    rows = con.execute("SELECT id, data FROM part WHERE session_id = ?", (session_id,)).fetchall()
    pruned = 0
    for part_id, raw_data in rows:
        data = json.loads(raw_data)
        if data.get("type") != "tool":
            continue
        replacement = {
            "type": "text",
            "text": "[MVP pruned tool call: {} callID={} status={}]".format(
                data.get("tool", "unknown"),
                data.get("callID", "unknown"),
                data.get("state", {}).get("status", "unknown"),
            ),
        }
        con.execute(
            "UPDATE part SET data = ?, time_updated = ? WHERE id = ?",
            (json.dumps(replacement, separators=(",", ":")), int(time.time() * 1000), part_id),
        )
        pruned += 1
    con.commit()
    print(json.dumps({"prunedCount": pruned}))
finally:
    con.close()
`,
            dbPath,
            sessionID,
        ],
        { encoding: "utf8" },
    )

    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || "failed to prune tool parts")
    }

    return JSON.parse(result.stdout) as PruneResult
}

function collectRawPartsForCompression(dbPath: string, sessionID: string): RawPart[] {
    const result = spawnSync(
        "python",
        [
            "-c",
            `import json, sqlite3, sys
db_path = sys.argv[1]
session_id = sys.argv[2]
con = sqlite3.connect(db_path, timeout=5)
try:
    rows = con.execute("""
        SELECT p.id, p.message_id, p.data, m.data
        FROM part p
        LEFT JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ?
        ORDER BY m.time_created, CASE json_extract(m.data, '$.role') WHEN 'user' THEN 0 ELSE 1 END, p.time_created, p.id
    """, (session_id,)).fetchall()
    parts = []
    for part_id, message_id, raw_part, raw_message in rows:
        part = json.loads(raw_part)
        text = part.get("text", "") if isinstance(part.get("text"), str) else ""
        if part.get("type") == "text" and (
            "<<<MVP_COMPRESSED_CONTEXT" in text
            or text.startswith("[MVP compressed into")
            or text.startswith("[MVP pruned tool call:")
        ):
            continue
        if part.get("type") in ("step-start", "step-finish"):
            continue
        role = "unknown"
        if raw_message:
            try:
                role = json.loads(raw_message).get("role", "unknown")
            except Exception:
                role = "unknown"
        item = {
            "partID": part_id,
            "messageID": message_id,
            "role": role,
            "type": part.get("type", "unknown"),
        }
        if part.get("type") in ("text", "reasoning"):
            item["text"] = text
        if part.get("type") == "tool":
            state = part.get("state", {}) if isinstance(part.get("state"), dict) else {}
            item.update({
                "tool": part.get("tool", "unknown"),
                "callID": part.get("callID", "unknown"),
                "status": state.get("status", "unknown"),
                "input": state.get("input"),
                "output": state.get("output", ""),
            })
        parts.append(item)
    print(json.dumps(parts))
finally:
    con.close()
`,
            dbPath,
            sessionID,
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 100 },
    )

    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || "failed to collect raw parts")
    }

    return JSON.parse(result.stdout) as RawPart[]
}

function writeCompressionSummaryToDatabase(dbPath: string, sessionID: string, partIDs: string[], summary: string) {
    const result = spawnSync(
        "python",
        [
            "-c",
            `import json, sqlite3, sys, time
db_path = sys.argv[1]
session_id = sys.argv[2]
part_ids = json.loads(sys.argv[3])
summary = sys.argv[4]
anchor = part_ids[0]
wrapped = "<<<MVP_COMPRESSED_CONTEXT v1\\nsource_parts={}\\nmode=task-continuity\\n>>>\\n{}\\n<<<END_MVP_COMPRESSED_CONTEXT>>>".format(len(part_ids), summary.strip())
con = sqlite3.connect(db_path, timeout=5)
try:
    now = int(time.time() * 1000)
    con.execute(
        "UPDATE part SET data = ?, time_updated = ? WHERE id = ? AND session_id = ?",
        (json.dumps({"type": "text", "text": wrapped}, separators=(",", ":"), ensure_ascii=False), now, anchor, session_id),
    )
    for part_id in part_ids[1:]:
        con.execute(
            "UPDATE part SET data = ?, time_updated = ? WHERE id = ? AND session_id = ?",
            (json.dumps({"type": "text", "text": "[MVP compressed into {}]".format(anchor)}, separators=(",", ":"), ensure_ascii=False), now, part_id, session_id),
        )
    con.commit()
    print(json.dumps({"compressedCount": len(part_ids), "anchorPartID": anchor}))
finally:
    con.close()
`,
            dbPath,
            sessionID,
            JSON.stringify(partIDs),
            summary,
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024 * 100 },
    )

    if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || "failed to write compression summary")
    }

    return JSON.parse(result.stdout) as { compressedCount: number; anchorPartID: string }
}

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
                const dbPath = defaultDatabasePath()
                const result = pruneToolPartsInDatabase(dbPath, input.sessionID)

                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: `MVP context plugin pruned ${result.prunedCount} tool part(s) for session: ${input.sessionID}. Database: ${dbPath}`,
                })
                return
            }

            if (input.command !== COMPRESS_COMMAND) {
                return
            }

            const dbPath = defaultDatabasePath()
            const rawParts = collectRawPartsForCompression(dbPath, input.sessionID)
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
                const result = writeCompressionSummaryToDatabase(
                    dbPath,
                    input.sessionID,
                    rawParts.map((part) => part.partID),
                    summary,
                )

                output.parts.length = 0
                output.parts.push({
                    type: "text",
                    text: `MVP context plugin compressed ${result.compressedCount} raw part(s) for session: ${input.sessionID}. Anchor: ${result.anchorPartID}. Database: ${dbPath}`,
                })
            } finally {
                await ctx.client.session.delete({ path: { id: tempSessionID } })
            }
        },
    }
}
