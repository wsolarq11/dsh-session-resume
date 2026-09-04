# 工作日志 — 2026-08-29 会话

本次会话围绕 `@dsh-external/dsh-session-resume` 的续跑指令审查、注入链对齐与发布评估展开。
决策与已验证事实同步于 `docs/CHANGELOG.md`；本文件记录过程、调查与权衡，供追溯。

## 2026-09-02 — 装配通道一致性修正（bundle 与 super 互斥）

- 早期日志“profile 已把插件写入 dsh.profile.bundles，但暂不做 dsh.bundle 发布准备”会制造
  `dsh web` 启动失败：profile 引用 bundle-less 包时报 `declares no dsh.bundle`；补上 bundle
  声明后，若 super registry 仍存在同一包，又会报 `duplicate prefix route`。
- 已定：本插件当前走 super 通道，profile bundles 不引用本包；两通道必须互斥。
- 活文档已同步：README、架构、复现指南、验证报告；本日志旧条目中的 profile bundle 表述
  不再作为操作指引。
- 热核审查后处理：`cordis.patch.yml` 已加入 npm `files` 并实测随包存在；安装器重叠预检
  移到 profile 初始化前，registry 读取收敛为共享 helper。
- 实测热重载：`dev_reload_package` before/after 均 active，`/session-resume/api/config` 200，
  client bundle 200。清理生成物后提交并推送 `origin/master`。

## 2026-09-02 — 热核审查第三轮修复（过程与验证）

- 第二轮审查 P0–P2 一并处理，先改核心结构，再补回归测试，最后同步文档。
- 关键取舍：
  1. 501 透传改为 `resolveSourceLog` 直接返回 `SessionLogPathResult`，不再用 `null`
     抹掉错误状态；单/批量计划都按真实状态失败。
  2. client 外层重试删除而不是修修补补：resolve/connect 只执行一次，prompt 在同一
     `newId` 上重试，避免发送失败后重复建会话。
  3. `safePathSegment` 改为安全 ID 原名 + 非安全 ID 的 `~<sanitized>_<sha256>`，
     代价是非安全附件/子代理不再与官方 ZIP 同名，文档已明确限定字节级一致性范围。
  4. 快照 ID 从时间戳改为存储态整数序号，避免时钟跳变影响历史回滚顺序。
- 验证：`npm run typecheck` PASS；`npm test` 97/97 全绿；client bundle 构建成功。
- 收尾：按用户要求清理 git 工作树与生成目录（`.verify/`、`dist/`、`lib/` 等），
  暂存全部源码/测试/文档后提交并推送 `origin/master`。

## 2026-09-01 — 热核审查 P0–P7 收尾（过程与权衡）

在前述 P0–P4 已落地的未提交工作树上继续，把审查清单剩余项与补完项一并处理。
约束：全程保持 `npm run typecheck` 干净 + `npm test` 全量全绿（验证在阶段 3）。

### 关键取舍

1. **run() 抛错转数据而非补丁式 try/catch**：审查 P2 的核心不是"complete 加
   catch"，而是"plan 拒绝不应成为控制流"。把 `ResumeOrderBook.run()` 的 resolver
   异常统一转换为 `{ok:false,status:500}` 数据并落 WAL，`complete()` 不再需要
   任何异常分支，调用方（/complete 路由）也永远拿到已 settle 的 attempt。测试
   用"throwing resolver 的 run 返回 `{ok:false}`"锁定该契约。
2. **计划类型合并的边界**：`ResumePlanResult`/`ResumeBatchPlanResult` 合并为单一
   `ResumePlan`（`sources[]`，单会话长度 1）。单会话的 fail-closed 语义
   （无 cwd → 409、workspace registry 缺失 → 501）由 `resolveResumePlan`
   直呼 `resolveResumeWorkspace` 保留（复用其原始判别），批量才用
   `resolveFirstWorkspace` 的"首个可解析源"逻辑。测试
   `resume-plan.test.mjs` 的 409/501 断言验证该边界。
3. **mention/path 双轨的朝向**：续跑文本优先官方 canonical mention，缺省回退
   快照路径。理由：mention 是官方第一公民（pre-step 改写同款），路径只是
   Host 本地的物化兜底；两者文本构建器在 `shared/resume.ts` 成对提供，
   不引入"二选一"的 if 分叉在业务代码里。
4. **inflight key = 源会话，不是内容寻址**：审查 P1 要的是"同源并发去重"，
   不是"去重快照版本"。快照版本化（时间戳目录 + retention）是已交付特性
   （历史回滚），内容寻址会抹掉版本语义；因此 key 改为 `sessionId`，目录仍按
   时间戳版本化，同源并发共享一次物化 + 各自版本。测试用并发两次物化 +
   traceCalls===1 锁定。
5. **snapshotIds 校验放 API 层**：`readSnapshotIds` 改为判别联合返回，校验键
   必须是 `sessionIds` 子集；`resolveResumeBatchPlan` 保持纯函数不收校验逻辑，
   测试经 `registerResumeApi` 路由断言 400。
6. **client 执行器重试语义**：P4 的"整体有界重试"在 bundle 内、无 node 单测
   入口（`npm test` 只测 lib/ 共享/服务层）。以类型 + 构建 + 既有共享层测试
   覆盖，重试契约以代码注释与 README 记录；集成验证走真实注入
   （verification.md 既有流程）。
7. **/complete 审计不回滚**：`runPlanOrder`（计划 resolved/failed）与
   `/complete`（终态 + durationMs）是两个阶段的两条审计，不是重复；
   complete 从 order 状态读取 sourceSessionId/targetWorkspaceId，无重推导。

## 2026-09-01 — 热核审查 P0–P4 一并处理（过程与权衡）

前置：8-29 会话产物已含 89 断言（62 + 27）与完整五个方向；本次按热核审查
综合报告（`docs/thermo-nuclear-review-consolidated.md`，原 `code-quality-assessment.md` 的
P0–P4 清单已折叠其中）一次性落地。约束：过程全程保持 89 断言全绿 + `typecheck` 干净（验证在阶段 3）。

### 关键取舍

1. **"死导出"以测试契约为准**：`encodeSessionUriForExport/decodeSessionPayloadForExport/
   formatMentionForExport/createAndPromptResumeSession` 曾被审查列名，但当时判断
   `tests/session-uri.test.mjs` 与 `tests/resume.test.mjs` 直接导入并断言，属公共 API
   契约而非死代码。实际删除仅：`decodeSessionUri`（零引用）、workspace-state 三个
   单行包装（`join` 导入随之移除）。其余 index re-export 保留。
   （**2026-09-02 第二轮纠正**：复核证实测试直接导入的是 `session-uri.js` 底层
   `encodeSessionUri/decodeSessionPayload/formatMention`，`ForExport` 包装与
   `resumeInstruction` 零消费，已在第二轮删除。当时的"测试契约"判断是误判。）
2. **client 执行器合一的边界**：把单/批量共用的"resolve → buildText → connect →
   prompt 重试 → 剪贴板兜底 → 上报终态"收敛到 `resume-executor.ts`；`order.ts`/
   `batch.ts` 保留各自的 in-flight 去重键（header/dock 双击防重仍需按源区分），
   `buildText` 作为策略注入保证两流程文本格式仍各自独立。
3. **snapshot layout 从占位变真实**：原 `listSessionSnapshots` 返回
   `layout {root:'', ...}` 占位；现 `snapshot-store.ts` 真实读目录（根日志文件名、
   `subagents/*.jsonl` 计数、`media/*` 计数、目录 mtime），不可读时降级空值不阻断。
4. **WAL 重写只在超限时发生**：`trim()` 改 `trimAndRewrite()`，仅在 attempt 数 >
   `MAX_ORDER_ATTEMPTS` 时触发 `wal.rewrite(remaining)`；`ResumeOrderWal` 接口补
   `rewrite` 声明（之前实现已有但接口缺声明，属隐藏编译缺口）。
5. **attemptId 单调回退**：`crypto.randomUUID()` 缺失时不再是裸 `Date.now()`
   （同毫秒碰撞），回退 `时间戳-计数器`。按 AGENTS"时间不可信"规则，幂等键不纯靠时钟。

### 过程记录

- 先读全量现状（api/materialize/session-log/resume-* 等），复制审查清单进 todo。
- 逐项落地：config 归一化 → snapshot-store 抽取 → materializer/snapshots 复用 →
  resolveSourceLog → executor 合一 → batch 上报 → WAL 接线 → 死导出清理 →
  路由表化 → attemptId 回退 → 文档同步。
- 验证（阶段 3）：`npm run typecheck` 干净 + `npm test` 89/89 + client bundle 构建。

### 第二轮收敛（2026-09-01 收尾）

继续按同一审查清单的剩余项做薄层收敛，全部在阶段 3 再次验证：

1. **薄直通模块删除**：`session-info.ts` 与 `snapshots.ts` 只有一行转发，纯抽象租金。
   `session-info` 的三个函数并入 `session-log.ts`（共享同一批 record/title/query 读取）；
   `snapshots` 的 ctx 级 helper 并入 `snapshot-store.ts`。两文件连同编译产物直接删除，
   无任何引用残留（grep 全仓验证，测试导入同步改）。
2. **service.ts 收敛边界**：把散落在 `session-log.ts` 与 `log-materialize.ts` 的
   `readSessionQuery/readPersistence/readSessions/readAttachments` 私有包装全部改为
   复用 `service.ts` 的四个导出。过程中踩到两个自递归陷阱（本地函数与导入同名时
   TS 静默绑到自己），最后以"导入即用名 + 仅保留窄化包装"收敛。教训：同名遮蔽在
   重构中比缺名更隐蔽。
3. **dock.ts 拆分**：368 行含样式常量、hook 工具、两个叶子组件与工厂。拆出
   `dock-ui.ts`（样式/useTransient/orderLabel/replaceDraft/ResumeActionBar），
   `button.ts` 同步复用（删除自身重复的 buttonStyle/useTransient/buttonLabel —
   原 buttonLabel 默认"自动续跑"与 dock 的"一键续跑"不同，用 idleLabel 参数化）。
4. **验证阶段暴露的存量缺陷**（非本轮引入，但被本轮首次全量 typecheck 抓住）：
   - `resume-executor.ts` 的 `text =` 漏了 `const`（TS2552，之前从未报错疑因
     构建/类型解析差异）。
   - `workspace-state.ts` 动态导入 `node:child_process/promises` 在当前 @types/node
     24.13.3 下无类型声明（TS2307），改 `util.promisify(execFile)`（行为等价）。
   - `tests/config|resume` 直连 shared 模块后缺 `RESUME_INSTRUCTION` 导出，
     在 `config.ts`/`resume.ts` 补再导出（单一事实源仍为 constants.ts）。
   - `useTransient` 泛型化：`Dispatch<SetStateAction<T>>` 签名，button/dock 通用。
- 终态验证：`npm run typecheck` PASS + `npm test` 90/90（89 基线 + 前一轮新增
  workspaceId 偏好测试）+ client bundle 构建成功。

## 1. 续跑指令：三轮推敲 → 冻结

- 原始指令存在三个结构性缺口：自动流程的"上面引用的"指代落空（路径与指令仅以空格拼接，
  不存在引用机制）；自动/手工入口文本不一致（`order.ts` 硬编码副本与共享常量措辞分叉）；
  无"快照缺失"失败分支。
- 经三轮"有必要吗/经得起推敲吗"推敲，最终冻结为一句话版本：

  `请继续这个会话：直接读取上述日志快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续。若快照缺失或不可读，请如实说明。`

- 落地：`src/shared/constants.ts` 为唯一事实源；`src/client/order.ts` 删除硬编码改走
  `buildResumePathPrompt`；`tests/resume.test.mjs` 新增全文冻结断言。
  验证：`npm run typecheck` PASS，`npm test` 62 全绿。

## 2. 注入链：预检拦截不是名单遗漏，是正则形态假设

- `dev_inject_plugin` 拦截报"slots.register 缺合法 name"。调查 super-injector 源码：
  `KNOWN_SLOTS` 白名单**已含** `conversation.session.header.utilities` 与
  `conversation.input.dock`，注释明确白名单是 2026-08-14 事件沉淀的"防 typo"安全闸门
  （设计使然，非疏忽）。
- 真实原因是预检正则 `register({[\s\S]*?name:` 要求 `register({` 与 `name:` 同对象紧邻；
  本项目原有的换行展开写法不匹配。检索两个源仓 issues/PR
  （injector 28 issues + 14 PR；routing-suite 75 issues + 25 PR）：**无任何条目涉及
  白名单缺槽位或正则形态**——无先例。
- 决策：不改 super-injector（白名单是安全设计；放宽正则属风险面扩张且该校验无单测），
  改为本项目 `src/client/index.ts` 两处 `register({ name, ... }, Component)` 紧邻形态，
  与官方 scaffold 模板风格一致、语义零变化。改后 `dev_inject_plugin` 不再拦截。

## 3. 加载状态核实与热装配

- 询问"是否已加载"时，插件实际未加载（8-28 重启被 self-heal 跳过恢复，Host API 404）。
- 经 `dev_install_package` 热装配（profile link + bundles + junction + loader.create）：
  Host API 由 404 变为 400（"sessionId 必填"），实证 Host 端生效；client bundle
  需浏览器刷新后加载新版。
- 注：插件已 active 后再次 `dev_inject_plugin` 返回"已激活运行，跳过注入"。

## 4. 注入器盈亏与发布评估（结论：不动）

- "为何依赖 super-injector"：开发期免重启热循环（改-载-验）值得；生产/发布并不依赖它——
  profile 已把插件写入 `dsh.profile.bundles`，重启后官方装配链接管。
- 官方一键安装机制实测：`dsh plugin --profile web add <pkg>` = pnpm forwarder +
  bundles reconcile；仅当依赖声明 `dsh.bundle.patch`（如 chat-timeline 的
  `cordis.patch.yml`）时才会被写入 bundles 装配。
- 若发布 npm 需补三项：`cordis.patch.yml` + `dsh.bundle.patch` + `files` 含 patch
  （另建议 LICENSE 与 repository 元数据）。
- **最终决定：保持现状，不做上述发布准备**（无发布意向；本地开发 `dev_install_package`
  足够）。`exports`、`cordis.patch.yml`、`LICENSE`、`repository` 均不改动。

## 5. 本次改动文件清单（git 工作区）

- `src/shared/constants.ts` — 续跑指令终版（唯一事实源）
- `src/client/order.ts` — 去硬编码，改走共享构建器
- `src/client/index.ts` — register 紧邻形态（预检兼容，语义零变化）
- `tests/resume.test.mjs` — 指令全文冻结测试
- `docs/CHANGELOG.md` — 决策与验证留痕（新增 2026-08-29 小节）
- `docs/session-resume-architecture.md` — 续跑文本示例同步
- `docs/reproduction-guide.md` — 续跑文本示例同步（该文件此前未纳入版本控制）

> 注：`README.md`、`docs/README.md` 的修改为既有未提交内容，非本次会话改动。

## 6. 遗留事项（均经确认不执行）

- 发布 npm 的三项准备（`cordis.patch.yml` / `dsh.bundle.patch` / `files`）
- LICENSE 文件与 repository 等发布元数据
- `exports` 补充 `./cordis.patch.yml`（指向不存在文件，无意义，明确不做）
- super-injector 预检正则放宽（工具侧债务，留待作者在有测试保护时演进）

## 7. 续跑指令再推敲：否定句 → 全正向（用户主导，落地）

- 用户质疑「无需向用户索取日志」的必要性。审查结论：该否定句在无人值守自动续跑时序（
  `session.prompt(..., 'queue')` 首条且唯一消息）下防的是 LLM 最强错误默认（向用户索取
  日志），原本有必要；但用户要求改为全正向表述，经两轮确认终版为：

  `请继续这个会话：直接读取上述日志快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续。若快照缺失或不可读，请如实说明。`

- 落地：`src/shared/constants.ts` 改 `RESUME_INSTRUCTION`（唯一事实源）；`tests/resume.test.mjs`
  冻结断言同步；`docs/CHANGELOG.md`、`docs/WORKLOG.md`、`docs/session-resume-architecture.md`、
  `docs/reproduction-guide.md` 示例同步。`src/client/order.ts`、`src/client/dock.ts` 走共享
  构建器，无需改动。
- 验证：`npm run typecheck` PASS；`npm test` 62 全绿（含冻结断言）；`lib/` 产物已含新措辞，
  grep 无旧文本残留。

## 8. 后台 bash bug 调查（环境级，结论：不改任何代码）

- 现象：调试中用 `bash` + `run_in_background` 跑 `npm test` 后，`job_output` 报
  `proc.readOutput is not a function`；`job_kill` 报 `proc.kill is not a function`。
- 实测映射（全部实测确认）：
  - 后台 bash（`bash-5`）：`job_output` 必炸（读不到任何输出）——受 `bash-6`(60s) 验证
    `job_kill` 也炸（进程杀不掉，只能等自然结束）；
  - 后台 bash 完成通知正常送达（`[status: completed]`）、`job_list` 正常；进程照常跑完，
    信息未丢只是读取通道坏了；
  - 后台 pwsh（`pwsh-2`/`pwsh-3`）：`job_output` 正常；前台 bash 正常（完整输出+stderr）。
- 根因（提交史闭环）：agent preset `router-standard` 在 win32 装配私有 `gitbash-executor`
  （`~/.dsh/.agent-presets/router-standard/gitbash-executor.mjs`，源码在
  `D:\AI\dsh-plugins\dsh-routing-suite`），其 `start()` 只返回 `{ done, pid, collected }`，
  缺 `readOutput()/kill()/status` 等 `ShellProcess` 契约方法；`dsh-tool-bash` 后台路径按
  官方契约消费 → 必炸。作者从 `liceses/dsh-gitbash-preset`（@icelily/dsh-gitbash-preset，
  MIT）重写引入时砍掉了后台支撑（原版 347 行含完整 start()，作者版 116 行仅前台 run()）；
  `fix(bash)` 提交只补了 `run()` 的 signal 一行，`start()` 从未被动过。
- 源仓 issue/PR 检索：`yjh051108/dsh-routing-suite` 全部 78 条 discussion 无一条涉及
  后台 bash/readOutput/job_output；作者参与度 31%（23/75），外部 PR 零合并（唯一 merged 的
  #62 是作者自己），近期（8-25 后）潜水。
- 结论（用户拍板）：**不改 dsh-routing-suite、不提供 upstream PR**。该 bug 是环境级、
  跨项目存在，但只影响「后台 bash 取输出」这一种操作；插件全部功能路径不碰 shell。
  规避路径现成（前台 bash / 后台 pwsh / 换 preset——router-spec 在 win32 无此 bug，
  PTC 模式已被作者退役）。不影响交付。

## 9. 五个扩展方向：全做（2026-08-29）

- 用户在「目前功能？还能做啥？」之后对五个建议方向答复「全做」：
  ①续跑指令配置化 ②快照版本化+历史回滚 ③订单持久化+失败重试 ④多会话批量续跑
  ⑤工作区状态打包。经问询确认：配置为全局单份（非 per-workspace）、默认保留 10 份快照、
  工作区打包只做「文件树清单 + git 状态」不含文件内容。
- 落点：新增 `src/host/{order-wal,snapshots,workspace-state,resume-batch}.ts`、
  `src/shared/{config,batch-text}.ts`、`src/client/batch.ts`；改动
  `log-materialize`（快照目录+裁剪+workspace-state）、`resume-plan`（snapshotId +
  workspaceState）、`session-log`（目录层+配置）、`api`（config/snapshots/resume-batch 路由 +
  WAL 接线）、`resume-order`（WAL 化）、`dock`（批量按钮+异步指令）、`order`（指令读取+发送重试）。
- 测试：`config`、`snapshots`、`workspace-state`、`batch`、`order-wal` 五个新文件，
  共 27 新断言；全量 89 断言 PASS。
- 实测抓到的真回归：重新注入时插件 failed，根因 `api.ts` 的
  `new FileResumeOrderWal(ctx.resumeCacheRoot)` 直接读运行时 getter-only facade 未注入属性
  （`cannot get property "resumeCacheRoot" without inject`）。修复为 `readCacheRootSafe()`
  吸收异常 + `session-log.ts` 配置读取同样防御化；修复后注入 host+client 均 active。
- 实测中第二个真 bug：workspace 扫描递归用子目录做 relative 基准，导致子目录内文件
  变成裸 `main.ts`；改固定 baseRoot 计算。Windows 反斜杠由测试侧规范化断言。
- 集成验证：`curl` 实测 config GET/PUT、snapshots、resume-batch 守卫、未知路由 404；
  固化到 `scripts/smoke-api.mjs`（对运行中 DSH web 的 live 冒烟，9/9 PASS，结束还原默认配置）。
- 浏览器依赖（EALLOWSCRIPTS 禁止安装 playwright）与本地无独立浏览器 exe 前提下，
  页面级视觉证据以「client bundle 注入成功 + host active + live API 全路由 200」替代，
  残余风险已记录在 verification.md。

## 10. 交付门禁：read_image 环境阻塞（2026-08-29）

- 代码、测试、注入、live API 全部就绪后，delivery_check 唯一 FAIL 项是 `page-verify`：
  要求 bash headless 截图 + read_image 人工复核（reviewed:true）。
- 已用真实 Chromium（CentBrowser Portable）headless 完成截图（2100×1350、75% 非白像素，非白屏）
  与 DOM dump（305 KB，含插件 client 模块注册表），client bundle 真实 URL 200。
- 但 `read_image` 对当前模型 `deepseek-v4-flash-0731` 返回
  `model does not declare image input`（子代理同）——图像输入能力不在本运行时。
- 结论：页面视觉复核的"读图"步骤是本环境硬阻塞，无法在模型内完成；等价证据（DOM+像素+bundle）
  已全部固化到 `.verify/`，交付检查需换支持图像的模型后补做 read_image 复核。

- 用户决策（2026-08-29）：接受等价像素/DOM 证据放行 page-verify，不再等待换模型补读图；
  环境限制豁免已记录。
