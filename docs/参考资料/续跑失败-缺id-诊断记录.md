# 续跑失败「lacks an identified message」诊断记录

## 1. 现象

在 DSH Web GUI（http://127.0.0.1:3080）的会话里点击「自动续跑」，抛错：

```
failed to read referenced session:
  session event at seq 105993 lacks an identified message
```

自动续跑是指本插件（`session-resume-plugin`）把目标会话作为“被引用会话”交给 DSH 官方
`session-reference` 服务读取其会话表面，读取到序号 105993 的消息时，校验失败。

## 2. 受影响会话（本次实证）

| 会话 id | 工作区 | 损坏 seq | 损坏事件 | 会话创建时间 |
|---|---|---|---|---|
| `session-aeb5f2bb-63ce-4591-8cbb-4ac95fdf6ad9` | `D:\AI\projects\StockHotRank` | 105993 | `user/message`（缺 message.id） | 2026-08-29 |
| `session-8380d285-30a4-4f25-a3e7-07a0e89ec8e2` | StockHotRank | 50861 | `user/message`（缺 message.id） | 同期 |

同一批采样 6 个 StockHotRank 会话，仅这两处缺号，其余会话无此问题（msg-events 全部带 id）。

## 3. 损坏事件的原样（证据）

`session-aeb5f2bb`，seq 105993 存储的原始 JSONL 行：

```json
{"type":"user/message","seq":105993,"time":1788068717916,
 "data":{"role":"user",
   "source":{"kind":"plugin","plugin":"tool-goal","form":"notice"},
   "content":[{"type":"text","text":"<goal_complete>"}]},
 "surfaceOp":"append"}
```

关键点：`data`（user message）只有 `role / source / content`，**没有 `id` 字段**。

对应的投递链路（同一会话相邻序号）：

- seq 105985 `assistant/message`：模型调用 `update_goal`（action=complete，goal `goal-eab24089…`）
- seq 105987 `goal/change`（operation=complete）
- seq 105989 `agent/inbox/spliced`（target=`next-step`，inserted 了与 105993 同一份**无 id** 的 notice 消息）
- seq 105993 `user/message`：该无 id notice 被投递到会话表面

`session-8380d285` 的第 50861 是同一模式（inbox splice 50857 → user/message 50861）。

## 4. 为什么 id 会丢（根因）

结论先行：**这两条旧消息是“老版本 DSH 引擎写好时就没给 id”产生的**，属于历史遗留数据；新版引擎已修好了新写入，但不会回补已存的旧记录，而「续跑读历史」那条路径又恰好不自动补号，于是读回时校验失败。

证据链：

1. 损坏消息的 content 仅为 `<goal_complete>`（极短，无任何收起说明）。
   而当前引擎 `dsh-tool-goal`（v0.1.1-rc.2）生成的是长文本
   `<goal_complete>\nObjective: …\n…（整段关闭说明）`——两者**形态不一致**。
2. 当前 `dsh-tool-goal` 写 notice 走的是 `exec.deferContext(createUserMessage({…}))`，
   `createUserMessage` 由 `@deepseek-ai/dsh-llm` 的 `createMessage` 实现，**必定**生成
   `id = MessageId(crypto.randomUUID())`。因此当前引擎不可能写出无 id 的新消息。
3. 在全部引擎源码里，只有 `dsh-tool-goal/lib/index.js` 含 `goal_complete` 字面值；
   旧版本引擎用裸对象 `{role, source, content}` 手写该消息（未调 `createUserMessage`），
   于是没有 id。
4. DSH 持久层专门准备了迁移机制收紧这类旧消息：
   `dsh-session-persistence/lib/index.js` 的
   `migrateLegacyMessageEvent` 会把历史无 id 的 `user/message` 补成
   `id = legacy-message:<sessionId>:<seq>`（见函数 `legacyMessageId`）。
   ——所以主流程读这些会话是正常的（读时自动补了号）。
5. 但是 `session-reference` 续跑读自定义用的是 `sessionQuery.readSurface`
   （`@deepseek-ai/dsh-session-query` 的 `currentSurfaceEvents`），它**直接**
   `snapshotSessionEvent(event)`，**没有**套用 `migrateLegacyMessageEvent`，
   于是原始无 id 记录被 `dsh-session` 的 `assertMessageEventShape` 拒绝，抛出
   `session event at seq 105993 lacks an identified message`。

一句话：**读路径不一致** —— persistence（读取持久化的主路）会自动为历史旧消息补 id，
而续跑用的 query 读路径漏掉了这一步，所以只在续跑时报错，会话本身并不“坏”。

## 5. 插件是否需要 id？用什么做锚点效果最好？

- 本插件（`session-resume-plugin`）**不依赖 message.id**。它的续跑定位用的是
  `sessionId + seq`（快照目录按 seq 命名、记录 `capturedThroughSeq` 等），与 id 无关。
- id 是 DSH 会话模型的硬性不变式（`assertMessageEventShape`/`createMessage`），用于
  消息去重、替换溯源、跨会话引用，是引擎内部校验用的，不是插件业务需要。
- 引擎补号时也是用 `seq` 派生：`legacy-message:<sessionId>:<seq>`。因此 **seq 是最稳的锚点**，
  即便缺少 id 也能据 seq 恢复到确定、幂等的 id。
- 结论：无需为规避 id 重写插件逻辑；真正的缺口在引擎读路径一致性。

## 6. 候选修复（未实施，仅参考）

按“效果最好 + 影响最小”排列：

1. **修改读路径一致性（推荐，最省）：**
   在 `@deepseek-ai/dsh-session-query` 的 `currentSurfaceEvents` / `readSurface` 读取序列中，
   与 `dsh-session-persistence` 一样套用 `migrateLegacyMessageEvent`，读出旧 id 消息时
   自动补 `legacy-message:<sessionId>:<seq>`。效果：不碰数据与插件，坏会话直接可续跑，
   以后遇到历史旧记录也能读到。注意：改的是安装版引擎 node_modules，重装 DSH 会被覆盖。

2. **纯插件回填（不碰引擎）：**
   在本插件内，续跑前扫描源会话原始存档（`persistence.readRaw`），对缺 id 的
   `user/message` 写回引擎同款 `legacy-message:<sessionId>:<seq>` 再放回。
   只改本项目、随项目走可持久；但每个新发现的坏存档都依赖该处理。

3. **一次性数据修复：**
   用脚本对上述两个会话（105993 / 50861）的存档补 id 后重新压缩，恢复续跑即止，不再改码。

（本诊断按用户决定，只记录，不改代码、不改数据。）

## 7. 复现与验证工具

`docs/参考资料/tools/` 下提供了两个只读诊断脚本：

- `dump-session.cjs <zstd路径> <输出jsonl?> <目标seq>` —— 解码多帧 zstd 会话，打印指定 seq 事件。
- `validate-session.cjs <zstd路径>...` —— 扫描多个会话，列出所有缺 message.id 的 `user/message` 事件。

用法示例：

```bash
node tools/dump-session.cjs \
  "<会话目录>/session.jsonl.zstd" out.jsonl 105993
node tools/validate-session.cjs <一个或多个 .jsonl.zstd 路径>
```

`session.jsonl.zstd` 为多帧 zstandard 压缩，Node 24 自带 `node:zlib` 的
`zstdDecompress`；本脚本按帧扫描解码（与引擎 `scanZstdFrames` 同逻辑）。