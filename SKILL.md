---
name: cross-session-messaging
description: 通过 cross-session-messaging 插件与其他 opencode session 协调。当你作为多个并行 opencode session 之一运行，需要向另一个 session 核实信息、委派任务或获取上下文时，**必须使用**此工具。触发词——"ask session X"、"check with the auth-refactor session"、"who is working on Y"、"coordinate with the other agent"、"register my task"、"advertise this session"。
---

# 跨会话消息传递

你有四个来自 `cross-session-messaging` 插件的工具，可以与运行在同一个 daemon 中的其他 opencode session 进行协调。

## 何时使用 `register_session`

在任务开始时**调用一次**，前提是你的目标已经足够具体、可以用文字描述。如果任务发生实质性变化，再次调用即可更新。

- 好的摘要："正在重构 `src/auth/oauth.ts` 中的 OAuth token 刷新逻辑，保持现有 `AuthProvider` 接口稳定"
- 差的摘要："在写代码" / "帮用户" / "收到"

其他 session 通过阅读摘要来决定是否向你提问。摘要太模糊则没人能找到你；过于详细则 registry 难以浏览。

## 何时使用 `list_sessions` + `ask_session`

当你遇到仅凭自身上下文无法推导的信息时，查询 registry——例如你没见过的模块规范、历史决策、与你工作重叠的进行中任务。

1. `list_sessions()` → 浏览各 session 的摘要。
2. 选择摘要与你需求最匹配的目标（如果没有匹配的则跳过）。
3. `ask_session(sessionId, question)` → 等待对方回复。

**不要**向所有 session 群发同一个问题；选一个摘要最匹配的目标即可。

## 如何撰写 `question`

**目标 session 看不到你的对话历史。** 凡是没写在 `question` 字符串里的内容，对方都不存在。每个问题必须**自包含**。

- 包含背景：你在哪个文件/模块/上下文中，想要达成什么目标。
- 将代码片段直接贴在问题中——不要说"这个函数"，而是把代码贴上来。
- 问具体的问题，而非笼统的问题——"方案 X 是否违反了你在 commit Z 中引入的不变量 Y"比"我该怎么做 X"好得多。

经验法则：如果一个零上下文的资深工程师拿到这个问题，能直接回答吗？如果不能，就补充更多信息。

## 超时与失败

`ask_session` 永远不会抛异常。每种失败都返回可读的文本：

- **目标 session 未找到** → 该 ID 已过期；重新运行 `list_sessions`。
- **目标持续繁忙，超出等待预算** → 稍后重试，或选择其他 session。
- **回复超时** → 目标收到了问题但未在规定时间内回答。考虑增大 `timeoutMs`（最大 10 分钟）或换一个目标。
- **中止（Abort）** → 用户取消了你的操作；传播该取消信号。
- **目标在等待过程中被删除** → 该 session 在你等待期间被关闭；选择其他目标。

**不要在超时后静默重试。** 先向用户报告失败——一个响应慢的 session 可能即将回复，重复提问会浪费对方的算力。

## 禁止事项

- 不要用 `ask_session` 问自己来做"自检"——你已经在思考了，这只会浪费一轮算力。
- 不要在未告知用户的情况下构建深层 `ask_session` 调用链（A 问 B、B 问 C）；延迟会叠加，双重超时场景很难排查。
- 不要将 `ask_session` 的回复视为权威——目标是另一个 AI，不是事实来源。对重要结论务必对照代码验证。

## Relay security (v1.0.1)

- `connect_relay` is policy-gated: the relay host must be in the operator's
  `allowedRelayHosts` config, and non-loopback relays must use `https`. A
  refused URL returns a refusal message with a remediation path. Do not
  retry the same refused URL, and do not attempt to widen the allowlist:
  no tool can change it.
- The relay token is operator-managed (`RELAY_TOKEN` env, or the 0600 token
  file in the state directory). It is never printed in tool output or logs;
  do not ask the user to paste it into a conversation.
- Relay activity events and the dashboard snapshot carry session ids, task
  summaries, directories, projectId, deviceName, client IPs, and timing.
  Only question text is preview-gated: it is not broadcast unless the relay
  operator explicitly enables previews (`--previews`).
