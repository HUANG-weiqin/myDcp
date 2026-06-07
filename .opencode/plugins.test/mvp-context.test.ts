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

function mockPluginInputWithClient(client: unknown) {
    return {
        ...mockPluginInput(),
        client,
    } as any
}

function createTestDatabase() {
    const dir = mkdtempSync(join(tmpdir(), "mvp-context-"))
    tempDirs.push(dir)
    const dbPath = join(dir, "opencode.db")
    const db = new Database(dbPath)
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
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

function insertMessage(db: Database, id: string, sessionID: string, role: "user" | "assistant") {
    db.run(
        "INSERT INTO message VALUES (?, ?, ?, ?, ?)",
        id,
        sessionID,
        1,
        1,
        JSON.stringify({ role, time: { created: 1 } }),
    )
}

function insertPart(db: Database, id: string, messageID: string, sessionID: string, data: unknown) {
    db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", id, messageID, sessionID, 1, 1, JSON.stringify(data))
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

    it("registers the MVP context commands", async () => {
        const hooks = await MvpContextPlugin(mockPluginInput())
        const config: any = {}

        await hooks.config?.(config)

        expect(config.command?.["mvp-prune-tools"]).toEqual({
            template: "",
            description: "MVP: destructively replace current-session tool parts with text",
        })
        expect(config.command?.["mvp-compress-all"]).toEqual({
            template: "",
            description: "MVP: compress current-session raw parts with the Compresser agent",
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

    it("compresses raw current-session parts with Compresser and writes the summary back to SQLite", async () => {
        const { db, dbPath } = createTestDatabase()
        insertMessage(db, "msg_user", "ses_test", "user")
        insertMessage(db, "msg_assistant", "ses_test", "assistant")
        insertPart(db, "prt_user", "msg_user", "ses_test", { type: "text", text: "User wants destructive compression. 👋" })
        insertPart(db, "prt_reasoning", "msg_assistant", "ses_test", {
            type: "reasoning",
            text: "Direct DB modification works because OpenCode reloads SQLite each loop.",
        })
        insertPart(db, "prt_tool", "msg_assistant", "ses_test", {
            type: "tool",
            tool: "read",
            callID: "call_1",
            state: { status: "completed", input: { filePath: "a.ts" }, output: "large output" },
        })
        insertPart(db, "prt_existing_summary", "msg_assistant", "ses_test", {
            type: "text",
            text: "<<<MVP_COMPRESSED_CONTEXT v1>>>\nold summary\n<<<END_MVP_COMPRESSED_CONTEXT>>>",
        })
        insertPart(db, "prt_pruned_tool", "msg_assistant", "ses_test", {
            type: "text",
            text: "[MVP pruned tool call: bash callID=call_2 status=completed]",
        })
        db.close()
        process.env.OPENCODE_MVP_DB_PATH = dbPath

        const calls: Array<{ method: string; options: any }> = []
        const client = {
            session: {
                create: async (options: any) => {
                    calls.push({ method: "create", options })
                    return { data: { id: "ses_compresser" } }
                },
                prompt: async (options: any) => {
                    calls.push({ method: "prompt", options })
                    return {
                        data: {
                            parts: [
                                {
                                    type: "text",
                                    text: "## Current Objective\n- Preserve task continuity.\n\n## Next Action\n- Continue MVP.",
                                },
                            ],
                        },
                    }
                },
                delete: async (options: any) => {
                    calls.push({ method: "delete", options })
                    return { data: undefined }
                },
            },
        }

        const hooks = await MvpContextPlugin(mockPluginInputWithClient(client))
        const output = { parts: [] as any[] }
        await hooks["command.execute.before"]?.(
            { command: "mvp-compress-all", sessionID: "ses_test", arguments: "" },
            output,
        )

        const promptCall = calls.find((call) => call.method === "prompt")!
        expect(promptCall.options.path.id).toBe("ses_compresser")
        expect(promptCall.options.body.agent).toBe("Compresser")
        const promptText = promptCall.options.body.parts[0].text
        expect(promptText).toContain("User wants destructive compression. 👋")
        expect(promptText).toContain("Direct DB modification works")
        expect(promptText).toContain("read")
        expect(promptText).toContain("a.ts")
        expect(promptText).toContain("large output")
        expect(promptText).not.toContain("old summary")
        expect(promptText).not.toContain("MVP pruned tool call")

        expect(calls.map((call) => call.method)).toEqual(["create", "prompt", "delete"])
        expect(output.parts[0].text).toContain("MVP context plugin compressed 3 raw part(s)")

        const verifyDb = new Database(dbPath)
        const rows = verifyDb
            .query("SELECT id, data FROM part ORDER BY id")
            .all() as Array<{ id: string; data: string }>
        verifyDb.close()

        expect(JSON.parse(rows.find((row) => row.id === "prt_user")!.data).text).toContain(
            "<<<MVP_COMPRESSED_CONTEXT v1",
        )
        expect(JSON.parse(rows.find((row) => row.id === "prt_user")!.data).text).toContain(
            "## Current Objective",
        )
        expect(JSON.parse(rows.find((row) => row.id === "prt_reasoning")!.data)).toEqual({
            type: "text",
            text: "[MVP compressed into prt_user]",
        })
        expect(JSON.parse(rows.find((row) => row.id === "prt_tool")!.data)).toEqual({
            type: "text",
            text: "[MVP compressed into prt_user]",
        })
        expect(JSON.parse(rows.find((row) => row.id === "prt_existing_summary")!.data).text).toContain(
            "old summary",
        )
        expect(JSON.parse(rows.find((row) => row.id === "prt_pruned_tool")!.data).text).toContain(
            "MVP pruned tool call",
        )
    })
})
