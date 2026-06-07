# MVP Context Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a project-level OpenCode plugin that proves plugin loading, command invocation, and destructive current-session tool-part rewriting work.

**Architecture:** A single server plugin registers `/mvp-prune-tools` via the `config` hook and handles it via `command.execute.before`. The command invokes Python's standard `sqlite3` module in a subprocess, finds current-session rows in the `part` table whose JSON has `type: "tool"`, and replaces them with `type: "text"` placeholder parts.

**Tech Stack:** TypeScript, OpenCode plugin hooks, Bun test runner.

---

### Task 1: Plugin command registration and invocation

**Files:**
- Create: `.opencode/plugins.test/mvp-context.test.ts`
- Create: `.opencode/plugins/mvp-context.ts`

**Step 1: Write the failing test**

Test the plugin factory, config command registration, command response, and unrelated command ignore behavior.

**Step 2: Run test to verify it fails**

Run: `bun test .opencode/plugins.test/mvp-context.test.ts`

Expected: FAIL because `.opencode/plugins/mvp-context.ts` does not exist yet.

**Step 3: Write minimal implementation**

Create `.opencode/plugins/mvp-context.ts` exporting `MvpContextPlugin`.

**Step 4: Run test to verify it passes**

Run: `bun test .opencode/plugins.test/mvp-context.test.ts`

Expected: PASS.

### Task 2: Destructive SQLite tool-part pruning

**Files:**
- Modify: `.opencode/plugins/mvp-context.ts`
- Modify: `.opencode/plugins.test/mvp-context.test.ts`

**Step 1: Write the failing test**

Create a temp SQLite database with a `part` table. Insert one current-session tool part, one current-session text part, and one other-session tool part. Assert only the current-session tool part is converted to a text placeholder.

**Step 2: Run test to verify it fails**

Run: `bun test ./.opencode/plugins.test/mvp-context.test.ts`

Expected: FAIL because `pruneToolPartsInDatabase` is not exported or implemented.

**Step 3: Write minimal implementation**

Implement `pruneToolPartsInDatabase(dbPath, sessionID)` using `node:child_process` plus Python `sqlite3`. Query `part` rows for the session, parse JSON, update only `type: "tool"` rows, and return the prune count. Do not import `bun:sqlite` in the plugin because OpenCode's plugin loader rejects `bun:` URL imports.

**Step 4: Run test to verify it passes**

Run: `bun test ./.opencode/plugins.test/mvp-context.test.ts`

Expected: PASS.

**Step 5: Manual verification**

Restart OpenCode in `E:\myDcp`, then invoke `/mvp-prune-tools` in a session. Expected response includes the number of pruned tool parts and the database path.
