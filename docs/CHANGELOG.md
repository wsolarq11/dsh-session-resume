# 变更记录（ChangeLog）

本文件是**活文档**：上层为“当前为真”，下层为“演变史”。不写时间戳、测试数量、行数、逐会话轮次——
它们会随岁月漂移；这里只保留**仍生效的能力/不变量** 与**发生过、需要被记住的决策**。
当前是否生效（例如传输是 typert 还是曾被删的 HTTP）以**源码为准**；本文不记录“当前不生效的描述”。

> 每份文档的边界、读者与更新约定见 [docs/README.md](README.md)。

## 当前状态（激活）

插件现在是一层薄域服务：Host 暴露 `SessionResumeService`（typert `@Remote`，9 端点），
Client 经 `ctx.remote.sessionResume.*` 直调，无自建 HTTP。核心能力与不变量：

- 续跑：一次点击把“物化目录 + 锁定原工作区 + 新会话创建/复用 + 发送续跑指令”完成。
- 计划：`resolvePlan` / `resolveBatchPlan` 返回 `{attemptId, sources[], target}`；同 attempt 幂等。
- 终态：`completeResume(accepted|failed)` 幂等、冲突返回当前终态、WAL 落盘、重启恢复。
- 配置：`getConfig`/`setConfig`（`resumeInstruction` + `snapshotRetention`，原子写）。
- 快照：`listSnapshots`；按存储序数保留最新 N 份。
- legacy 兼容：旧 export URL / `dsh-session:` 兼容；`agent/pre-step` 改写为 mention。

> 完整契约与不变量见 `docs/session-resume-architecture.md`；可复现验证命令见 `docs/verification.md`。

## 演进史（决策 + 不变量，不含时间戳）

以下按“发生次序”记录**仍值得记住**的取舍。每条保留其约束/不变量，不记会话与当天日期。
已声明“淘汰”的形态不会回到当前层，属于防失真标记。

### 1. 传输层：从自建 HTTP 迁到 typert typed-remote（重大）
- 曾一度用 `webServer.register(/session-resume/api/*)` + loopback + 限流 + JSON 分发 + 客户端裸 `fetch`。
- 现状（淘汰 HTTP）：Host 改为 `SessionResumeService extends TyperRemoteService`；Client 经
  `remote.$mount(TYPERT_REMOTE)` + `remoteFacade` 调用 `ctx.remote.sessionResume.*`。
- 不变量：**不再有 `/session-resume/api/*`**；任何这样的 URL 都证明文档已落后源码。
- 决策：删除自建 HTTP / 路由 / 限流，改为平台级 tyert 传输；`completeResume` 含 WAL + 审计。

### 2. 续跑指令（冻结并唯一事实源）
- 续跑文本的权威定义在 `src/shared/constants.ts` 的 `RESUME_INSTRUCTION`；由 `tests/resume.test.mjs`
  冻结断言，措辞改动必须先改测试。
- 不变量：任何流程的续跑提示都经 `buildResumePrompt`（`shared/resume-text.ts`）拼前缀，且不复制措辞。

### 3. 快照、版本化与保留
- 物化目录分层 `snapshots/<snapshotId>/`；快照 id 用存储序数（不依赖时钟）。
- 保留 `snapshotRetention`（默认 10）裁最旧；`listSnapshots` 可回滚历史。
- 非安全 ID 用 `~<sanitized>_<sha256>` 防碰撞映射；全安全字符 ID 保持原名。

### 4. 订单持久化 + 失败重试 + 幂等
- `attemptId` 幂等；`ResumeOrderBook` + `orders.jsonl` WAL：同源并发去重、串行、重启后终态恢复。
- Client 发送有界重试（≤3 次、指数退避），失败复制到剪贴板；不因发送失败重复建会话。
- 决策：WAL 保留（唯一能力是跨启动裁定终态与可审计）；纯内存编排也能通过幂等测试，但跨重启不行。

### 5. 多会话批量续跑
- `resolveBatchPlan(sessionIds, attemptId, snapshotIds)`：`sessionIds[0]` 为主键串行；上限与官方一致。
- `snapshotIds` 键必须是 `sessionIds` 子集（悬空键 400）。

### 6. 工作区状态打包与 legacy 根修
- 快照含 `workspace-state/manifest.json`（文件树清单，不含内容）+ `git.txt`；有界（深度/条目）。
- legacy 旧会话（缺 `message.id`）：续跑文本走**快照路径**而非 `dsh-session:` mention——
  mention 会重触发 fragile 的 surface 读并拒绝“lacks an identified message”；路径路由是持久根修。

### 7. 质量基线（一处来源）
- 单一质量治理文件：`docs/thermo-nuclear-review-consolidated.md`（原则与不变量，无轮次号/行数/测试数字）。
- `npm run typecheck`、`npm test`、`npm run build` 是固定验证命令（不清仓）。

### 8. 已淘汰 / 防失真说明
- HTTP 传输层：已删（见上 §1）。任何“`POST /session-resume/api/...`”写法属于历史，勿按它重建。
- 曾存在的 `smoke-api.mjs` / `api-security.test.mjs` / `rate-limit.test.mjs`：已随 HTTP 一并移除。
- `src/typert-meta.d.ts` 为单包协议面，供 generator 与 client type-face 解析；别手工增删导出。

## 下一步 / 已知待办（当前未完成，非失效历史）

- 单位判断、统计口径等不在此记录；若某项是“当前待办”，则会由源码或本文件“未完成”小节承载。
- 当前无未决重大设计变更；若有会在此列为“进行中”，并随完成转为“当前状态”。