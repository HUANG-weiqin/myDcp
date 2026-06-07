import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MvpContextPlugin } from "../plugins/mvp-context"
import * as MvpContextModule from "../plugins/mvp-context"

const tempDirs: string[] = []

afterEach(() => {
    delete process.env.OPENCODE_MVP_DB_PATH
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function mockPluginInput() {
    return {
        client: {},
        project: { name: "test-project" },
        directory: "E:\\myDcp",
        worktree: "E:\\myDcp",
        serverUrl: new URL("http://localhost:4096"),
        experimental_workspace: { register: () => {} },
        $: {},
    } as any
}

function createTestDatabase() {
    const dir = mkdtempSync(join(tmpdir(), "mvp-context-"))
    tempDirs.push(dir)
    const dbPath = join(dir, "opencode.db")
    const db = new Database(dbPath)
    db.exec(`
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        )
    `)
    return { db, dbPath }
}

describe("MvpContextPlugin", () => {
    it("does not import bun-only modules because OpenCode plugin loader rejects bun: URLs", () => {
        expect(readFileSync(join(import.meta.dir, "..", "plugins", "mvp-context.ts"), "utf8")).not.toContain(
            "bun:sqlite",
        )
    })

    it("exports only plugin entrypoints so OpenCode legacy loader accepts the module", () => {
        expect(Object.keys(MvpContextModule)).toEqual(["MvpContextPlugin"])
    })

    it("registers the mvp-prune-tools command", async () => {
        const hooks = await MvpContextPlugin(mockPluginInput())
        const config: any = {}

        await hooks.config?.(config)

        expect(config.command?.["mvp-prune-tools"]).toEqual({
            template: "",
            description: "MVP: destructively replace current-session tool parts with text",
        })
    })

    it("responds when mvp-prune-tools is invoked", async () => {
        const { db, dbPath } = createTestDatabase()
        db.run(
            "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
            "prt_tool",
            "msg_1",
            "ses_test",
            1,
            1,
            JSON.stringify({
                type: "tool",
                tool: "read",
                callID: "call_1",
                state: { status: "completed", input: { filePath: "a.ts" }, output: "large" },
            }),
        )
        db.close()
        process.env.OPENCODE_MVP_DB_PATH = dbPath

        const hooks = await MvpContextPlugin(mockPluginInput())
        const output = { parts: [] as any[] }

        await hooks["command.execute.before"]?.(
            { command: "mvp-prune-tools", sessionID: "ses_test", arguments: "" },
            output,
        )

        expect(output.parts).toHaveLength(1)
        expect(output.parts[0]).toEqual({
            type: "text",
            text: `MVP context plugin pruned 1 tool part(s) for session: ses_test. Database: ${dbPath}`,
        })
    })

    it("ignores unrelated commands", async () => {
        const hooks = await MvpContextPlugin(mockPluginInput())
        const output = { parts: [{ type: "text", text: "unchanged" }] }

        await hooks["command.execute.before"]?.(
            { command: "other-command", sessionID: "ses_test", arguments: "" },
            output,
        )

        expect(output.parts).toEqual([{ type: "text", text: "unchanged" }])
    })

    it("destructively replaces current-session tool parts with text parts in SQLite", async () => {
        const { db, dbPath } = createTestDatabase()
        db.run(
            "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
            "prt_tool",
            "msg_1",
            "ses_test",
            1,
            1,
            JSON.stringify({
                type: "tool",
                tool: "read",
                callID: "call_1",
                state: { status: "completed", input: { filePath: "a.ts" }, output: "large" },
            }),
        )
        db.run(
            "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
            "prt_text",
            "msg_1",
            "ses_test",
            1,
            1,
            JSON.stringify({ type: "text", text: "keep me" }),
        )
        db.run(
            "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
            "prt_other_session_tool",
            "msg_2",
            "ses_other",
            1,
            1,
            JSON.stringify({
                type: "tool",
                tool: "bash",
                callID: "call_2",
                state: { status: "completed", input: { command: "pwd" }, output: "large" },
            }),
        )
        db.close()

        process.env.OPENCODE_MVP_DB_PATH = dbPath
        const hooks = await MvpContextPlugin(mockPluginInput())
        await hooks["command.execute.before"]?.(
            { command: "mvp-prune-tools", sessionID: "ses_test", arguments: "" },
            { parts: [] as any[] },
        )

        const verifyDb = new Database(dbPath)
        const rows = verifyDb
            .query("SELECT id, data FROM part ORDER BY id")
            .all() as Array<{ id: string; data: string }>
        verifyDb.close()

        expect(JSON.parse(rows.find((row) => row.id === "prt_tool")!.data)).toEqual({
            type: "text",
            text: "[MVP pruned tool call: read callID=call_1 status=completed]",
        })
        expect(JSON.parse(rows.find((row) => row.id === "prt_text")!.data)).toEqual({
            type: "text",
            text: "keep me",
        })
        expect(JSON.parse(rows.find((row) => row.id === "prt_other_session_tool")!.data).type).toBe(
            "tool",
        )
    })
})
