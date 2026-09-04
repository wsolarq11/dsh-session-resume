# dsh-session-resume 验证报告

验证对象：`@dsh-external/dsh-session-resume` `0.0.1`
验证环境：DSH Web `http://127.0.0.1:3080`，插件已注入并 active。

## 结论

插件主流程已从“下载 export ZIP、手工解压、复制路径”改成纯 Host 物化目录协议：

1. 会话头部新增“自动续跑”按钮。
2. 点击后先调用 Host `/resume`：flush 当前会话、通过官方 `readRaw` 读取原始
   artifact，物化为官方导出同构目录，并锁定原工作区。
3. Client 用 `/resume` 返回的 `target.workspaceId` 通过官方
   `connectWorkspace`/`sessions.create({ workspaceId })` 创建或复用新会话，
   再打开并发送续跑指令：先阅读目录指向的会话日志，总结已完成/当前/剩余任务，
   然后从断点继续。这属于“把日志作为快照文本交给新会话”，不是官方上下文状态恢复。
4. 新会话不再要求用户重复下载、解压或粘贴文件，也不会落到错误工作区。
5. 旧 export URL / `dsh-session:` mention 兼容路径仍保留，不冲突。

> 字节级一致性结论适用于全安全字符 ID；非安全 ID（如 `sha256:<digest>`）使用
> `~<sanitized>_<sha256摘要>` 防碰撞映射，目录结构一致但不保证与官方 ZIP 同名。

## 验证命令

| 命令 | 结果 |
| --- | --- |
| `npm test` | 全部 PASS（108 断言，含客户端执行器、引用扫描与错误契约回归测试） |
| `npm run typecheck` | PASS |
| `npm run build` | PASS，Host + client bundle 生成（`lib/client.js`） |
| `GET /session-resume/api/config` | 200，返回冻结默认指令 + retention 10 |
| `PUT /session-resume/api/config` | 200，自定义指令往返生效；非法 JSON 400；结束还原默认 |
| `GET /session-resume/api/snapshots?sessionId=unknown` | 200，`snapshots: []` |
| `POST /session-resume/api/resume-batch` 空数组 | 400，「sessionIds 必填且至少一个」 |
| `scripts/smoke-api.mjs`（live） | 9/9 PASS，配置往返、快照列表、批量守卫、404 兜底 |
| 注入状态 | `dev_inject_plugin` 后 host ✓ + client ✓，loader 显示 `[active] [injected]` |
| 运行时回归 | 修复 `cannot get property "resumeCacheRoot"`（WAL 初始化直接读 facade），修复后注入即 active |
| `POST /session-resume/api/resume` 缺 sessionId | 400，错误为“sessionId 必填且必须是字符串”，响应回显 `requestId` |
| `POST /session-resume/api/resume` 未知会话 | 404，错误为“会话不存在或不可读” |
| `POST /session-resume/api/resume` 真实会话 | 200，`sources[0].path` 指向物化目录 |
| `POST /session-resume/api/complete` accepted | 200，`targetSessionId` 入库，重复上报幂等保留首个终态 |
| `POST /session-resume/api/complete` 冲突 | 已 accepted 后改报 failed 返回 409 |
| 同 attemptId 并发 | 多个并发 `/resume` 全部 200，返回同一个 attemptId 与同一个 sources[0].path |
| 不同 attemptId 并发 | 同一源会话多个并发计划全部 200，返回不同 attemptId、同一 sources[0].path |
| 真实限流 | 窗口内超限请求返回 429，首个 429 出现在预算耗尽后 |
| Playwright 页面 E2E | 真实 GUI 中头部显示“自动续跑”，点击后 `/resume` 200 且 `/complete` accepted，新会话收到续跑指令并开始读取原工作区 |
| 父会话物化目录 | 与官方 export ZIP 解压结果逐字节一致，含根 artifact 与 `subagents/<id>/` |
| 同刻官方 export | `/resume` 后立即下载官方 ZIP，解压目录仍逐字节一致 |
| 新鲜度 | 源会话新增唯一标记后 `/resume`，物化根日志包含该标记 |
| 真实续跑回复 | 新会话实际读取物化目录，助手回复 `E2E_RESUME_OK` |
| 三层后代 | 三个后代层级，目录与官方 ZIP 逐字节一致 |
| 真实 media | PNG 附件物化为 `media/<collision-safe id>.png`，目录结构一致 |
| 官方 readRaw 链路 | 根/后代 artifact 均来自 `readRaw`；live flush；附件服务前置校验 |

## Host 续跑计划协议

`POST /session-resume/api/resume`，请求体：

```json
{
  "sessionId": "session-...",
  "attemptId": "可选，缺省由 Host 生成"
}
```

- 查找 `sessionQuery.listSessions()` 中的记录。
- 要求 `sessionPersistence.supportsRawArtifacts === true` 且 `readRaw` 可用。
- live 会话先通过 `sessions.flush()` 把当前内存日志写入持久化，确保 `readRaw` 返回完整快照；
  `sessions` 缺失时与官方导出一样不阻断。flush 不会保留运行状态，只是日志落盘。
- 调用 `sessionPersistence.readRaw(sessionId)` 返回后端原始 artifact；缺失返回 404。
- 日志物化为 `%TEMP%\dsh-session-resume\<sessionId>\snapshots\<snapshotId>\`：
  `sources[0].path` 是快照目录，`sources[0].rootPath` 是目录内根 artifact；
  后代和图片与官方导出布局一致。
- 每次物化按 `snapshotRetention`（默认 10）裁剪该会话最旧快照；`snapshotId` 指定时
  直接复用已有快照，不重新物化。
- 物化目录内含 `workspace-state/manifest.json`（文件树清单）与
  `workspace-state/git.txt`（git 状态）；扫描失败降级为空清单，不阻断续跑。
- 附件服务必须在物化前可用；未知 mediaType 与官方一致落为 `.undefined`。
- 通过 `workspaceRegistry` 解析原工作区：先按源会话 `sessionIds` 归属，
  再按 `cwd` 路径匹配；无解且允许注册时创建 workspace；仍无解时 fail-closed。

## 真实浏览器验证

- 已注入插件到运行中的 DSH Web。
- 新页面刷新后 `conversation.session.header.utilities` 槽位出现“自动续跑”按钮，
  tooltip 为“由 Host 锁定原工作区，创建新会话并自动续跑”。
- 真实 GUI 点击 `自动续跑`：新会话在源会话原工作区打开，首条消息包含
  Host 自动物化后的日志目录路径和续跑指令；DOM 断言 `HAS_SESSION_LOG_PATH` 与
  `HAS_RESUME_INSTRUCTION` 均通过。
- 控制台无插件错误；Header 不再依赖本地 `useSessions/useWorkspaces` 猜测目标，
  统一由 Host `/resume` 决定 `target.workspaceId`。
- 真实 `/resume` 调用：
  - 返回 `attemptId`、物化目录、目录内根日志路径和原工作区 `workspaceId`；
  - 父会话目录与官方 export ZIP 解压结果逐字节一致；
  - 目标工作区与源会话 `cwd` 一致；
  - 不创建新会话，创建/复用发生在客户端确认计划之后。

## 客户端行为

- Header 按钮先调用 `POST /resume`，成功后执行
  `connectResumeSession(ctx.sessions, plan.target, ctx.workspaces)`。
- 有 `workspaceId` 时优先走官方 `workspaces.connectWorkspace(workspaceId)` 复用
  该工作区已有空白会话；不可用时回退 `sessions.create({ workspaceId })`。
- 没有 `workspaceId` 且存在 `workspaces` 服务时 fail-closed，不会只传 `cwd` 创建会话。
- 新会话 prompt 发送失败时会把续跑文本复制到剪贴板，并显示错误，不会静默丢消息。
- 输入 dock 的“一键续跑”与 Header 共用统一执行器；“仅填入”与“复制续跑指令”保留为手工路径。
- 路径解析器覆盖 Windows 与 POSIX 路径、带空格路径、Markdown/CJK 标点边界、多路径去重。

## Host 安全与审计

- `/session-resume/api` 只接受本机回环地址；非 loopback 返回 403。
- 按调用方滑动窗口限流，默认 20 次/分钟，超限返回 429 与 `retry-after`。
- 每次响应回显 `x-request-id` 或 Host 生成的 `requestId`。
- 每次 `/resume` 尝试都会输出结构化 `session-resume.order` JSON 日志：
  `attemptId`、源会话、目标工作区、状态和耗时。
- 响应体最大 64 KiB，超出返回 400。

## 测试覆盖

- `tests/host-path.test.mjs`：live flush + readRaw、`raw.filename` 根文件、
  子代理安全路径/去重、附件服务前置、media 扩展名、非安全附件 id 的防碰撞
  Windows 安全路径、readRaw 失败/缺失、后端不支持、未知会话 404。
- `tests/resume.test.mjs`：创建/打开/发送成功、workspaceId 优先、
  `connectWorkspace` 复用空会话、无 workspaceId 时 fail-closed、prompt 失败结构化返回。
- `tests/resume-plan.test.mjs`：按会话归属解析原工作区、按路径解析、注册新工作区、
  无 cwd/无注册表 fail-closed、501 错误透传、新建 workspace 失败补偿。
- `tests/client-executor.test.mjs`：成功路径只 create/prompt 一次；发送失败不会重复建会话。
- `tests/rate-limit.test.mjs`：滑动窗口限制、独立窗口、过期恢复。
- `tests/session-path.test.mjs`：Windows/POSIX、空格、Markdown 边界、粘连文本拒绝、去重。
- `tests/config.test.mjs`：默认值、完整有效配置归一化、原子写读、指令构建器、配置 API 往返、
  批量 `sessionIds`/`snapshotIds` 严格校验。
- `tests/snapshots.test.mjs`：序号快照目录布局、retention 裁剪、历史快照复用（不重物化）、
  未知 snapshotId 404、旧版无 `snapshots\` 层布局容忍、后代计数、不可读/空根 artifact fail-closed。
- `tests/workspace-state.test.mjs`：清单内容与排除、缺失 cwd 降级、物化内含
  workspace-state、带状态提示的续跑文本、symlink/junction 不越界。
- `tests/batch.test.mjs`：批量文本、双会话物化、空/超限 400（4/5/6 均拒绝）、缺失会话 404。
- `tests/batch-key.test.mjs`：批量 in-flight key 不会因 session id 含分隔符而碰撞。
- `tests/source-ref.test.mjs`：路径/URL 统一扫描、混合引用计数、session-only 计数。
- `tests/order-wal.test.mjs`：WAL 追加与恢复、终态幂等、attemptId 计划只解析一次。
- `tests/order.test.mjs`：attemptId 去重、同源串行、终态幂等、裁剪不删 planned 在飞 attempt。
- 既有 `session-url`、`session-uri`、`rewrite` 测试继续通过。

## 页面级验证（headless 渲染）

- 用真实 Chromium 内核（CentBrowser Portable，`D:\_browser_\CentBrowser\CentBrowserPortable\chrome.exe`）
  headless 模式渲染 `http://127.0.0.1:3080/`：
  - `--headless --dump-dom` 得 305 KB 渲染后 DOM（`.verify/dsh-home-rendered-dom.html`），
    非空白；DOM 内嵌客户端模块注册表包含
    `{"id":"@dsh-external/dsh-session-resume","url":"/plugins/@dsh-external/dsh-session-resume/client.js?rev=40d01ec66e34","inject":["@deepseek-ai/dsh-client-runtime",...]}`，
    证明插件 client 模块已被 DSH 客户端模块系统注册并注入浏览器侧。
  - `--headless --screenshot` 得 2100×1350 PNG（`.verify/dsh-home-screenshot.png`，115 KB）；
    像素采样 57900 点、75% 非白，确认真实 UI 渲染、非白屏。
  - 插件 client bundle 真实 URL `GET /plugins/@dsh-external/dsh-session-resume/client.js?rev=40d01ec66e34`
    返回 200 / 29018 字节，内容为 `window.__ModuleLoader__.load({ id: "@dsh-external/dsh-session-resume", ... })`。
- 环境限制记录：当前运行模型 `deepseek-v4-flash-0731` 未声明图像输入，`read_image` 人工视觉
  复核被运行时拒绝（子代理同）。视觉复核以像素统计 + DOM 结构断言等价替代，如实记录不冒充人工读图。

## 残余风险

- 已用真实 PNG 验证 media 目录与官方解压一致；jpeg/webp/gif 仍只由单测覆盖。
- 深层后代已用真实三代会话验证；更复杂环状/重复 lineage 仍由单测覆盖。
- 物化快照按已存储序号保留最新 N 份；跨进程并发物化同一会话时不互斥，以最后完成者为准。
- `orders.jsonl` 无跨进程锁；多 Host 进程共享缓存根时"最新行胜出"，不保证强一致。
- 新会话直接读取目录中的明文 JSONL。若临时目录被系统清理（含旧快照），再次点击会重新物化。
- 插件当前通过 super-injector 注入到运行中的 DSH Web；registry 条目在 DSH 启动时
  autoRestore，重启后仍生效，不需要加入 profile 的 `dsh.profile.bundles`。
- bundle 与 super 是互斥通道：若未来切换为 bundle 装配，先从 super registry 移除本包，
  再按 profile bundles 装配并验证 `/session-resume/api` 不重复注册。