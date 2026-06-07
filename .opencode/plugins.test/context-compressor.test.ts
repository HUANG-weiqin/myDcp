import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ContextCompressorPlugin } from "../plugins/context-compressor"
import * as ContextCompressorModule from "../plugins/context-compressor"

/** Build a minimal plugin input, partially typed so tests compile. */
function mockPluginInput(overrides?: Record<string, unknown>) {
    return {
        client: {} as any,
        project: { name: "test-project" },
        directory: "E:\\myDcp",
        worktree: "E:\\myDcp",
        serverUrl: new URL("http://localhost:4096"),
        experimental_workspace: { register: () => {} },
        $: {} as any,
        ...overrides,
    } as any
}

// ---------------------------------------------------------------------------
// Track calls on the raw _client (PATCH / DELETE go through it).
// ---------------------------------------------------------------------------

interface RawClientCall {
    method: string
    url: string
    body?: unknown
}

function mockRawClient(withSession?: Record<string, any>) {
    const calls: RawClientCall[] = []

    const record = (method: string, detail?: any) => calls.push({ method, url: detail ? JSON.stringify(detail) : "" })

    const sessionMethods: Record<string, any> = {
        messages: async (options: any) => {
            record("session.messages", options)
            return { data: withSession?.messages ?? [] }
        },
        create: withSession?.create ?? (async (options: any) => {
            record("session.create", options)
            return { data: { id: "ses_compresser" } }
        }),
        prompt: withSession?.prompt ?? (async (options: any) => {
            record("session.prompt", options)
            return {
                data: {
                    parts: [{ type: "text", text: "## Current Objective\n- Test.\n\n## Next Action\n- Done." }],
                },
            }
        }),
        delete: withSession?.delete ?? (async (options: any) => {
            record("session.delete", options)
            return { data: undefined }
        }),
    }

    const rawClient = {
        patch: async (options: { url: string; headers?: any; body?: unknown }) => {
            calls.push({ method: "PATCH", url: options.url, body: options.body })
            return {}
        },
        delete: async (options: { url: string }) => {
            calls.push({ method: "DELETE", url: options.url })
            return {}
        },
    }

    return {
        client: {
            _client: rawClient,
            session: sessionMethods,
        },
        calls,
    }
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_MESSAGES = [
    {
        info: { id: "msg_1", sessionID: "ses_test", role: "user" },
        parts: [
            { id: "prt_user_1", sessionID: "ses_test", messageID: "msg_1", type: "text", text: "User says hi" },
        ],
    },
    {
        info: { id: "msg_2", sessionID: "ses_test", role: "assistant" },
        parts: [
            { id: "prt_reason", sessionID: "ses_test", messageID: "msg_2", type: "reasoning", text: "Let me think" },
            {
                id: "prt_tool_1",
                sessionID: "ses_test",
                messageID: "msg_2",
                type: "tool",
                tool: "read",
                callID: "call_1",
                state: { status: "completed", input: { filePath: "a.ts" }, output: "large output" },
            },
            {
                id: "prt_tool_2",
                sessionID: "ses_test",
                messageID: "msg_2",
                type: "tool",
                tool: "grep",
                callID: "call_2",
                state: { status: "completed", input: { pattern: "foo" }, output: "matches" },
            },
        ],
    },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContextCompressorPlugin", () => {
    it("does not import bun-only modules because OpenCode plugin loader rejects bun: URLs", () => {
        expect(
            readFileSync(join(import.meta.dir, "..", "plugins", "context-compressor.ts"), "utf8"),
        ).not.toContain("bun:sqlite")
    })

    it("exports only plugin entrypoints so OpenCode legacy loader accepts the module", () => {
        expect(Object.keys(ContextCompressorModule)).toEqual(["ContextCompressorPlugin"])
    })

    it("registers the compressor commands", async () => {
        const hooks = await ContextCompressorPlugin(mockPluginInput())
        const config: any = {}

        await hooks.config?.(config)

        expect(config.command?.["compress-prune"]).toEqual({
            template: "",
            description: "Compressor: destructively replace current-session tool parts with text",
        })
        expect(config.command?.["compress-all"]).toEqual({
            template: "",
            description: "Compressor: compress current-session raw parts with the Compresser agent",
        })
    })

    it("responds when compress-prune is invoked", async () => {
        const { client, calls } = mockRawClient({ messages: SAMPLE_MESSAGES })

        const hooks = await ContextCompressorPlugin(mockPluginInput({ client }))
        const output = { parts: [] as any[] }

        await hooks["command.execute.before"]?.(
            { command: "compress-prune", sessionID: "ses_test", arguments: "" },
            output,
        )

        expect(output.parts).toHaveLength(1)
        expect(output.parts[0].text).toMatch(/pruned 2 tool part/)

        const deletes = calls.filter((c) => c.method === "DELETE")
        expect(deletes).toHaveLength(2)
        expect(deletes[0].url).toContain("prt_tool_1")
        expect(deletes[1].url).toContain("prt_tool_2")
    })

    it("ignores unrelated commands", async () => {
        const hooks = await ContextCompressorPlugin(mockPluginInput())
        const output = { parts: [{ type: "text", text: "unchanged" }] }

        await hooks["command.execute.before"]?.(
            { command: "other-command", sessionID: "ses_test", arguments: "" },
            output,
        )

        expect(output.parts).toEqual([{ type: "text", text: "unchanged" }])
    })

    it("deletes tool parts when pruning a session", async () => {
        const { client, calls } = mockRawClient({ messages: SAMPLE_MESSAGES })

        const hooks = await ContextCompressorPlugin(mockPluginInput({ client }))
        await hooks["command.execute.before"]?.(
            { command: "compress-prune", sessionID: "ses_test", arguments: "" },
            { parts: [] as any[] },
        )

        // 1 messages call + 2 DELETE calls
        expect(calls.filter((c) => c.method === "session.messages")).toHaveLength(1)
        const deletes = calls.filter((c) => c.method === "DELETE")
        expect(deletes).toHaveLength(2)

        expect(deletes[0].method).toBe("DELETE")
        expect(deletes[0].url).toContain("/prt_tool_1")

        expect(deletes[1].method).toBe("DELETE")
        expect(deletes[1].url).toContain("/prt_tool_2")
    })

    it("compresses raw current-session parts with Compresser and deletes consumed parts", async () => {
        const compressMessages = [
            {
                info: { id: "msg_user", sessionID: "ses_test", role: "user" },
                parts: [
                    { id: "prt_user", sessionID: "ses_test", messageID: "msg_user", type: "text", text: "User wants destructive compression. 👋" },
                ],
            },
            {
                info: { id: "msg_assistant", sessionID: "ses_test", role: "assistant" },
                parts: [
                    {
                        id: "prt_reasoning",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "reasoning",
                        text: "Direct DB modification works because OpenCode reloads SQLite each loop.",
                    },
                    {
                        id: "prt_tool",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "tool",
                        tool: "read",
                        callID: "call_1",
                        state: { status: "completed", input: { filePath: "a.ts" }, output: "large output" },
                    },
                    {
                        id: "prt_existing_summary",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "text",
                        text: "<<<MVP_COMPRESSED_CONTEXT v1>>>\nold summary\n<<<END_MVP_COMPRESSED_CONTEXT>>>",
                    },
                ],
            },
        ]

        const { client, calls } = mockRawClient({ messages: compressMessages })

        const hooks = await ContextCompressorPlugin(mockPluginInput({ client }))
        const output = { parts: [] as any[] }
        await hooks["command.execute.before"]?.(
            { command: "compress-all", sessionID: "ses_test", arguments: "" },
            output,
        )

        // Verify prompt was built correctly
        const promptCall = calls.find((c) => c.method === "session.prompt")
        expect(promptCall).toBeDefined()

        // Verify create → prompt → delete sequence
        const sessionCalls = calls.filter((c) => c.method.startsWith("session."))
        expect(sessionCalls.map((c) => c.method)).toEqual(["session.messages", "session.create", "session.prompt", "session.delete"])

        // Verify the output message
        expect(output.parts[0].text).toContain("compressed 3 raw part(s), deleted 0 empty message(s)")

        // Verify: 1 PATCH (anchor) + 2 DELETE (remaining parts)
        const patches = calls.filter((c) => c.method === "PATCH")
        const deletes = calls.filter((c) => c.method === "DELETE")

        expect(patches).toHaveLength(1)
        expect(deletes).toHaveLength(2)

        // Anchor part gets the summary with dedicated type (no ugly markers)
        const anchorPatch = patches[0]!
        expect(anchorPatch.url).toContain("prt_user")
        expect((anchorPatch.body as any).type).toBe("compressed")
        expect((anchorPatch.body as any).text).not.toContain("<<<MVP_COMPRESSED_CONTEXT")
        expect((anchorPatch.body as any).text).toContain("## Current Objective")

        // Remaining parts are deleted
        expect(deletes.some((d) => d.url.includes("prt_reasoning"))).toBe(true)
        expect(deletes.some((d) => d.url.includes("prt_tool"))).toBe(true)
        // No message-level deletes — msg_assistant still has prt_existing_summary
        expect(deletes.every((d) => d.url.includes("/part/"))).toBe(true)
    })

    it("deletes empty messages after compression", async () => {
        // msg_assistant has only the two parts being compressed — no leftovers
        const compressMessages = [
            {
                info: { id: "msg_user", sessionID: "ses_test", role: "user" },
                parts: [
                    { id: "prt_user", sessionID: "ses_test", messageID: "msg_user", type: "text", text: "Goal: test" },
                ],
            },
            {
                info: { id: "msg_assistant", sessionID: "ses_test", role: "assistant" },
                parts: [
                    {
                        id: "prt_reasoning",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "reasoning",
                        text: "some reasoning",
                    },
                    {
                        id: "prt_tool",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "tool",
                        tool: "bash",
                        callID: "call_1",
                        state: { status: "completed", input: { command: "pwd" }, output: "/home" },
                    },
                ],
            },
        ]

        const { client, calls } = mockRawClient({ messages: compressMessages })

        const hooks = await ContextCompressorPlugin(mockPluginInput({ client }))
        const output = { parts: [] as any[] }
        await hooks["command.execute.before"]?.(
            { command: "compress-all", sessionID: "ses_test", arguments: "" },
            output,
        )

        expect(output.parts[0].text).toContain("compressed 3 raw part(s), deleted 1 empty message(s)")

        // 1 PATCH (anchor) + 2 DELETE (parts) + 1 DELETE (empty message)
        const patches = calls.filter((c) => c.method === "PATCH")
        const deletes = calls.filter((c) => c.method === "DELETE")

        expect(patches).toHaveLength(1)
        expect(deletes).toHaveLength(3)

        const partDeletes = deletes.filter((d) => d.url.includes("/part/"))
        const msgDeletes = deletes.filter((d) => !d.url.includes("/part/"))

        expect(partDeletes).toHaveLength(2)
        expect(msgDeletes).toHaveLength(1)
        expect(msgDeletes[0].url).toContain("/message/msg_assistant")
    })

    // -----------------------------------------------------------------------
    // chat.message hook (auto-trigger)
    // -----------------------------------------------------------------------

    it("registers a chat.message hook", async () => {
        const hooks = await ContextCompressorPlugin(mockPluginInput())
        expect(hooks["chat.message"]).toBeDefined()
    })

    it("does not auto-compress when total tokens are below threshold", async () => {
        const { client, calls } = mockRawClient({ messages: SAMPLE_MESSAGES })

        const hooks = await ContextCompressorPlugin(mockPluginInput({ client }))

        // chat.message fires with no sessionID → should early-return
        await hooks["chat.message"]?.({} as any, {} as any)
        expect(calls.filter((c) => c.method === "PATCH" || c.method === "DELETE")).toHaveLength(0)

        // chat.message fires with sessionID but tokens below threshold → should NOT compress
        await hooks["chat.message"]?.(
            { sessionID: "ses_test", messageID: "msg_new" } as any,
            { message: { role: "user" } } as any,
        )
        const patches = calls.filter((c) => c.method === "PATCH")
        const deletes = calls.filter((c) => c.method === "DELETE")
        // SAMPLE_MESSAGES has ~50 tokens total, far below 8192*2=16384 threshold
        expect(patches).toHaveLength(0)
        expect(deletes).toHaveLength(0)
    })

    it("auto-compresses oldest messages when tokens exceed threshold", async () => {
        // Build 12 messages, each with ~1750 tokens of text → total ~21000 tokens > 16384
        const MANY_MESSAGES = Array.from({ length: 12 }, (_, i) => ({
            info: { id: `msg_${i}`, sessionID: "ses_test", role: i % 2 === 0 ? "user" : "assistant" },
            parts: [
                {
                    id: `prt_${i}`,
                    sessionID: "ses_test",
                    messageID: `msg_${i}`,
                    type: "text",
                    text: "A".repeat(7000),
                },
            ],
        }))

        const { client, calls } = mockRawClient({ messages: MANY_MESSAGES })

        // Use small window + multiple so 12 msgs × 1750 tok = 21000 > 8192 × 2 = 16384
        const hooks = await ContextCompressorPlugin(
            mockPluginInput({ client }),
            { agentContextWindow: 8192, compressTriggerMultiple: 2.0 } as any,
        )

        // Hook fires async — compression runs in background
        await hooks["chat.message"]?.(
            { sessionID: "ses_test", messageID: "msg_new" } as any,
            { message: { role: "user" } } as any,
        )

        // Wait for async compression to complete
        await new Promise((r) => setTimeout(r, 0))

        // Should have triggered compression
        // 12 msgs, protected ≈ 5 (msg_7..msg_11), compressible ≈ 7 (msg_0..msg_6)
        // → 1 PATCH (anchor prt_0) + 6 part DELETE + 7 msg DELETE (empty after single part removed)
        const patches = calls.filter((c) => c.method === "PATCH")
        const deletes = calls.filter((c) => c.method === "DELETE")

        expect(patches.length).toBeGreaterThanOrEqual(1)
        expect(
            deletes.filter((d) => d.url.includes("/part/")).length,
        ).toBeGreaterThanOrEqual(6)
    })

    it("skips auto-compress when compression is already in progress for the same session", async () => {
        const MANY_MESSAGES = Array.from({ length: 12 }, (_, i) => ({
            info: { id: `msg_${i}`, sessionID: "ses_test", role: i % 2 === 0 ? "user" : "assistant" },
            parts: [
                {
                    id: `prt_${i}`,
                    sessionID: "ses_test",
                    messageID: `msg_${i}`,
                    type: "text",
                    text: "A".repeat(7000),
                },
            ],
        }))

        const { client, calls } = mockRawClient({ messages: MANY_MESSAGES })

        // Use small window + multiple so compression fires and tests concurrency lock
        const hooks = await ContextCompressorPlugin(
            mockPluginInput({ client }),
            { agentContextWindow: 8192, compressTriggerMultiple: 2.0 } as any,
        )

        // First call fires compression (async)
        await hooks["chat.message"]?.(
            { sessionID: "ses_test", messageID: "msg_new" } as any,
            { message: { role: "user" } } as any,
        )

        // Second call should be skipped (compression in progress)
        const callCountBefore = calls.length
        await hooks["chat.message"]?.(
            { sessionID: "ses_test", messageID: "msg_new2" } as any,
            { message: { role: "user" } } as any,
        )

        // No additional session.create calls (second hook was skipped)
        const createCalls = calls.filter((c) => c.method === "session.create")
        expect(createCalls).toHaveLength(1)

        // Wait for first compression to finish before test cleanup
        await new Promise((r) => setTimeout(r, 0))
    })
})
