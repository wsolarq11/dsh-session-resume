# 热核质量治理（原则 + 当前状态）

这是本项目质量治理的**单份汇总**：保留跨改动沉淀的**普适原则**（"举一反三"）与**当前仍成立的发现状态**。
不含轮次编号、行数、测试数量、时间戳——那些会漂移；只写"写代码前应 grep 的规则"与"当前既成事实"。
凡与当前源码冲突，以源码为准；"当前状态"由 `npm run typecheck` / `npm test`（见底）共同核验。

---

## 1. 总体判断（当前）

- 树保持健康：无结构回归、无文件冲向 500/1000 行边界、无 spaghetti 分支增长。
- 分层诚实：纯文本在 `shared/`，Host I/O 在 `host/`（经 `SessionResumeService` 委托给纯域核心），
  浏览器接线在 `client/`（`remote.$mount` + `remoteFacade`）。
- canonical helper 单一源：`safePathSegment`、`readService`、`readRequiredToken/readOptionalToken`、
  `retryWithBackoff`、`isResumePlan`、`buildResumePrompt`、`collectImageRefs`、`createResumeExecutorScope`。
- 幂等、WAL 恢复、有界重试、审计、fail-closed 媒体处理齐备且有测试。

## 2. 治理原则（跨改动沉淀，写新码前 grep）

**P1 规则单源且用对模式**：不要只删重复，还要让每个调用方选对变体（必填 vs 可选、
`string` vs `string | undefined`），让类型与分支一起消失，而非复制规则。

**P2 删整概念，不重排**：每个抽象都问"它防住了什么具体的失败？"答不出就删。克制的次数是
删除而非打磨。

**P3 每个关注点要有唯一家，边界切分编排与业务**：`shared/plan.ts` 持有唯一 wire 契约；追求
每个服务/门面读取收敛到 `service.ts`；新代码进所属层，不就近塞。

**P4 无可耐何 fail-closed 且跨边界保留真实 status/error**：未知媒体跳过+记录（不生成 `.undefined`）、
不可读快照 `readable:false`、源日志失败以 `404/501` 传递而非压平成 `404`；降级读降级为"无法解析"，
永不伪造成功。

**P5 幂等与排序不信任墙钟**：快照用存储整数序数（非 `Date.now()`）；attempt id 回退是 per-scope
单调计数器；WAL 追加式、latest-wins；`completeResume` 幂等且有界。

**P6 模块级可变状态放进显式 scope**：用 `createResumeExecutorScope()` 给每个 host 环境确定性
attempt id 序列与 in-flight 去重，UI 调用签名不变；默认保留单实例行为。

**P7 文档诚实是质量信号，过期数字是 trust 债**：陈旧注释/过时契约描述会让未来读者信错方向——
正因为此，文档系统要求"当前为真"（见 `docs/README.md`）。

**P0 每次改动附回归测试 + 保持全绿**：`npm run typecheck` + `npm test` + `npm run build` 是固定验证命令。

## 2. 当前发现状态

状态：已解决（有回归测试）· 有意保留（文档化）。

### 2.1 结构 / 边界
- `shared/plan.ts` 单一 wire 契约；host `config`/`cache-root` 归 host；浏览器接线归 `client/resume-client.ts`；
  纯文本在 `shared/resume-text.ts`。 ✅
- 单一 `isResumePlan`（WAL + remote 共用）✅
- 一个 `buildResumePrompt`；共享 `retryWithBackoff` ✅

### 2.2 可靠性与正确性
- `completeResume` 失败不吞：上报必填、有界、同 attemptId；不产生假 `done` ✅
- resolve + connect 只一次；仅 prompt 在同一 id 上重试（不重复建目标会话）✅
- 批量不丢 workspace-state 指针 ✅
- 源日志失败保留 `404/501` 而非压平成 `404` ✅
- 批量上限与官方一致（`MAX_SOURCE_SESSIONS = MAX_REFERENCES`）✅
- `/complete` 要求用 `readRequiredToken`（field-scoped）✅
- 事件载体解析带 shape guard，fail-closed ✅

### 2.3 边界与安全
- 工作区扫描不跟随 symlink/junction ✅
- 快照 id/prune 按存储序号、不按时钟 ✅
- `hasWorkspaceState` 只以打包 `manifest.json` 为准 ✅
- `safePathSegment` 防 `child/child_` 与 `sha256:` 碰撞（`~<sanitized>_<sha256>`）✅
- remote 参数严格校验；批量 `snapshotIds` 键必须 ⊆ `sessionIds` ✅
- pre-step 改写 all-or-nothing ✅
- 未知 media 跳走并记录，`layout.media` 诚实 ✅

### 2.4 类型与边界收紧
- client 订单状态 `ResumeOrderUiState` 联合（非裸 `string`）✅
- 必填/可选 token 读取 field-scoped ✅

## 3. 有意保留（非 churn）

- 附件双重守卫（文本日志也需附件库）——fail-closed 默认。
- `titleFromObservation`/快照标题跨版本差异——薄而受控。
- 批量对 `snapshotIds` 的 in-flight key 忽略——当前无 UI 传显式 snapshot id；出现输入路径时再改。
- 快照 + WAL 为单进程原子——部署边界，文档化。
- `resolveFromText`/`resolveSession` 把查询失败折叠为 `null`（`resolveLogPath` 才是干净 404/501 的 plan 路径）——容忍契约。
- Remote 方法全必填、缺省用空串/空对象——协议限制（不表达缺省），有意为之。

## 4. 结构现状（standing）

- Host 传输是 typert `SessionResumeService`（`@Remote` 9 端点）；client 经 `remoteFacade`。
- 新端点/新逻辑放"所属层"：规划 `shared/plan.ts`、host core、client `resume-client.ts`；不在 route shell 堆。
- 后续仍应遵循 P1–P3：重复/条件收进所属层 canonical 抽象。

## 5. 验证（固定命令，非数字）

```
npm run typecheck
npm test
npm run build
```
三者全绿即当前树健康；断言是否会漂移由测试文件决定，不由本文件的数量记录决定。

*治理原则（§1）是本文件最持久的内容；轮次/时序/行数等历史已不保留。*