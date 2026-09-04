# dsh-session-resume 技术文档

版本：0.0.1
适用对象：DSH Web 插件 `@dsh-external/dsh-session-resume`
目标：用一次 Host 续跑计划自动完成“旧会话 -> 原工作区新会话续跑”，不再要求用户下载、解压、复制文件地址，也不允许续跑落到错误工作区。

## 1. 背景

用户原始手工流程：

```text
旧会话
  -> 点击右上角 Session log 下载 ZIP
  -> 手工解压
  -> 复制文件地址
  -> 粘贴到新会话
  -> 新会话读取文件并继续
```

插件将该流程压缩为一次点击：

```text
旧会话
  -> 点击“自动续跑”
  -> Host 解析源会话日志路径
  -> Host 解析原工作区
  -> 返回 attemptId 续跑计划
  -> Client 在原工作区创建/复用新会话
  -> 自动发送“路径 + 续跑指令”
  -> 新会话读取文件并继续
```

核心约定是“只搬运物化目录路径，不搬运日志内容”。旧会话和新会话运行在同一 Host 上，
Host 通过官方 `readRaw` 物化为与官方导出 ZIP 同构的目录（非安全 ID 使用防碰撞路径映射，
见 §9），新会话直接读取该目录。

## 2. 总体拓扑

```text
┌────────────────────────────────────────────────────────────┐
│ DSH Web GUI                                                │
│                                                            │
│ 旧会话 Header                                              │
│   conversation.session.header.utilities                    │
│     -> “自动续跑”按钮                                      │
│                                                            │
│ 输入框 Dock                                                │
│   conversation.input.dock                                  │
│     -> 检测绝对 JSONL 路径 / 旧 export URL                  │
│     -> “一键续跑”与 Header 共用统一执行器                   │
│     -> 多会话时提供“批量续跑 N 个”按钮                     │
└───────────────────────┬────────────────────────────────────┘
                        │ POST /session-resume/api/resume
                        │ POST /session-resume/api/resume-batch
                        │ { sessionId(s), attemptId?, snapshotId(s)? }
                        ▼
┌────────────────────────────────────────────────────────────┐
│ DSH Host 插件                                              │
│  webServer.register(prefix: /session-resume/api)            │
│    loopback 校验 + requestId + 限流                          │
│  sessionQuery.listSessions()                                │
│    -> 找到 session record + 标题                            │
│  sessions.get(id) + sessions.flush(session)                 │
│    -> live 会话先落盘                                       │
│  sessionPersistence.readRaw(sessionId)                      │
│    -> 根 artifact 文本 + raw.filename                      │
│  sessionQuery.traceSession(sessionId)                       │
│    -> 后代放入 subagents/<safeId>/                          │
│  sessionPersistence.readRaw(subagentId)                     │
│    -> 根/后代日志 + media 引用物化为导出目录                  │
│    %TEMP%\dsh-session-resume\<sessionId>\snapshots\<snapshotId>\     │
│    -> 按 snapshotRetention 裁剪最旧快照                     │
│    -> 含 workspace-state/manifest.json + git.txt             │
│  workspaceRegistry                                          │
│    -> 按 sessionIds 归属 / resolveByPath / create           │
│    -> 返回 target.workspaceId                               │
│  ResumeOrderBook + orders.jsonl WAL                          │
│    -> attemptId 幂等 + 重启后终态恢复                       │
└───────────────────────┬────────────────────────────────────┘
                        │ JSON { attemptId, source(s), target }
                        ▼
┌────────────────────────────────────────────────────────────┐
│ 浏览器 client                                              │
│                                                            │
│ GET /session-resume/api/config                              │
│   读取自定义 resumeInstruction（缺省回退冻结默认）           │
│ workspaces.connectWorkspace(target.workspaceId)            │
│   优先复用该工作区已有空白会话                              │
│   （或 sessions.create({ workspaceId })）                   │
│ sessions.open(newId)                                       │
│ binding(newId).session.prompt([{ type: "text", text }],    │
│                              "queue")                      │
│   text = "<path> <续跑指令>"（失败重试 ≤3 次，指数退避）     │
└───────────────────────┬────────────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────────────┐
│ 新会话 Agent                                               │
│                                                            │
│ 读取 Host 物化目录，例如                                     │
│ D:\...\TEMP\dsh-session-resume\session-xxx\snapshots\1234\ │
│   根 session.jsonl + subagents/ + media/                   │
│   + workspace-state/manifest.json + workspace-state/git.txt │
│ 总结已完成/当前/剩余任务，从断点继续                        │
└────────────────────────────────────────────────────────────┘
```

## 3. 主流程

1. 用户在旧会话点击“自动续跑”。
2. Client 生成 `attemptId`（可用 `crypto.randomUUID`），调用
   `POST /session-resume/api/resume`。
3. Host 通过 `sessionQuery.listSessions()` 查找会话记录。
4. 如果会话是 live，Host 调用 `sessions.flush()` 把当前内存日志写入持久化，
   确保后续 `readRaw` 返回完整快照。flush 只是日志落盘，不会保留 job、终端或凭据等运行状态。
5. Host 调用 `sessionPersistence.readRaw(sessionId)` 读取官方原始 artifact，并
   物化成官方导出同构目录：根文件名取 `raw.filename`、子代理 `subagents/<safeId>/`、图片 `media/`。
6. Host 通过 `workspaceRegistry` 解析原工作区：
   - 先按 `workspace.sessionIds` 是否包含源会话；
   - 再按 `workspaceRegistry.resolveByPath(cwd)`；
   - 仍未命中且允许创建时，`workspaceRegistry.create(cwd)` 并尝试把源会话归入；
   - 无法解析时返回 409/501，不继续创建会话。
7. Host 返回 `{ attemptId, sources, target }`（`sources[].path` 是物化目录），并写结构化审计日志。
8. Client 使用 `target.workspaceId`：
   - 优先 `workspaces.connectWorkspace(workspaceId)` 复用空白会话；
   - 否则 `sessions.create({ workspaceId })`；
   - 若 `target.workspaceId` 缺失且存在 `workspaces` 服务，直接失败。
9. Client 打开新会话，构建续跑文本：

```text
<path> 请继续这个会话：直接读取上述日志快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续。若快照缺失或不可读，请如实说明。
```

10. Client 通过官方 `session.prompt()` 发送；失败时复制到剪贴板并显示失败状态。

## 4. 模块职责

| 区域 | 角色 |
| --- | --- |
| `src/index.ts` | Host 插件入口；注册 API 与旧 URL pre-step 改写 |
| `src/host/` | HTTP 路由（api.ts 路由表）、日志读取与目录物化、工作区解析、续跑计划、订单幂等守卫、审计、限流 |
| `src/host/snapshot-store.ts` | 快照布局唯一所有者：缓存根、安全路径段、snapshots 目录、list/prune、layout 真实读取 |
| `src/host/session-log.ts` | 会话记录查找、实时物化、`resolveSourceLog`（快照/实时统一 source 解析，单/批量共用） |
| `src/client/` | 注册 Header 按钮与输入框 Dock；`resume-executor.ts` 统一执行器（单/批量共用 resolve → prompt 重试 → 上报） |
| `src/shared/` | Host/Client 共用的 URL、URI、JSONL 路径解析、统一引用扫描、批次文本、ResumeOrder 执行器 |

## 4.1 技术选型：ts 而非 tsx / js

### 为什么是 `.ts` 而不是 `.tsx`

项目**不使用 JSX 语法**，全部 React 渲染都用 `React.createElement(...)` 函数调用形式。
`.tsx` 扩展名的唯一用途是告诉编译器“文件里有 JSX 语法”；既然没有 JSX，用 `.tsx` 名不副实，
还会要求 tsconfig 配置 `jsx` 选项（本项目 tsconfig 无 `jsx` 配置，正好印证）。选 `.ts` 是最诚实、最简洁的选择。

### 为什么用 `React.createElement` 而不是 JSX

1. **零构建配置**：JSX 需要 Babel/tsc 的 `jsx` 转换 + 运行时（`react/jsx-runtime`）。
   `React.createElement` 是纯函数调用，任何 JS 环境直接运行，不引入额外编译步骤。
2. **与 tsdown bundle 方式匹配**：`tsdown.config.ts` 用 `format: 'cjs'`、`platform: 'browser'`，
   `React.createElement` 让 bundle 更直接，不引入 JSX 运行时依赖。
3. **Host/Client 共享层纯净**：`src/shared/` 的纯逻辑（路径解析、URI 编解码）被 Host（Node）
   与 Client（浏览器）共用，这些模块根本没有 React。用 `.ts` 让共享层不掺入 JSX 概念。

### 为什么是 `.ts` 而不是 `.js`

- **强类型是硬性要求**（AGENTS.md：「强类型：禁用 any/裸字典」）。所有源文件都有显式类型，
  `src/host/types.ts` 为每个 DSH 服务定义接口。
- **编译期抓 bug**：类型检查在 `npm run typecheck` 阶段拦截错误。
- **测试用 `.mjs`**：测试是 `node --test` 无依赖 Node 测试，不需要类型检查，用 ESM 纯 JS
  保持轻量。

### 一句话总结

> **ts 而非 tsx**：项目不用 JSX 语法（全用 `React.createElement`），`.tsx` 名不副实，`.ts` 最诚实。
> **ts 而非 js**：项目坚持强类型（AGENTS.md 红线），类型检查在编译期抓 bug，`.ts` 是唯一选择。

## 5. Host API 契约

### `POST /session-resume/api/resume`

请求：

```json
{
  "sessionId": "session-xxx",
  "attemptId": "optional-attempt-id",
  "snapshotId": "optional-snapshot-id"
}
```

成功响应 `200`：

```json
{
  "ok": true,
  "requestId": "auto-or-echoed-request-id",
  "attemptId": "attempt-id",
  "sources": [
    {
      "sessionId": "session-xxx",
      "label": "会话标题或 sessionId",
      "path": "D:\\Users\\Administrator\\TEMP\\dsh-session-resume\\session-xxx\\snapshots\\1",
      "rootPath": "D:\\Users\\Administrator\\TEMP\\dsh-session-resume\\session-xxx\\snapshots\\1\\session.jsonl",
      "layout": { "root": "session.jsonl", "descendants": 1, "media": 0 },
      "kind": "jsonl-directory",
      "cwd": "D:\\AI\\project",
      "mention": "@[标题](dsh-session:...)",
      "snapshotId": "1",
      "workspaceState": true
    }
  ],
  "target": {
    "workspaceId": "workspace-xxx",
    "cwd": "D:\\AI\\project"
  }
}
```

`snapshotId` 指定时直接复用已有快照目录（不重新物化、不重读 raw）；未命中返回 `404`。
`workspaceState` 表示快照内含 `workspace-state/manifest.json`，Client 据此附加读取提示。

错误响应：

| 状态 | 场景 |
| --- | --- |
| `400` | 缺少 `sessionId`、请求体非法或超过 64 KiB |
| `403` | 非本机回环访问 |
| `404` | 会话不存在，或冷会话尚未落盘 |
| `409` | 源会话无 cwd 且不属于任何工作区，或无法注册原工作区 |
| `429` | 超过限流（20 次/分钟/调用方） |
| `501` | 不支持原始日志工件、无法 flush/readRaw、附件服务缺失、后代/附件物化失败，或无 workspaceRegistry |

### `POST /session-resume/api/complete`

客户端在创建/复用会话并发送续跑文本后，回报订单终态：

```json
{
  "attemptId": "attempt-id",
  "targetSessionId": "session-new",
  "status": "accepted"
}
```

- `status` 只接受 `accepted` 或 `failed`；`accepted` 必须携带 `targetSessionId`。
- 同一 attempt 的重复完成请求幂等返回；状态冲突返回 `409`。
- 未知 attempt 返回 `404`。订单状态追加式落盘到 `orders.jsonl`（WAL），Host 重启后
  `loadFromWal()` 恢复已终态 attemptId，`/complete` 跨重启仍幂等；仅 planned 的状态可被
  再次完成。

### `POST /session-resume/api/resume-batch`

一次物化多个会话并返回合并计划：

```json
{
  "sessionIds": ["session-a", "session-b"],
  "attemptId": "optional-attempt-id",
  "snapshotIds": { "session-a": "snapshot-id" }
}
```

- `sessionIds` 1–3 个；每个源独立物化或按 `snapshotIds` 复用历史快照。
- 任一源不可读返回 `404`；全部源都无法解析工作区返回 `409`。
- 成功响应 `{ ok, attemptId, sources: [{ sessionId, label, path, snapshotId, mention }], target }`，
  目标工作区取第一个可解析的源。
- 订单簿按主会话（`sessionIds[0]`）串行与幂等。

### `GET/PUT /session-resume/api/config`

全局配置读写（无官方 per-plugin 配置注册表，用 `%TEMP%\dsh-session-resume\config.json`）：

```json
{
  "resumeInstruction": "自定义续跑指令（缺省回退冻结默认）",
  "snapshotRetention": 10
}
```

- PUT 只接受合法字段；非法值回退默认（指令超长/空、retention 非整数或越界 1–100 均被忽略）。
- GET 返回当前生效配置；默认 `resumeInstruction` 为冻结 `RESUME_INSTRUCTION`、retention 10。

### `GET /session-resume/api/snapshots?sessionId=...`

列出某会话的历史快照（`[{ sessionId, snapshotId, path, rootPath, createdAt, layout }]`）；
未知会话返回空数组，不报错。

### 兼容 API

| 方法/路径 | 作用 |
| --- | --- |
| `GET /session-resume/api/path` | 仅返回日志定位结果，供兼容调用 |
| `GET /session-resume/api/copy` | 返回旧 export 下载路径 |
| `POST /session-resume/api/resolve` | 解析旧 export URL 或 bare `dsh-session:` |
| `agent/pre-step` | 将直接用户消息中的旧 export URL 改写为官方 mention |

### 安全与可观测

- 所有路由只允许 `127.0.0.1`、`::1`、`::ffff:127.0.0.1`。
- 响应回显 `x-request-id`，缺省由 Host 生成 `requestId`。
- `/resume` 按远程地址做滑动窗口限流，默认 20 次/分钟。
- 每次计划解析输出结构化审计日志：

```json
{"event":"session-resume.order","requestId":"...","remoteAddress":"127.0.0.1","attemptId":"...","sourceSessionId":"...","targetWorkspaceId":"...","status":"resolved","durationMs":1}
```

## 6. 新会话握手

`src/shared/resume.ts` 使用官方 client 协议：

```text
if (target.workspaceId && workspaces?.connectWorkspace) {
  newId = await workspaces.connectWorkspace(target.workspaceId)
} else if (target.workspaceId) {
  newId = await sessions.create({ workspaceId: target.workspaceId })
} else {
  throw "没有续跑目标工作区，已停止创建会话"
}
sessions.open(newId)
binding(newId).session.prompt([{ type: "text", text }], "queue")
```

- `connectWorkspace()` 会复用该工作区中 cwd 匹配的空白会话，是幂等路径。
- `prompt()` 以 `queue` 模式发送续跑消息；发送在同一个 `newId` 上做有界重试，
  不会因为发送失败再次创建目标会话。
- 如果 `prompt()` 失败，插件不会静默丢消息，而是复制到剪贴板并显示失败状态。

## 7. 路径识别

`session-path.ts` 支持：

- Windows 绝对路径：`C:\...\session.jsonl.zstd`
- POSIX 绝对路径：`/home/.../session.jsonl`
- 路径中包含空格
- Markdown 括号和 CJK 标点边界
- 多路径去重
- 拒绝直接粘连在普通文本后面的假路径

## 8. 兼容旧流程

旧流程仍保留：

- 粘贴 `/api/session.export?...` 会显示“检测到 Session 日志链接”。
- “一键续跑”现在也走 `/resume` 统一执行器，确保原工作区；`仅填入` 和
  `复制续跑指令` 保留为手工路径。
- 直接发送旧 URL 时，Host 的 `agent/pre-step` 会改写为官方 `dsh-session:` mention，
  由官方 `session-reference` 生成快照上下文。
- 新主流程和旧 URL 流程互不冲突。

## 9. 关键集成点

- Host 通过 `src/host/service.ts` 的 `readService` 统一读取注入服务（直接属性或
  `ctx.get` 二选一），如 `@deepseek-ai/dsh-workspace` 注册表；Client 通过官方
  `workspaces` 服务调用 `connectWorkspace`。
- `sessionPersistence.readRaw()` 返回后端 artifact 文本。插件物化成官方导出
  同构目录（根 artifact + `subagents/` + `media/`），续跑指令指向目录。
- 后代日志通过 `sessionQuery.traceSession()` 与 `sessionPersistence.readRaw()` 收集；
  每个 live 后代在读取前也会经过 `sessions.flush()` 持久化屏障，并去重防环。
- 附件服务必须可用；日志引用图片时必须能读取附件存储，未知 mediaType 与官方一致
  落为 `media/<safeAttachmentId>.undefined`，否则返回 501，不静默生成残缺目录。
  非安全附件 id 使用 `~<sanitized>_<sha256摘要>` 映射，避免 Windows 冒号 ADS 与
  `sha256:` / `sha256_` 等路径碰撞；全安全字符 ID 保持原名。
- Host 返回前必须确认物化目录完整，避免把已删除或陈旧路径交给新会话。
- 运行时 Cordis `Context` 是 Proxy，读取未声明服务属性会抛
  `cannot get property ... without inject`。插件只直接读取 `inject` 声明的服务；
  测试专用的 `resumeCacheRoot` 先经 `Reflect.has` 探测，避免触碰运行时代理。

## 10. 验证结果

实测结果（测试、真实 Host API、真实 GUI 点击、逐字节目录比对）见
[验证报告](verification.md)，此处不再重复。

## 11. 已知限制

- 真实 media 已用 PNG 验证；jpeg/webp/gif 仍只由单测覆盖。
- 深层后代已用真实三代会话验证；更复杂环状/重复 lineage 仍由单测覆盖。
- 无 cwd 且无 workspace 的真实会话未能在本环境构造，`session.create({})` 默认落到
  `C:\Users\Administrator` 与匹配 workspace；该 fail-closed 分支由单测覆盖。
- 新会话读取 `%TEMP%\dsh-session-resume\<sessionId>\snapshots\<snapshotId>\` 的权限取决于 Agent 运行环境。
- 快照 ID 从该会话已存储快照中取下一个整数序号，裁剪按该序号保留最新 N 份；
  并发物化同一会话时裁剪边界由最后一个完成者决定（单进程内已按源会话串行，跨进程不做互斥）。
- `orders.jsonl` 追加写无跨进程锁；多 Host 进程共享同一缓存根时以"最新行胜出"为准，
  不保证强一致。
- 工作区状态清单不含文件内容，按深度/条目数有界；超大仓库会截断（`truncated: true`）。
- 插件当前通过 super-injector 注入；registry 条目会在 DSH 启动时 autoRestore，重启后仍生效，
  不要为了“重启后自动装配”再把本包加入 profile 的 `dsh.profile.bundles`。
- bundle 与 super 是互斥通道：同一个插件不能同时出现在 `~/.dsh/profiles/web/package.json`
  的 `dsh.profile.bundles` 与 `~/.dsh/super-injector/registry.json`，否则同一 `apply` 会执行
  两次并报 `duplicate prefix route`。切换通道时先移除另一侧。