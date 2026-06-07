# MVP Compress All Design

## Goal

Add a manual `/mvp-compress-all` command that uses the configured `Compresser` subagent to compress the current session's raw history, then destructively writes a Markdown continuity summary back into OpenCode's SQLite message history.

## Runtime Flow

1. User invokes `/mvp-compress-all` in the current OpenCode session.
2. Plugin reads current-session `part` rows from `opencode.db` using Python `sqlite3`.
3. Plugin filters out already-processed parts:
   - `<<<MVP_COMPRESSED_CONTEXT ...>>>` summaries
   - `[MVP compressed into ...]` placeholders
   - `[MVP pruned tool call: ...]` placeholders
   - `step-start` / `step-finish` overhead markers
4. Plugin creates a temporary scratch session.
5. Plugin calls `client.session.prompt` in the scratch session with `agent: "Compresser"`.
6. Plugin takes the returned text summary and writes it back to the original session:
   - first raw part becomes a sentinel-marked Markdown summary
   - remaining raw parts become `[MVP compressed into <anchorPartID>]`
7. Plugin deletes the temporary scratch session.

## Summary Format

The stored summary remains a normal text part so OpenCode can read it safely:

```text
<<<MVP_COMPRESSED_CONTEXT v1
source_parts=N
mode=task-continuity
>>>
## Current Objective
...
<<<END_MVP_COMPRESSED_CONTEXT>>>
```

## Key Constraint

Already-compressed summaries are visible to the main agent but invisible to the compression input. The compression agent only sees raw uncompressed parts, preventing repeated summary-of-summary degradation.

## MVP Limitations

- Synchronous: command waits for `Compresser` to finish.
- No backup/restore yet.
- No automatic trigger yet.
- No chunking for extremely large sessions yet.
