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
            const isBoundary = options?.body?.noReply === true
            return {
                data: {
                    info: isBoundary ? { id: "msg_boundary" } : undefined,
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
        info: { id: "msg_2", sessionID: "ses_test", role: "assistant", tokens: { output: 10, reasoning: 5 } },
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

        expect(config.command?.["compress-all"]).toEqual({
            template: "",
            description: "Compressor: compress current-session raw parts with the Compresser agent",
        })
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

    it("compresses each raw part individually with per-part summarization (no deletes)", async () => {
        // Each raw part is long enough (>80 chars) to trigger Compresser, except read tool which is direct
        const compressMessages = [
            {
                info: { id: "msg_user", sessionID: "ses_test", role: "user" },
                parts: [
                    { id: "prt_user", sessionID: "ses_test", messageID: "msg_user", type: "text", text: "The user wants to implement a high-fidelity compression mode that processes each message individually. ".repeat(3) },
                ],
            },
            {
                info: { id: "msg_assistant", sessionID: "ses_test", role: "assistant", tokens: { output: 20, reasoning: 10 } },
                parts: [
                    {
                        id: "prt_reasoning",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "reasoning",
                        text: "The AI assistant thinks about the best approach for implementing this feature. It considers several design options and trade-offs. ".repeat(3),
                    },
                    {
                        id: "prt_tool_read",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "tool",
                        tool: "read",
                        callID: "call_1",
                        state: { status: "completed", input: { filePath: "src/main.ts" }, output: "large file contents here" },
                    },
                    {
                        id: "prt_tool_bash",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "tool",
                        tool: "bash",
                        callID: "call_2",
                        state: { status: "completed", input: { command: "npm test" }, output: "Test results: 42 passed, 0 failed. All tests completed successfully. ".repeat(4) },
                    },
                    {
                        id: "prt_existing_summary",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "text",
                        text: "<<<MVP_COMPRESSED_CONTEXT v1>>>\nold summary\n<<<END_MVP_COMPRESSED_CONTEXT>>>",
                    },
                    {
                        id: "prt_metadata_compressed",
                        sessionID: "ses_test",
                        messageID: "msg_assistant",
                        type: "text",
                        text: "this is already compressed",
                        metadata: { compressed: true },
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

        // 4 raw parts: prt_user (text), prt_reasoning (reasoning), prt_tool_read, prt_tool_bash
        // prt_tool_read → direct replacement (0 session.prompt)
        // prt_user, prt_reasoning, prt_tool_bash → 1 Compresser call each
        // Boundary message → 1 session.prompt with noReply
        const sessionCalls = calls.filter((c) => c.method.startsWith("session."))
        expect(sessionCalls.map((c) => c.method)).toEqual([
            "session.messages", "session.create",
            "session.prompt", "session.prompt", "session.prompt",
            "session.prompt",  // boundary
            "session.delete",
        ])

        // All 4 raw parts were PATCHed (not DELETEd)
        const patches = calls.filter((c) => c.method === "PATCH")
        expect(patches).toHaveLength(4)

        // Read tool → direct "read {path}" replacement
        const readPatch = patches.find((p) => (p.body as any).text?.startsWith("read "))
        expect(readPatch).toBeDefined()
        expect((readPatch!.body as any).text).toBe("read src/main.ts")
        expect((readPatch!.body as any).metadata?.compressed).toBe(true)

        // Other parts have Compresser-generated summaries with metadata.compressed
        const compressPatches = patches.filter((p) => !(p.body as any).text?.startsWith("read "))
        expect(compressPatches).toHaveLength(3)
        for (const p of compressPatches) {
            expect((p.body as any).type).toBe("text")
            expect((p.body as any).synthetic).toBe(false)
            expect((p.body as any).metadata?.compressed).toBe(true)
        }

        // No DELETEs in the new mode
        expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0)

        // Output message
        expect(output.parts[0].text).toContain("processed 4 part(s)")
        expect(output.parts[0].text).toContain("1 read tools replaced directly")
    })

    it("skips short parts and creates boundary message", async () => {
        const compressMessages = [
            {
                info: { id: "msg_user", sessionID: "ses_test", role: "user" },
                parts: [
                    { id: "prt_short", sessionID: "ses_test", messageID: "msg_user", type: "text", text: "Hi" }, // < 80 chars → skip
                ],
            },
            {
                info: { id: "msg_assistant", sessionID: "ses_test", role: "assistant" },
                parts: [
                    {
                        id: "prt_long", sessionID: "ses_test", messageID: "msg_assistant", type: "text",
                        text: "X".repeat(200), // > 80 chars → Compresser
                    },
                    {
                        id: "prt_read", sessionID: "ses_test", messageID: "msg_assistant", type: "tool",
                        tool: "read", callID: "c1",
                        state: { status: "completed", input: { filePath: "f.ts" }, output: "content" },
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

        // prt_short (skip) + prt_long (Compresser) + prt_read (direct) = 2 processed, 1 skipped
        const patches = calls.filter((c) => c.method === "PATCH")
        expect(patches).toHaveLength(2) // prt_long + prt_read

        expect(output.parts[0].text).toContain("processed 2 part(s)")
        expect(output.parts[0].text).toContain("1 read tools replaced directly")
        expect(output.parts[0].text).toContain("1 too short skipped")

        // Verify boundary message was created with noReply
        const promptCalls = calls.filter((c) => c.method === "session.prompt")
        expect(promptCalls).toHaveLength(2) // 1 (prt_long) + 1 (boundary)

        const boundaryCall = promptCalls[1]
        expect(boundaryCall.url).toContain('"noReply":true')
        expect(boundaryCall.url).toContain('"compressionBoundary":true')

        // Output mentions boundary
        expect(output.parts[0].text).toContain("Boundary: msg_boundary")
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
        // SAMPLE_MESSAGES has actual+few tokens total, far below 8192*2=16384 threshold
        expect(patches).toHaveLength(0)
        expect(deletes).toHaveLength(0)
    })

    it("auto-compresses oldest messages when tokens exceed threshold", async () => {
        // Build 12 messages, each with ~1750 tokens of text → total ~21000 tokens > 16384
        // Assistant messages have actual token data to exercise the hybrid path
        const MANY_MESSAGES = Array.from({ length: 12 }, (_, i) => {
            const role = i % 2 === 0 ? "user" : "assistant"
            return {
                info: {
                    id: `msg_${i}`,
                    sessionID: "ses_test",
                    role,
                    ...(role === "assistant" ? { tokens: { output: 1500, reasoning: 500 } } : {}),
                },
                parts: [
                    {
                        id: `prt_${i}`,
                        sessionID: "ses_test",
                        messageID: `msg_${i}`,
                        type: "text",
                        text: "A".repeat(7000),
                    },
                ],
            }
        })

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

        // Should have triggered per-part compression
        // 12 msgs, protected ≈ 5 (msg_7..msg_11), compressible ≈ 7 (msg_0..msg_6)
        // Each compressible part → 1 PATCH (no DELETEs in high-fidelity mode)
        const patches = calls.filter((c) => c.method === "PATCH")
        const deletes = calls.filter((c) => c.method === "DELETE")

        expect(patches.length).toBeGreaterThanOrEqual(7)
        expect(deletes).toHaveLength(0)
    })

    it("skips auto-compress when compression is already in progress for the same session", async () => {
        const MANY_MESSAGES = Array.from({ length: 12 }, (_, i) => {
            const role = i % 2 === 0 ? "user" : "assistant"
            return {
                info: {
                    id: `msg_${i}`,
                    sessionID: "ses_test",
                    role,
                    ...(role === "assistant" ? { tokens: { output: 1500, reasoning: 500 } } : {}),
                },
                parts: [
                    {
                        id: `prt_${i}`,
                        sessionID: "ses_test",
                        messageID: `msg_${i}`,
                        type: "text",
                        text: "A".repeat(7000),
                    },
                ],
            }
        })

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
