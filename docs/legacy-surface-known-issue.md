# legacy 会话缺 message.id：已知现象与缓解（活文档）

适用：`@dsh-external/dsh-session-resume` 续跑遇到“lacks an identified message”报错。
本文件是**当前事实层**；不保留具体会话 id / seq / 时间戳（那些会漂移）。
只描述机制、为何发生、当前如何缓解。

## 现象

点击「自动续跑」可能报：

```
failed to read referenced session:
  session event at seq <n> lacks an identified message
```

这是官方 `session-reference` 读历史会话表面时，对一条无 `message.id` 的旧 `user/message` 事件校验失败。

## 根因

- 极旧版本 DSH 引擎写 notice 类 `user/message` 时用裸对象 `{role, source, content}`，没有 `id`。
  当前引擎走 `createUserMessage`（`createMessage`）必定带 `id`，所以**新写入不会再产生**此类数据。
- 持久层有迁移机制 `migrateLegacyMessageEvent` 会把历史无 id 消息补成
  `legacy-message:<sessionId>:<seq>`，所以**主流程读这些是正常的**。
- 但续跑用的 query 读路径（`sessionQuery` 的 surface 读）不套用该迁移，原始无 id 记录被
  `assertMessageEventShape` 拒绝，于是只“续跑时报错”。

> 一句话：读路径不一致——持久化主路会自动补 id，续跑用的 surface 读漏了这一步。会话本身不“坏”。

## 当前缓解（已落地，路径路由）

- 插件自身不依赖 `message.id`，续跑锚点是 `sessionId + seq`（快照目录、`capturedThroughSeq` 等）。
- 对 `legacySurface === true` 的源，续跑文本**优先走快照路径**，不生成 `dsh-session:` mention——
  mention 会重触发 fragile 的 surface 读并再次报「lacks an identified message」。
- 这是持久、免重装的根修，见 `docs/session-resume-architecture.md` §9 与
  `tests/legacy-surface.test.mjs` 覆盖。

## 诊断/复现工具（只读）

`docs/参考资料/tools/`：

- `dump-session.cjs <zstd路径> <输出jsonl?> <target seq>` —— 解码多帧 zstd 会话、打印指定 seq 事件。
- `validate-session.cjs <zstd路径>...` —— 扫描多个会话，列出缺 `message.id` 的 `user/message` 事件。

用法示例见各自文件头的注释。