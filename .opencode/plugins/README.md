# Context Compressor Plugin

自动压缩 OpenCode 会话历史，避免超出模型上下文窗口限制。

## 工作原理

### 动机

LLM 会话越长，token 消耗越大，超过模型上下文窗口后早期的内容会被丢弃。这个插件在后台自动压缩历史内容，保留关键信息的同时大幅减少 token 占用。

### 压缩策略

插件对会话中的每个部分（part）进行**有损压缩**，而非对整个消息做摘要。

| 部分类型 | 处理方式 |
|---------|---------|
| `tool: "read"` | 直接替换为 `read <文件路径>`，无需 LLM 调用 |
| `tool: "glob"` | 直接替换为 `glob <匹配模式>`，无需 LLM 调用 |
| `text`（assistant）| 发送到 Compresser agent 做摘要 |
| `reasoning`（assistant）| 发送到 Compresser agent 做摘要 |
| `tool`（非 read/glob/error/edit）| 发送到 Compresser agent 做摘要 |
| 其他类型（user 消息、step-start、error 等）| 跳过，保留原文 |

### 边界标记

压缩完成后，最后一条压缩摘要末尾会追加一条边界标记：

```
── Compression Boundary ──
Processed 34 part(s) (18 tools replaced directly), 497 too short skipped
2 part(s) summarized by Compresser agent. Original data preserved in message history.
```

这个标记天然位于压缩区和当前保护窗口之间，让 agent 知道之前的内容已经被摘要处理。

## 配置

在 `opencode.json` 的 Compresser agent 配置中设定使用的模型：

```json
"Compresser": {
  "description": "Per-part conversation summarizer for compressor plugin",
  "model": "zai-coding-plan/glm-5-turbo",
  "system": "..."
}
```

### 插件参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `agentContextWindow` | 根据模型自动计算 | 保护窗口大小（token），最近的消息会保留原始内容 |
| `compressTriggerMultiple` | `2.0` | 触发倍数，总 token > `window × multiple` 时执行压缩 |

示例：

```json
"plugin": [
  ["./.opencode/plugins/context-compressor.ts", {
    "agentContextWindow": 32000,
    "compressTriggerMultiple": 1.8
  }]
]
```

## 自动触发

插件通过 `chat.message` hook 监听每次新消息。当满足以下条件时自动触发后台压缩：

1. **总 token 超过阈值**：`totalRawTokens > window × multiple`
2. **冷却期已过**：距离上次压缩至少 5 条消息
3. **有可压缩的内容**：保护窗口之外存在未压缩部分

压缩在后台异步执行，不阻塞用户交互。

## 手动触发

在 OpenCode 中执行命令：

```
/compress-all
```

这会立即对当前会话执行一次完整压缩。

## 元数据管理

- 压缩后的部分标记 `metadata.compressed = true`
- `experimental.chat.messages.transform` hook 在消息发送给模型前清除这些元数据，避免干扰模型
- 旧的边界消息自动收缩为单行 `[Previous compression boundary]`，减少窗口浪费

## token 估算

- 优先使用 API 返回的精确 token 数据（assistant 消息的 `output + reasoning`）
- 无 API 数据时用字符长度估算：`~1 token / 4 chars`
- 小于 200 token 的部分跳过压缩（开销大于收益）
