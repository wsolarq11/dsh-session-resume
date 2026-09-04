# 变更历史

本文件记录关键决策与已验证事实，供追溯。不记录过程性细节（临时文件、具体会话 id、测试数量等易过时内容）。

> 各次会话的过程、调查与权衡细节见 [工作日志](WORKLOG.md)（如 2026-08-29 会话：注入器
> 预检调查、发布评估结论、五个扩展方向的实现与实测）。

## 2026-08-30 — 热核评审第十轮落地（round-10）

针对本轮热核评审（见 [综合报告](thermo-nuclear-review-consolidated.md)）的 P2/P3 一并处理，
`npm run typecheck` PASS、`npm test` 114/114 全绿（含调整后的媒体契约测试）、
`npm run build:client` PASS。

- 删除 `session-path.findLogPathMatch` / `session-url.findLogUrlMatch` 两个测试专用的
  单匹配包装（生产只消费复数扫描器）；两处测试改用 `findLogPathMatches(text)[0] ?? null`
  直呼权威扫描器。
- `snapshotRootPath` 收敛为 `string` 返回：`safePathSegment` 恒非空，删除不可达的
  `null` 分支与 4 处调用点的冗余判空。
- `writeMedia` 对未知媒体类型 fail-closed：跳过该引用并写结构化告警
  `session-resume.media-skipped-unknown-type`，不再生成 `media/<id>.undefined`；
  `layout.media` 改为已落盘文件数，快照布局更诚实。
- client 订单 UI 状态收敛为单一 `ResumeOrderUiState` 联合（`idle|resolving|creating|
  sending|done|error`），dock/button/dock-ui 的 `useState`/`orderLabel`/`ResumeActionBar`
  全部绑定该类型，删除 `order.ts`/`batch.ts` 的死 `ResumeStage` 重导出。

## 2026-09-03 — 热核评审新轮 + 一并处理（round 11）

本轮（round 11）全树热核评审，`npm run typecheck` PASS、`npm test` 116 全绿、
`npm run build:client` PASS。本轮无结构性回归；两项并处理：

### safe-token 规则单点化（Finding 1）

收敛的是 safe-token 规则最后的两处手工重写处：

- `/complete` 的 `attemptId` 改走共享 `readOptionalToken`（必填语义单独 400），
  删除内联的 `isSafeOrderId` 重复判断。
- `readSnapshotIds` 的每个快照值改经 `readOptionalToken` 校验，删除内联的
  `isSafeOrderId` + `TOKEN_INVALID_ERROR` 重复。
- safe-id 规则（`isSafeOrderId` + 错误文案）现只存在于 `readOptionalToken` 一处；
  四个调用点（`/resume`、`/resume-batch`、`/complete`、`snapshotIds`）共享同一实现。
- 回归测试补入 `tests/config.test.mjs`：`/complete` 不安全的 `attemptId` → 400，
  缺失 `attemptId` → 400「必填」。

### `api.ts` 分解（F5 / 模块边界观察项落地）

- 原 `src/host/api.ts` 454 行内联全部路由处理器；现拆出
  `src/host/routes.ts`（393 行）：`resumeApiRoutes(deps)` 路由表 + `send` +
  `readJsonBody` + 校验器 + `runPlanOrder`。
- `src/host/api.ts` 收敛为 72 行调度/传输壳（loopback、限流、requestId、
  404/500）、WAL/order-book 接线，仅构建路由表并分发。
- 新增路由/改端点在 `routes.ts` 完成，两个文件都远低于 500 行边界；
  公共导出（`registerResumeApi`/`isLoopbackAddress`）与各端点的行为均不变。

完整发现与未改的观察项见
[热核评审综合报告](thermo-nuclear-review-consolidated.md)（该文件为全部轮次的单份汇总，含本轮 round 11 与后来的 round 12）。

## 2026-09-03 — 热核评审新轮（死代码与薄包装收敛）

本年度第九轮新语全树热核评审，`npm run typecheck` PASS、`npm test` 114/114 全绿、
`npm run build:client` PASS。本轮无结构性回归；收敛的都是真实死代码与薄包装：

- 删除 `session-url.ts` / `session-path.ts` 中测试专用的 `countDistinctLogSessions` /
  `countDistinctLogPaths` —— 去重计数模型已收拢到 `shared/source-ref.ts`
  （`countDistinctSourceRefs` / `countDistinctSessionRefs`），上一轮已点名为死代码。
- 删除 `shared/resume.ts` 两个纯转发身份包装 `buildResumePathPromptWithWorkspaceState` /
  `buildResumeMentionPromptWithWorkspaceState`，执行器与工作区状态测试直呼权威
  `buildResumePrompt`。
- `kind: 'jsonl-directory'` wire 契约 token 收敛为 `shared/plan.ts` 的
  `JSONL_DIRECTORY_KIND` 单一事实源；`cache-root.ts` 的 `defaultCacheRoot` 去掉多余 export。

评审完整发现与未改的观察项见 [热核评审综合报告](thermo-nuclear-review-consolidated.md)。

## 2026-08-30 — 热核评审后续修复

针对下一轮评审的 P0–P3 一并处理，`npm run typecheck` PASS、
`npm test` 全绿、client bundle 构建成功。

- 批量续跑上限从 5 收敛为 3，与官方 `maxReferences` 和 `MAX_SOURCE_SESSIONS`
  共享同一常量，避免计划成功后仍被 session-reference 拒绝。
- 工作区清单扫描改用 `lstat`，不跟随 symlink/junction，杜绝清单越出工作区根目录。
- 新增 `shared/source-ref.ts` 统一扫描路径/URL 引用，Dock 计数与 pre-step 会话改写
  共用同一模型。
- `/resume-batch` 严格校验 `sessionIds`（非空字符串、无重复）与 `snapshotIds`
  （可选对象），不再静默过滤或降级。
- 历史快照 `readable` 改为校验根 artifact 真实存在、是文件且非空。
- Host 单会话计划复用批量计划解析；client 单会话/批量共用 in-flight 去重执行器。

## 2026-08-30 — 热核评审问题一并处理

针对当前 master 全树评审的 P1–P3 全部落地，`npm run typecheck` PASS、
`npm test` 104/104 全绿、client bundle 构建成功。

- 快照列表改为统计 `subagents/<safeId>/` 内的日志文件，`descendants` 不再恒为 0。
- `StoredSnapshot` 增加 `readable`，非目录条目不列入；`resolveSourceLog` 对不可读快照
  fail-closed 返回 404。
- 配置写入用 `randomUUID()` 临时文件并在模块内串行化，消除并发 rename 竞争。
- `ResumeOrderBook` 记录 WAL load/append/rewrite 失败，并在恢复完成前 gate
  run/complete，避免启动恢复竞争。
- 批量 in-flight key 改为 `JSON.stringify(sessionIds)`；pre-step 超引用上限时整段
  保留，不再部分改写。
- `snapshotIds` 非字符串值返回 400；WAL 恢复行校验状态与 plan 形状。
- 测试命令改为自动发现 `tests/*.test.mjs`；复现指南同步当前源码、发布清单与契约。
- `ResumeSourceInfo.layout` 复用 `SessionLogLayout`，`SessionLogPathInfo` 收敛为
  wire source 的 Omit 类型。

## 2026-09-02 — 装配通道一致性修正

- 明确本插件当前由 super-injector 装配；`~/.dsh/super-injector/registry.json` 是唯一入口，
  不要同时加入 profile bundles。
- 若未来切到 bundle 装配：先从 registry 移除本包，再确认 `dsh.bundle.patch`/`cordis.patch.yml`
  随安装包存在；两通道并存会重复注册 `/session-resume/api`。
- 同步 README/复现指南/架构/验证文档；一键安装器增加 bundle/inject 互斥与现存重叠校验。
- `cordis.patch.yml` 已加入 `files` 发布清单；文档中的配置键统一为 `dsh.profile.bundles`。
- 实测热重载无回归（Host API 200、client bundle 200），本次变更已提交并推送。

## 2026-09-02 — 热核审查第三轮修复

针对第二轮审查的 P0–P2 一并处理，`npm run typecheck` PASS、`npm test` 97/97 全绿、
client bundle 构建成功。

- `resolveSourceLog` 改为返回 `SessionLogPathResult`，单/批量计划透传真实 404/501，
  不再把附件缺失等 501 压成 404。
- `runResumeOnce` 取消“resolve → 建会话 → 发送”外层重试：只创建/复用一个目标会话，
  仅对同一 `newId` 的 prompt 做有界重试，发送失败不会重复建会话。
- `safePathSegment` 对非安全 ID 使用 `~<sanitized>_<sha256>` 映射，`child/id` 与
  `child_id`、`sha256:a` 与 `sha256_a` 不再碰撞；全安全字符 ID 保持原名。
  字节级一致性结论相应限定为全安全字符 ID，非安全 ID 的目录结构仍一致但不保证同名。
- `normalizeResumeConfig` 始终返回完整有效配置，缺省字段自动补齐默认值。
- 快照目录从 `Date.now()` 时间戳改为存储态整数序号，list/prune 按序号排序，
  业务排序不再依赖系统时钟。
- 新建 workspace 后 attach 失败时调用可选 `remove()` 补偿；无回滚能力时显式报残留。
- WAL load/append/rewrite 经同一队列串行；`ResumeOrderBook` 只裁剪终态 attempt，
  不裁剪 `planned` 在飞 attempt。
- 删除测试专用的 `resolveResumeWorkspaceId`/`WorkspaceTargetLike` 与未使用的
  `created` 审计状态；README/架构/验证/复现文档同步到 `sources[]` 与新的快照/安全路径契约。

## 2026-09-02 — 热核审查第二轮（结构收敛 + 死代码证实）

第二轮热核审查聚焦结构简化与死代码证实，`npm run typecheck` PASS、
`npm test` 93/93 全绿、client bundle 构建成功。

### 死导出证实删除（P0）

- 上一轮以"测试契约"为由保留的 `encodeSessionUriForExport /
  decodeSessionPayloadForExport / formatMentionForExport` 与 `resumeInstruction`
  导出经全仓 grep 证实 **零消费**：测试直接导入 `session-uri.js` 的底层函数，
  不经过这些包装。删除 4 个死包装与其 imports（`index.ts`）。
- 删除 `shared/resume.ts` 未使用的 `canonicalMentionOf` 别名。

### 计划契约单点化（P1/P2）

- 新增 `src/shared/plan.ts`：`SessionLogLayout / ResumeSourceInfo / ResumeTarget /
  ResumePlan(Ok|Failure)` 的单一权威定义（Host API 与 client 共用的 wire 契约）。
- `host/resume-plan.ts` 与 `host/session-log.ts` 改为 re-export 共享类型；
  `client/types.ts` 删除重复的 `ResumePlan/ResumeConnection` 本地契约，
  直接引用共享类型。
- `client/resume-executor.ts`：`fetchJson` 泛型化，删除 `as unknown as ResumePlan`
  双转换与一层无意义的外层 try/catch；executor 只消费 `ResumePlanOk`
  （`ok:false` 在 fetch 守卫处即抛错）。

### 其他结构简化（P3–P6）

- `session-log.ts`：快照分支复用 `findSessionRecord`，删除手工二次
  `listSessions` 遍历；`readSessionTitle` 抽出 `titleFromObservation` 早返助手，
  消除 4 层嵌套三元与多处 `as` 断言。
- `snapshot-store.ts`：抽出 `emptySnapshotLayout` 助手，删除两处重复的空布局字面量。
- `workspace-state.ts`：删除永不写入的 `git.branch` 字段与其渲染分支。
- `resume-order.ts`：per-source tail 链 settle 后自删，内存中不再为每个见过的源
  会话保留永久条目（有界）。

### 文档同步

- `reproduction-guide.md` 导出清单改为当前真实导出。
- 本条目记录第二轮结论；上一轮"以测试契约为准"的说法是当时误判。

## 2026-09-01 — 热核审查 P0–P7 收尾（第二轮）

在 P0–P4 处理之上按同一审查清单的剩余发现收尾，`npm run typecheck` PASS、
`npm test` 93/93 全绿、client bundle 构建成功。

### 订单失败归一化（P2 补完）

- `ResumeOrderBook.run()` 的 resolver 若抛异常，不再把拒绝泄漏给调用方：
  统一转换为 `{ ok:false, status:500, error }` 数据并落 WAL 终态 `failed`。
- `complete()` 因此永远面对已 settle 的 plan，不再可能因 plan 拒绝而 500；
  同一 attemptId 的后续 `/complete` 保持返回首终态，幂等语义不变。

### 物化并发单点（P1）

- `materializeSessionLogExport` 的 in-flight 去重键由目标路径（timestamp）改为
  **源会话 id**：同源并发续跑（Header 按钮 + 输入框 Dock、单跑 + 批量）共享
  一次物化，不再竞态写两个快照目录。快照目录仍按时间戳版本化，
  同源每次物化产生新历史版本（版本回滚特性不变）。

### 计划类型合并 + 文本双轨（P0/P5）

- `ResumePlanResult`/`ResumeBatchPlanResult` 合并为单一 `ResumePlan`：
  `ok / attemptId / sources[] / target`，单会话即 `sources` 长度 1；
  `src/host/resume-batch.ts` 删除，`resolveResumeBatchPlan` 并入
  `resume-plan.ts`（`MAX_BATCH_SOURCES` 常量，空/超限/缺失源 fail-closed 不变）。
- 续跑文本统一为 **mention/path 双轨**：计划内每个 source 带官方 canonical
  mention，单会话与批量文本都优先 mention、缺省回退快照路径；
  `batch-text.ts` 增加 `mention` 字段，`resume.ts` 新增
  `buildResumeMentionPromptWithWorkspaceState`（与 path 变体对称）。

### flush 单点（P5）

- `service.ts` 新增 `flushLiveSession` 作为 flush 唯一实现；
  `session-log.ts` 与 `log-materialize.ts` 的重复 flush 全部改为复用。
- `log-materialize.ts` 的 `readPersistence`/`readSessions`/`readQuery` 垫片
  删除，直接使用 `service.ts` 导出。

### API 收敛 + snapshotIds 校验（P3/P6）

- `send()` 删除 object/array 分支死代码：所有 payload 恒为 JSON 对象，
  统一 `{ requestId, ...payload }` 信封。
- `/resume-batch` 的 `snapshotIds` 增加 **键归属校验**：键必须是请求的
  `sessionIds` 子集，悬空键返回 400（fail-closed），不再静默忽略。
- `readSnapshotIds` 改为返回判别联合（`{ok:true,map}` / `{ok:false,error}`），
  与 `runPlanOrder` 的 `{ok:false}` 审计风格一致。

### 可读性（P7）

- `session-url.ts`：模块级正则去掉 `g` 标志（消除跨调用 `lastIndex` 状态），
  全局扫描用 `new RegExp(source, flags + 'g')` 实例；尾部标点集合提取为
  模块级常量。
- `session-path.ts`：`pathStartBefore` 回扫循环补充边界语义注释
  （空格仅在"之前已是合法路径"时作为边界，保留 `C:\Program Files\...` 内空格）。
- `workspace-state.ts`：`WorkspaceManifest.truncated` 增加字段级文档
  （达到深度/条目/超时上界时列表不完整，消费方不得视为全量）。

## 2026-09-01 — 热核审查 P0–P4 一并处理

按用户"一并处理"指令落地热核审查全部发现，`npm run typecheck` PASS、
`npm test` 90/90 全绿、client bundle 构建成功（验证见 WORKLOG 对应会话）。

### 执行器与解析合一（P0）

- 新增 `src/client/resume-executor.ts`：单会话 `/resume` 与批量 `/resume-batch`
  共享同一条执行流（resolve → buildText → create/connect → prompt 有限重试 →
  剪贴板兜底 → 上报终态）。`order.ts`/`batch.ts` 收敛为薄包装（保留对外导出与
  in-flight 去重键）。
- 新增 `src/host/session-log.ts#resolveSourceLog`：快照命中/实时物化统一解析，
  `resume-plan.ts` 与 `resume-batch.ts` 复用同一入口，消除两处重复的分支逻辑。
- 批量续跑补齐 accepted/failed 上报与发送失败重试（与单会话同一 executor 路径）。

### 快照布局与缓存根单点（P1/P2）

- 新增 `src/host/snapshot-store.ts`：安全路径段、缓存根读取、快照目录、
  list/prune、目录创建全部收敛于此；`log-materialize.ts`/`snapshots.ts`/
  `session-log.ts`/`api.ts`/`resume-order.ts` 改为复用。
- `listSessionSnapshots` 由占位空 layout 改为真实读取：根 artifact 文件名
  （`session.jsonl[.zstd]`）、`subagents/` 会话日志数、`media/` 文件数、
  目录 mtime。快照目录不可读时仍安全降级为空 layout，不阻断列表。
- `workspace-state.ts` 删除三个未用包装函数（`workspaceManifestRelativePath`/
  `workspaceGitRelativePath`/`isWorkspaceStateDirName`），调用方直接使用常量。

### 配置与 API 收敛（P3/P4）

- `api.ts` 的 `normalizeConfigPayload` 改为复用共享 `normalizeResumeConfig`
  （fail-closed 单一实现），并删除本地 `readCacheRootSafe` 副本。
- `api.ts` 的 if 链重构为路由表（method+path → handler），404/限流/审计语义不变。
- `ResumeOrderBook.trim()` 接线 WAL `rewrite()`：超过 `MAX_ORDER_ATTEMPTS` 时
  从内存与 `orders.jsonl` 同步裁剪最旧 attempt，WAL 不再无限增长；
  `ResumeOrderWal` 接口补上 `rewrite` 声明。
- Client attemptId 生成：优先 `crypto.randomUUID()`；缺失时回退
  `时间戳-单调计数器`（同一进程内严格单调，不纯依赖系统时钟）。

### 死导出清理（P0/P4）

- 删除 `src/shared/session-uri.ts#decodeSessionUri` 与
  `workspace-state.ts` 三个未用包装；保留被测试契约消费的
  `encodeSessionUriForExport/decodeSessionPayloadForExport/formatMentionForExport`
  与 `createAndPromptResumeSession` 等公共 API。

### 第二轮收敛（同一会话收尾）

- 删除 `src/host/session-info.ts` 与 `src/host/snapshots.ts` 两个薄直通模块：
  `resolveSession/resolveFromText/exportDownloadPath` 并入 `session-log.ts`，
  `listSessionSnapshots` 并入 `snapshot-store.ts`（ctx 读取 + 列表单点）；
  相关调用方与测试导入同步更新。
- `service.ts` 收敛为服务读取唯一入口：新增
  `readSessionQuery/readSessionPersistence/readSessionStore/readAttachments`，
  `session-log.ts` 与 `log-materialize.ts` 的私有 `readXxx` 包装全部走同一实现。
- `src/client/dock.ts` 368 行按职责拆分：共享 UI 件（样式常量、`useTransient`、
  `orderLabel`、`replaceDraft`、`ResumeActionBar`）进入 `dock-ui.ts`；
  `button.ts` 复用同一套件，删除自身重复的 buttonStyle/useTransient/buttonLabel。
- `resume-batch.ts` 源物化由串行 for 循环改为 `Promise.all` 并行，
  失败错误信息保留首个缺失会话 id（测试契约不变）。
- `api.ts` 请求体解析显式收窄：`readJsonObject`（仅 JSON 对象）+
  `readOptionalString` + `readSnapshotIds`，替代旧的无类型读法。
- `workspace-state.ts` 新增 `renderGitStatusText` 单点渲染 git.txt，
  `log-materialize.ts` 复用（原内联模板删除）。
- `log-materialize.ts` 图片引用收集收敛：`collectImageRefs` 为唯一收集器，
  `collectEventImageRefs` 与 `imageRefsInArtifact` 均复用之。
- 修复本次收敛暴露的存量问题：`resume-executor.ts` 未声明 `text` 变量、
  `workspace-state.ts` 的 `node:child_process/promises` 类型在当前
  @types/node 下不可解析（改用 `util.promisify(execFile)`）、
  `src/shared/config.ts` 与 `resume.ts` 补 `RESUME_INSTRUCTION` 再导出
  （测试改为直连 shared 模块后契约需要）。

## 2026-08-29 — 五个扩展方向落地

按用户“全做”一次性实现五个方向，`npm run typecheck` PASS、`npm test` 89/89 全绿
（原 62 + 新增 27）、client bundle 构建成功、真实注入 active、live API 冒烟 9/9 PASS。

### 1. 续跑指令配置化（Direction 2）

- 官方 DSH 无稳定 per-plugin 配置注册表，采用全局 JSON 配置文件
  `%TEMP%\dsh-session-resume\config.json`（原子写：temp + rename）。
- `shared/config.ts`：`ResumeConfig { resumeInstruction?, snapshotRetention? }`，
  `normalizeResumeConfig` fail-closed（非法值回退默认），默认指令仍为冻结
  `RESUME_INSTRUCTION`、retention 默认 10（范围 1–100）。
- Host API 新增 `GET/PUT /session-resume/api/config`（loopback + 限流 + requestId 信封）。
- Client 的 `resolveEffectiveInstruction()` 在构建续跑文本前读取配置；指令缺失时回退冻结文本。

### 2. 快照版本化 + 历史回滚（Direction 1）

- 物化目录从 `<session>\` 改为 `<session>\snapshots\<timestamp>\`；`SessionLogMaterialization`
  新增 `snapshotId`；每次物化后按 `snapshotRetention` 裁剪最旧快照。
- 新增 `GET /session-resume/api/snapshots?sessionId=` 列出历史快照
  （`src/host/snapshots.ts`）。
- `/resume` 支持可选 `snapshotId`：命中则直接用已有快照目录（不重新物化、不重读 raw），
  未命中 fail-closed 404。
- 旧版无 `snapshots\` 层的目录布局仍可被 `listSessionSnapshots` 容忍（测试覆盖）。

### 3. 工作区状态打包（Direction 5）

- 物化快照内新增 `workspace-state/manifest.json`（文件树清单：相对路径/类型/大小/mtime，
  不含文件内容）与 `workspace-state/git.txt`（git HEAD + porcelain 状态）。
- 扫描有界：深度 ≤ 4、条目 ≤ 2000，排除 `node_modules/.git/.dsh/dist/lib/target/__pycache__`；
  缺 cwd、非 git 仓库、超时等失败一律降级为空清单，不阻断续跑。
- 续跑文本在含工作区状态时自动附加读取提示（`buildResumePathPromptWithWorkspaceState`）。

### 4. 多会话批量续跑（Direction 4）

- 新增 `POST /session-resume/api/resume-batch`：`sessionIds`（1–5 个）+ 可选
  `snapshotIds` 映射；每个源独立物化（或按快照复用），目标工作区取第一个可解析源。
- Client 新增 `runResumeBatchOrder` 与 `buildResumeBatchText`（列出全部快照路径）。
- Dock 识别到 2–3 个不同会话时出现“批量续跑 N 个”按钮。

### 5. 订单持久化 + 失败重试（Direction 3）

- `src/host/order-wal.ts`：追加式 `orders.jsonl`（append-only、最新行胜出、容忍坏行），
  `ResumeOrderBook` 支持可选 WAL，`loadFromWal()` 重启恢复终态 attemptId。
- 恢复的终态对 `/complete` 保持幂等（首终态不变）。
- Client 发送失败有限重试：最多 3 次、500ms 起指数退避，仍失败则复制指令到剪贴板并回报 failed。

### 实测中发现并修复（运行时回归）

- 注入时插件启动失败：`cannot get property "resumeCacheRoot" without inject`。
  根因是 `api.ts` 新增的 `FileResumeOrderWal(ctx.resumeCacheRoot)` 直接读
  getter-only 运行时 facade 的未注入属性。修复：`readCacheRootSafe()`（try/catch 吸收），
  `session-log.ts` 的 config 读取同样防御化。修复后 `dev_inject_plugin` host + client 均 active。
- workspace 扫描递归改用固定 baseRoot 计算相对路径，避免子目录条目变成裸文件名
  （Windows 反斜杠已由测试规范化处理）。

### 可复现验证

- `scripts/smoke-api.mjs`：对运行中 DSH web 的 live 冒烟（配置往返、快照列表、批量守卫、
  404 兜底），本会话实测 9/9 PASS 并还原默认配置。
- 新增测试文件：`config`、`snapshots`、`workspace-state`、`batch`、`order-wal`（共 27 断言）。

## 2026-08-29 — 续跑指令冻结 + client 槽位注册写法适配

### 续跑指令（用户三轮推敲后的终版，单一事实源）

- `RESUME_INSTRUCTION` 统一为：

  `请继续这个会话：直接读取上述日志快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续。若快照缺失或不可读，请如实说明。`

- 该文本只存在于 `src/shared/constants.ts`（唯一事实源）；`src/client/order.ts` 删除原本
  硬编码的措辞不同副本，改走共享的 `buildResumePathPrompt(plan.source.path)`；
  `src/client/dock.ts` 原本就走共享层，未改。
- 新增测试 `locks the exact resume instruction text so wording cannot drift`，
  直接断言 `RESUME_INSTRUCTION` 全文，任何未来措辞改动必须先动测试。

### client slot 注册写法适配（配合 super-injector 预检）

- 背景：`dev_inject_plugin` 预检的 `register({ name: ... })` 正则要求 `register({` 与
  `name:` 同对象紧邻；本项目原先写成 `register(\n  { name: ... },\n  Component)` 的
  换行展开风格，被预检判为"缺合法 name"而拦截（实测拦截信息与
  `injector/src/index.ts` 的 `KNOWN_SLOTS` 校验一致——名单本身已涵盖
  `conversation.session.header.utilities` 与 `conversation.input.dock`，非名单遗漏）。
- 决策：不改 super-injector（其白名单是有意的安全闸门，防 typo；放宽正则属于风险面
  扩张且该校验无单测），而是把本项目 `src/client/index.ts` 两处 `ctx.slots.register(...)`
  改为 `register({ name: ..., ... }, Component)` 紧邻形态，与官方 scaffold 模板风格一致，
  语义与契约零变化。
- 已验证：`dev_inject_plugin` 不再拦截（返回"已激活运行"而非 ERROR）；`npm run typecheck`
  PASS；`npm test` 62 全绿（含新增冻结测试）；`lib/client.js` 重新构建含新槽位形态。

## 2026-08-28 — 可靠性加固与实测

### 安全闸门（fail-closed）

- 日志工件文件名只允许单层安全文件名，拒绝 `.`、`..`、路径分隔符、绝对路径和超长文件名。
- Host API 的 loopback 校验改为 fail-closed：远程地址缺失时拒绝访问。
- 绝对导出 URL 必须命中 `/api/session.export` 路径，不再误识别任意带 `sessionId` 的 URL。

### 订单语义

- 新增 `attemptId` 幂等、同一源会话计划串行、内存终态保存。
- 新增 `POST /session-resume/api/complete`：客户端回报 `accepted/failed` 与 `targetSessionId`。
- 审计链补齐 `requestId`、`remoteAddress`、`sourceSessionId`、`targetWorkspaceId`、
  `targetSessionId` 与终态。
- Client 按 `sessionId` 共享执行 Promise，Header 与 Dock 双击不会重复下单。

### 可复现性

- `npm test` 改为先构建再测试，干净 checkout 可直接运行。
- Host 路径测试与续跑计划测试改用独立临时根目录，不污染真实缓存。
- 新增订单幂等、安全边界、恶意 URL 回归测试。

### 实测中发现并修复

- 真实 `/resume` 首次返回 501：`cannot get property "resumeCacheRoot" without inject`。
  根因是 Cordis 运行时 Context 为 Proxy，读取未声明服务属性会抛错。
  修复为先用 `Reflect.has` 探测测试专用缓存根，并补充运行时 Proxy 回归测试。

### 已验证事实

- 物化目录与官方 export ZIP 解压结果逐字节一致（含根 artifact、`subagents/`、`media/`）。
- 同刻官方 export（`/resume` 后立即下载）仍逐字节一致。
- 源会话新增唯一标记后 `/resume`，物化根日志包含该标记（新鲜度）。
- 新会话实际读取物化目录并回复 `E2E_RESUME_OK`。
- 三层后代目录与官方 ZIP 逐字节一致。
- PNG 附件物化为 `media/sha256_<digest>.png`，与官方 ZIP 解压结果一致。
- 真实 GUI 点击“自动续跑”：新会话在原工作区打开并收到续跑指令，`/complete` accepted。
- 真实限流：窗口内超限请求返回 429。

## 2026-08-28 — 代码质量加固

按热核审查发现逐项修复，全部通过 `npm run typecheck` + `npm test` + `npm run build`。

- **React Rules of Hooks 违规**：`ResumeDock` 拆为两个叶子组件（纯函数 + hooks 无条件调用），
  消除条件早返回导致的 hook 数量漂移。
- **`@ts-nocheck` 移除**：client 全量类型检查；移除悬空的 `SlotsService` 导入；
  修复被掩盖的 `TS2554` 参数数量错误；client 拆为多文件。
- **`agent/pre-step` 的 `any`**：替换为 `PreStep*` 最小接口。
- **重复 `readXxx` 模式**：收敛到 `src/host/service.ts` 的 `readService`。
- **补 CI**：`.github/workflows/ci.yml`（`npm ci && npm run typecheck && npm test`）。

## 2026-08-28 — 工作区目录构造

按四维标准（简洁/透明/可复现/边界清晰）重组：

- `dist/`（发布 tgz）从 git 移除并加入 `.gitignore`；`lib/`、`dist/`、`node_modules/` 均为可再生产物，不入版本库。
- `release.ps1` 不再提交发布产物，走 `npm pack` 生成。
- 文档统一收进 `docs/`：`VERIFICATION.md` → `docs/verification.md`；`docs/verification/` → `docs/evidence/`。
- 新增 `docs/README.md` 文档索引。
- 技术选型理由写入架构文档 §4.1（ts 而非 tsx/js）。