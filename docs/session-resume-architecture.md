# dsh-session-resume 技术文档

适用对象：DSH Web 插件 `@dsh-external/dsh-session-resume`
目标：用一次 Host 续跑计划自动完成“旧会话 -> 原工作区新会话续跑”，不再要求用户下载、解压、复制文件地址，也不允许续跑落到错误工作区。

> 本文是**当前为真**的架构文档：只描述现在仍在生效的机制与契约。凡是与现 `src/` 不符的历史形态（例如曾被删掉的 HTTP 传输层）一律不在本文出现；历史决策见 [变更记录](CHANGELOG.md) 与 [migration 总结](native-migration-runbook.md) 的历史决策层。
> 只写不易过时、可复现、忠诚的内容：不记行数、测试数量、时间戳、会话 id 样本。

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
Host 通过官方 `readRaw` 物化为与官方导出同构的目录（非安全 ID 使用防碰撞路径映射，见 §9），
新会话直接读取该目录。Client 与 Host 之间的跨边界调用走 **typert typed-remote**：
Host 暴露一个 `sessionResume` 命名空间（`@Remote` 方法），Client 用 `ctx.remote.sessionResume.*` 直接调用。

## 2. 总体拓扑

```text
┌────────────────────────────────────────────────────────────┐
│ DSH Web GUI (Client)                                       │
│                                                            │
│ 旧会话 Header                                              │
│   conversation.session.header.utilities                    │
│     -> “自动续跑”按钮                                      │
│                                                            │
│ 输入框 Dock                                                │
│   conversation.input.dock                                  │
│     -> 检测绝对路径 / session.export URL / dsh-session:    │
│     -> “一键续跑”与 Header 共用统一执行器                   │
│     -> 多会话时提供“批量续跑 N 个”按钮                     │
│                                                            │
│ 挂载：remote.$mount(TYPERT_REMOTE)                          │
│   ctx.remote.sessionResume.resolvePlan / resolveBatchPlan / │
│   completeResume / getConfig / listSnapshots / …            │
└────────────────────────┬───────────────────────────────────┘
                         │ typt remote frames
                         ▼
┌────────────────────────────────────────────────────────────┐
│ DSH Host 插件                                              │
│  SessionResumeService (extends TypertRemoteService)         │
│    @Remote 方法：9 个端点（见 §5）                             │
│  sessionQuery.listSessions() / traceSession()              │
│  sessions.get/ flush / readRaw → 物化目录                   │
│  %TEMP%\dsh-session-resume\<sessionId>\snapshots\<snapshotId>\ │
│  workspaceRegistry → target.workspaceId                    │
│  ResumeOrderBook + orders.jsonl WAL → attempt 幂等+恢复     │
│  installTypertSelfHeal → reload 后重挂 sessionResume/*     │
└───────────────┬────────────────────────────────────────────┘
                │ { attemptId, sources[], target }
                ▼
┌────────────────────────────────────────────────────────────┐
│ 新会话 Agent                                               │
│  读取 Host 物化目录（根 artifact + subagents/ + media/     │
│    + workspace-state/）                                    │
│  总结已完成/当前/剩余任务，从断点继续                      │
└────────────────────────────────────────────────────────────┘
```

## 2.1 组织模型：纵向运行时 × 横向性质 + 契约 seam

本节是全部代码的"组织图"，唯一目的是**让进化效率最大化**——任何一次改动都能一眼看到：改落在哪个运行时、属于哪种代码性质、会不会触及两端必须同步改的高成本接缝。它不新增任何概念，只把 `src/` 既有的结构按两轴说清（护栏：本仓不以新目录堆叠，本节只是标注，不做搬移）。

**纵向轴线（运行时区）**——回答"这个能力在哪个运行时"。这是 `src/` 目录的真实分界：

| 轴区 | 目录 | 说明 |
| --- | --- | --- |
| Host 半区 | `src/host/` + `src/index.ts` | 服务进程内；持资源、碰文件/官方 API、写 WAL 与审计 |
| Client 半区 | `src/client/` | 浏览器 GUI；UI、交互、统一执行器 |
| 共享层 | `src/shared/` | 两端共用纯逻辑（URL/URI/路径/批次/续跑文本） |

**横向交叉（代码性质，非目录）**——附着在每个模块上的"变更性格"，不按它建目录，只按它给被改时的风险标号：

- **纯核（确定性）**：不改外部就确定、可复测。例：`src/shared/*`、`src/host/resume-order.ts` 的幂等/序数、`src/host/workspace-state.ts`、`src/host/order-wal.ts` 的记账规则、`src/shared/source-ref.ts` 引用扫描。生产也是"变动成本低 + 测试回报高"的同一片。
- **副作用/边界**：触碰文件、官方 SDK、外部 IO，最容易随依赖漂移。`src/host/snapshot-store.ts`/`cache-root.ts`（目录）、`src/host/session-log.ts`（readRaw 物化）、`src/host/config.ts`（%TEMP% 原子写）、`src/host/service.ts`（读注入服务）。改它们要把"薄壳隔离"放第一位。
- **编排/协议**：把纯核接到副作用与契约的组装层——`src/host/session-resume-service.ts`（Host 门面 9 端点）、`src/client/resume-executor.ts`（统一执行器）、`src/client/resume-client.ts`（会话创建/复用）。只做组装，不塞业务逻辑。

**契约 seam（唯一"改一处必须两端同步改"面）**：typert remote（`ctx.remote.sessionResume.*`，见 §5）。这是全仓唯一"两端对称"的接缝——增/改/删一个端点，Host 门面与 Client 调用必须一起动。**它是进化效率最该盯紧的单点**：任何横穿契约的性质变更，先在 seam 上对齐，再落两半区。

一句话：**纵向回答"能力在哪个运行时"，横向回答"它变起来多贵"，契约 seam 是全仓唯一"两端必须同步"的高风险缝。**

## 3. 主流程

1. 用户在旧会话点击“自动续跑”。
2. Client 生成 `attemptId`（优先 `crypto.randomUUID`，缺失时回退“前缀+时间戳-单调计数”），
   调用 `ctx.remote.sessionResume.resolvePlan(sessionId, attemptId, snapshotId)`。
3. Host 通过 `sessionQuery.listSessions()` 查找会话记录。
4. 如果会话是 live，Host 调用 `sessions.flush()` 把当前内存日志写入持久化，
   确保后续 `readRaw` 返回完整快照。flush 只是日志落盘，不保留 job、终端或凭据等运行状态。
5. Host 调用 `sessionPersistence.readRaw(sessionId)` 读取官方原始 artifact，并物化成
   官方导出同构目录：根文件名取 `raw.filename`、子代理 `subagents/<safeId>/`、图片 `media/`。
6. Host 通过 `resolveResumeWorkspace(ctx, sourceSessionId, cwd)`（`src/host/workspace.ts`）解析原工作区：
   先按 `workspaceRegistry.list()` 中 `sessionIds` 归属，再按 `resolveByPath(cwd)`，仍未命中且
   允许创建时 `create(cwd)` 并把源会话归入（attach 失败时回滚新建工作区）；
   无法解析时返回 409/501，不继续创建会话。
7. Host 返回 `{ attemptId, sources[], target }`（`sources[].path` 是物化目录），并写结构化审计日志。
8. Client 使用 `target.workspaceId`：
   - 优先 `workspaces.connectWorkspace(workspaceId)` 复用空白会话；
   - 否则 `sessions.create({ workspaceId })`；
   - 若 `target.workspaceId` 缺失且存在 `workspaces` 服务，直接失败。
9. Client 打开新会话，构建续跑文本（mention 优先，缺省回退快照路径；legacy 会话走路径）。
10. Client 通过官方 `session.prompt()` 发送（`queue` 模式，同一 `newId` 上有界重试）；失败时
    复制到剪贴板并显示失败状态，不静默丢消息。
11. Client 用 `completeResume` 回报终态 `accepted | failed`；Host 写 WAL 并审计。

## 4. 模块职责

| 区域 | 角色 |
| --- | --- |
| `src/index.ts` | Host 插件入口：实例化 `SessionResumeService`、安装 typert 自愈守卫、注册 `agent/pre-step` 改写；注入 `typert` 等服务 |
| `src/host/session-resume-service.ts` | `SessionResumeService extends TyperRemoteService`；暴露 9 个 `@Remote` 方法，委托给纯域核心 |
| `src/host/` | 留日志读取与目录物化、工作区解析、续跑计划、订单幂等守卫、WAL、审计 |
| `src/host/snapshot-store.ts` | 快照目录唯一所有者：缓存根、安全路径段、snapshots 目录、list/prune、layout 真实读取 |
| `src/host/session-log.ts` | 会话记录查找、实时物化、`resolveSourceLog`（快照/实时统一 source 解析，单/批量共用） |
| `src/client/` | 注册 Header 按钮与输入框 Dock；`resume-executor.ts` 统一执行器（单/批量共用 resolve → prompt 重试 → 上报）；`resume-client.ts` 负责会话创建/复用与指令解析 |
| `src/shared/` | Host/Client 共用 URL、URI、JSONL 路径解析、统一引用扫描、批次文本、续跑文本构建 |
| `src/typert-meta.d.ts` | 单包协议面：供 generator 与 client type-face 解析 |

**依赖方向（本仓真实边界，不套"四栈"）**：这是一个单 client ↔ 单 host 的插件，只有一条依赖链——
官方 DSH 能力（`sessions`/`readRaw`/`workspaceRegistry`/`session.prompt`）→ `src/host/`（服务与资源）
→ `src/shared/`（两端共用纯逻辑）→ `src/client/`（UI 与请求）。依赖**单向向下**；跨边界调用走 typert
remote。所谓"供需"在这里只是 host 供、client 求的**一条供需边**，不构成可称"栈"的多方流动层级。

## 5. Remote 契约（`ctx.remote.sessionResume.*`）

Client 与 Host 之间不设手写 HTTP；调用跨边界走 typert remote。所有 `@Remote` 方法**参数一律必填**，
缺省用空串 / 空对象表示“未提供”（typert 协议不支持可选参数）。

| Remote 方法 | 参数 | 返回 | 作用 |
| --- | --- | --- | --- |
| `resolveFromText(text)` | text | `{ok, sessionId?, label?, mention?, error?}` | 从文本识别会话日志链接并解析 |
| `resolveSession(sessionId)` | sessionId | `{ok, sessionId?, label?, mention?, error?}` | 按 id 解析会话 |
| `resolveLogPath(sessionId)` | sessionId | `{ok,status?,path?,…}` | 定位会话日志物化路径 |
| `resolvePlan(sessionId, attemptId, snapshotId)` | 三者必填（空串=缺省） | `ResumePlan` | 单会话续跑计划；`snapshotId` 命中则复用历史快照 |
| `resolveBatchPlan(sessionIds, attemptId, snapshotIds)` | sessionIds 非空；snapshotIds 空对象=缺省 | `ResumePlan` | 批量续跑计划，`sessionIds[0]` 为主键串行 |
| `completeResume(attemptId, status, targetSessionId, error)` | status=`accepted\|failed`；targetSessionId/error 空串=缺省 | `{ok, attemptId, status, targetSessionId?, error?}` | 回报终态；同 attempt 幂等；冲突返回终态状态 |
| `getConfig()` | 无 | `ResumeConfig` | 读全局配置 |
| `setConfig(config)` | config | `ResumeConfig` | 写全局配置（归一化后） |
| `listSnapshots(sessionId)` | sessionId | `StoredSnapshot[]` | 列出某会话历史快照 |

> `ResumePlan`：`{ ok, attemptId, sources[], target }`，单会话即 `sources` 长度 1。
> `attemptId` 幂等：`ResumeOrderBook` 保证同源并发去重、串行、重启后终态恢复（WAL），
> `completeResume` 跨重启仍幂等。
> 状态码语义（`409/404/…`，如有）以返回体内的 `status` 字段表达，不再是 HTTP 状态行。

### 错误语义（渐进映射到 `ResumePlan`）

| 场景 | 行为 |
| --- | --- |
| 缺少必要参数 | `{ok:false, status:400, error}` |
| 会话不存在或不可读（含冷会话未落盘） | `{ok:false, status:404, error}` |
| 源会话无 cwd 且不属于任何工作区 / 无法注册 | `{ok:false, status:409, error}` |
| 不支持原始工件 / 无法 flush/readRaw / 附件服务缺失 / 后代物化失败 | `{ok:false, status:501, error}` |
| 任意终态冲突（accepted 后又 failed） | `completeResume` 返回当前终态，不覆盖 |

## 5.1 审计

每次计划解析写一行结构化审计（`source` 走 `ctx.logger`），含 `attemptId / sourceSessionId /
targetWorkspaceId / status / error`。终态由 `completeResume` 追加记录。日志分层：审计为结构化 JSON，
用户/运维输出为纯文本。

## 5.2 配置

全局配置（无官方 per-plugin 注册表）存 `%TEMP%\dsh-session-resume\config.json`，原子写（临时文件+rename）：
`{ resumeInstruction?, snapshotRetention? }`。`getConfig`/`setConfig` 走 remote；缺省 `resumeInstruction`
为冻结 `RESUME_INSTRUCTION`、retention 默认 10（范围 1–100，非法值回退默认）。

## 6. 新会话连接与发送

`src/client/resume-client.ts` 使用官方 client 协议：

```text
if (target.workspaceId && workspaces?.connectWorkspace)
  newId = await workspaces.connectWorkspace(target.workspaceId)
else if (target.workspaceId)
  newId = await sessions.create({ workspaceId: target.workspaceId })
else
  throw 「没有续跑目标工作区，已停止创建会话」
sessions.open(newId)
binding(newId).session.prompt([{ type:"text", text }], "queue")
```

- `connectWorkspace()` 会复用该工作区中 `cwd` 匹配的既有空白会话，是幂等路径。
- `prompt()` 以 `queue` 模式发送；发送在**同一个 `newSessionId`** 上做有界重试（指数退避），
  不会因发送失败再次创建目标会话。
- 若 `prompt()` 失败：插件不静默丢消息，复制到剪贴板并显示失败状态。

## 7. 路径识别

统一引用扫描（`src/shared/source-ref.ts`）支持：

- Windows 绝对路径 `C:\...\session.jsonl[.zstd]`
- POSIX 绝对路径
- 旧 session.export URL（`/api/session.export?sessionId=...`）
- `dsh-session:` mention
- 路径中含空格（`C:\Program Files\...`）
- Markdown 括号与 CJK 标点边界
- 多路径去重
- 拒绝直接粘在普通文本后的假路径

## 8. 兼容旧流程（现仍有效）

- 粘贴旧 `export URL` 显示“检测到 Session 日志链接”。
- “一键续跑”现在也走 `resolvePlan` 统一执行器（原工作区锁定）；`仅填入` 和 `复制续跑指令` 保留为手工路径。
- 直接发送旧 URL 时，Host 的 `agent/pre-step` 把它改写为官方 `dsh-session:` mention，由官方
  `session-reference` 补快照上下文；`pre-step` 排在官方 `session-reference` prepend 之后并调用 `next()`。
- 新主流程与旧 URL 流程互不冲突。

## 9. 关键集成点 / 不变量

- 读取注入服务统一经 `src/host/service.ts` 的 `readService`（直接属性或 `ctx.get` 二选一），避免触碰
  运行时 Cordis Proxy 的“without inject”守卫；测试专用缓存根须先 `Reflect.has` 探测。
- Client 侧间接 remote：`remoteFacade(ctx)` 优先 `ctx.get('remote.sessionResume')`，回退 `ctx.remote.sessionResume`，
  规避裸属性读被守卫拦截；Client 先用 `remote.$mount(TYPERT_REMOTE)` 挂载 Host 命名空间。
- Host 端 typert 注册可被 reload/re-inject 抽离成 `withdrawn`，网关拒绝调用；`installTypertSelfHeal`
  （`src/index.ts`）在 `hasSeen(ep) && get(ep)===undefined` 时重挂 + 低频轮询兜底，保证 namespace 不长期 withdrawn。
- 物化目录与官方导出同构；`sources[].path` 指向目录；`workspaceState` 时附 `manifest.json`+`git.txt`。
- 非安全 ID（如 `sha256:<digest>`）映射为 `~<sanitized>_<sha256>`（防 Windows 冒号 ADS 与
  `sha256:`/`sha256_` 碰撞）；全安全字符 ID 保持原名。未知 mediaType **fail-closed 跳过并记录
  `session-resume.media-skipped-unknown-type` 告警**（不落 `.undefined` 文件）。
- 文件名 fail-closed：拒绝 `.`/`..`/`/`/`\`/绝对路径/超长。
- legacy 缺 `message.id` 的旧会话：续跑文本优先走快照路径而非 `dsh-session:` mention（mention 会重触发
  fragile 的 surface 读，拒绝对 legacy 事件的“lacks an identified message”）；路径路由是持久的、免重装根修。

## 10. 验证

可复现验证（命令 + 行为基线）见 `docs/verification.md`；测试为 `node --test "tests/*.test.mjs"`。

## 11. 限制

- 深代 lineage 与复杂环/重复后代主流程依赖单测；真实三层已验证。
- 无 cwd 且无 workspace 的真实会话未能在环境构造，`session.create({})` 默认落到用户目录；fail-closed 分支由单测覆盖。
- 新会话读取物化目录的权限取决于 Agent 运行环境。
- 快照 id 从存储序数取下一个，裁剪保留最新 N 份（默认 10）；并发物化同一会话按源串行，跨进程互不互斥。
- `orders.jsonl` 追加写无跨进程锁；多 Host 进程共享缓存根时“最新行胜出”，不保证强一致。
- 工作区状态清单不含文件内容，按深度/条目数有界，超大仓库截断（`truncated:true`）。
- 装配通道为 super-injector（registry 条目在 DSH 启动时 autoRestore）；bundle 与 super 互斥，勿同时加入；
  切换通道须先移除另一侧，否则 `apply` 重复执行报 `duplicate prefix route`。Host `typt` 自愈在
  reload 之后保持命名空间 LIVE。