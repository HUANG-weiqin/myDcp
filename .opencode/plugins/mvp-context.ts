import type { Plugin } from "@opencode-ai/plugin"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const COMMAND = "mvp-prune-tools"

interface PruneResult {
    prunedCount: number
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

export const MvpContextPlugin: Plugin = async () => {
    return {
        config: async (config) => {
            config.command ??= {}
            config.command[COMMAND] = {
                template: "",
                description: "MVP: destructively replace current-session tool parts with text",
            }
        },

        "command.execute.before": async (input, output) => {
            if (input.command !== COMMAND) {
                return
            }

            const dbPath = defaultDatabasePath()
            const result = pruneToolPartsInDatabase(dbPath, input.sessionID)

            output.parts.length = 0
            output.parts.push({
                type: "text",
                text: `MVP context plugin pruned ${result.prunedCount} tool part(s) for session: ${input.sessionID}. Database: ${dbPath}`,
            })
        },
    }
}
