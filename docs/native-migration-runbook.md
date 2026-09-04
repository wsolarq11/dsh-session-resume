# 原生迁移 Runbook（进度 + 方法）

目标（已达成）：在“功能一致 + 基线全绿”前提下，把 `@dsh-external/dsh-session-resume` 从自建 HTTP
microservice 迁到“DSH 官方原生传输 typert remote + 接口优先（官方当接口、改动最小）”。
本文是**当前为真**：记录迁移方法、当前进度、决策状态与运维要点；不写时间戳/测试数/逐轮过程。

## 当前进度（总览）

- 迁移**已完成并切主树**：Host 暴露 `SessionResumeService`（typert `@Remote`，9 端点），Client 经
  `ctx.remote.sessionResume.*` 直调；自建 HTTP（`api/routes/rate-limit`）与客户端 `fetch` 壳已删。
- 弃用 `smoke-api.mjs`（随 HTTP 移除）；真机验证改走 `scripts/e2e-final.mjs`（网关 9 端点）与
  `scripts/e2e-user-click.mjs`（真实点击副作用数字断言）。
- 迁移细节与取舍见 `docs/WORKLOG.md` §7；选型理由见 `docs/native-reimplementation-assessment.md`。

## 2. 分阶段与验收门

L0（基座）→ L1（transport 替换，核心）→ L2（编排复用，可选）→ L3（发现契合，可选）→ L4（清理收尾）。

每阶段统一验收门：

1. `npm run typecheck` 过；
2. `npm test`（`node --test "tests/*.test.mjs"`）全绿；
3. 真机探针（`e2e-final.mjs` / `e2e-user-click.mjs`）过；
4. 行为对照（旧 HTTP vs 新 remote）一致后再删兜底；改动原子、可回滚、单独提交。

## 3. 决策 flag（当前值）

| flag | 值 | 说明 |
| --- | --- | --- |
| `KEEP_WAL` | **true** | 保留 `orders.jsonl` WAL（唯一能力=跨重启裁定终态+可审计；纯内存足以通过幂等，但跨重启不行） |
| `KEEP_HTTP_FALLBACK` | false | 已删 HTTP 兜底；remote 路径与旧 HTTP 双跑对拍收敛后移除 |
| `USE_SESSION_REFERENCE_LIST` | false | 保留本项目 `shared/source-ref.ts` 统一引用扫描（官方只认 `dsh-session:` URI） |
| `REPO_FULL_WORKSPACE` | false | 单包 flat 结构可正常 officient；不强制做 workspace 重构 |
| `CLIENT_REMOTE_REACHABLE` | true | 客户端已能直调 `ctx.remote.sessionResume.*` |

## 4. 关键不变量（已落地）

- **Remote 方法参数一律必填**（typert 协议不表达缺省）：`resolvePlan(sessionId,attemptId,snapshotId)` 等
  缺省用空串/空对象在方法体内 `|| undefined` 表示；客户端显式传 `?? ''`/`?? {}`。
- **返回需 JSON-safe**：`completeResume` 的 `undefined` 用 `stripUndefined` 清洗，避免网关 `assertJsonValue` 拒。
- **Host 端 `sessionResume/*` 可被 reload 抽成 withdrawn**：`installTypertSelfHeal`（`src/index.ts`）在
  `hasSeen(ep) && get(ep)===undefined` 时自动重挂 + 低频轮询兜底，保证 reload 后命名空间不长期失效。
- **client 读 remote 防抖守卫**：先 `remote.$mount(TYPERT_REMOTE)` 挂载，取用走 `remoteFacade`
  （`ctx.get('remote.sessionResume')` 优先），不裸读属性。
- **`agent/pre-step` 改写**：排在官方 `session-reference` prepend 之后并调用 `next()`，旧 URL → canonical mention。

## 5. 运维/排障要点（不失效）

真实 GUI「续跑失败」的排查（不再赘述某次，给出方法）：

1. **clean re-inject 重建 typert 注册**：`dev_uninject_plugin` → `dev_inject_plugin`。reload 只重建 fiber、
   不重建 typert 注册；必须 uninject+inject。
2. **消除 stale-artifact**：`bash scripts/build.sh` + `npm run build:client` 让 `lib/` 新鲜，避免 self-heal
   因过期产物 reload。
3. **注入后刷新 GUI**：让 client 重新 mount live remote。
4. **仍不行就看 console**：失败若在 client 端（`resolvePlan/create/prompt`），host 网关侧无法覆盖；
   `WAL` 里无对应 `failed` 记录→失败多发生在 client 执行链，非 host 计划失败。

## 6. 附带结论（探索阶段沉淀）

- “官方当接口、改动最小”：开发期 link（junction 同址全局 DSH checkout）+ 发布期 peer 范围声明。
- `@Remote` envelope 不能 stub 单测（Host 运行时绑定）；域逻辑活在委托的纯 core，由 `tests/` 覆盖。