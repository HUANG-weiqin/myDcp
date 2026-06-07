# MVP Context Plugin Design

## Goal

Build a project-level OpenCode plugin that can be loaded and invoked with a command, then destructively rewrite current-session tool parts in OpenCode's SQLite history.

## Design

- Location: `E:\myDcp\.opencode\plugins\mvp-context.ts`
- Command: `/mvp-prune-tools`
- Current MVP behavior: destructively replace current-session tool parts in `part.data` with text placeholder parts.

## Runtime Model

OpenCode loads project plugins from `.opencode/plugins/`. The plugin registers a command in the `config` hook. When the user invokes `/mvp-prune-tools`, OpenCode calls `command.execute.before`, where the plugin opens `opencode.db`, rewrites current-session rows in the `part` table, and returns a confirmation message.

## Testing

Use Bun's test runner to call the plugin factory directly and verify:

1. The plugin registers `mvp-prune-tools` in config.
2. The command rewrites current-session tool parts and returns a confirmation message.
3. Unrelated commands are ignored.
4. Non-tool parts and other-session tool parts are not changed.
