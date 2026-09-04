# 工作决策与取舍档案（历史决策层）

本文件是**历史决策档案**：记录过程中做过的技术取舍、调查结论与踩坑，以及这些决策**至今仍生效的约束**。
为保持“活文档”，本文件**不按会话、不写日期、不写测试数量/行数/轮次号**；它与你今天能对上的只有
“为什么这样定”。当前是否生效以源码与 `docs/CHANGELOG.md`（当前状态/演进史）为准。
更新的读者工具/命令见 `docs/README.md`。

> 原则：历史值得保留的是**决策与不变量**，不是“某时某会话改了几行”。凡本文件与源码冲突，以源码为准。

## 1. 续跑指令——三轮推敲冻结

原始指令有结构缺口：自动流程“上面引用的”指代落空；自动/手工文本不一致；无“快照缺失”失败分支。
终版（单一事实源在 `src/shared/constants.ts`，`tests/resume.test.mjs` 冻结）：

> 请继续这个会话：直接读取上述日志快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续。若快照缺失或不可读，请如实说明。

- 措辞必须全正向（不写“无需向用户索取日志”之类否定句）。
- 任何改动必须先动冻结测试；不做第二份拷贝。

## 2. client 槽位注册写法（注入器预检）

`dev_inject_plugin` 预检要求 `register({ name, ... }, Component)` 让 `name:` 同对象紧邻。新西兰弯折
换行写法不通过。决策：不改 super-injector（其白名单是有意安全闸门），改本项目写紧邻形态，语义零变化。

## 3. 装配通道：super 与 bundle 互斥

- 经 `~/.dsh/super-injector/registry.json` 装配并 autoRestore；**不要**把本包同时写入
  `dsh.profile.bundles`，否则同一 `apply` 重复执行报 `duplicate prefix route`。
- 切通道须先移除另一侧；bundle 装配还需确认 `dsh.bundle.patch`/`cordis.patch.yml` 随包存在。

## 4. 五个能力方向（全面落地）

1. 续跑指令配置化（全局单份 JSON，原子写）。
2. 快照版本化 + 历史回滚（`snapshots/<snapshotId>/`，保留 N 份）。
3. 订单持久化 + 失败重试（`orders.jsonl` WAL，attemptId 幂等）。
4. 多会话批量续跑（`resolveBatchPlan`，`sessionIds[0]` 串行）。
5. 工作区状态打包（文件树清单 + git 状态，不含内容）。

每条的不变量并入适用文档；实现细节不在此赘述。

## 5. 热核评审与结构收敛（决策要点）

这一串是不断“结构简化 + 死代码证实”后沉淀的通用规则（详见
`docs/thermo-nuclear-review-consolidated.md` 的“举一反三”）：

- 死导出以**真实引用**为准，不以“似曾契约”保留；误判可在后续轮纠正并记录。
- “测试契约”不是保留薄包装的理由——测试导入底层函数才是事实。
- 统一 single-sourced helper（`safePathSegment`、`readService`、`readOptionalToken`、
  `retryWithBackoff`、`isResumePlan`、`buildResumePrompt` 等），避免同类逻辑散布。
- 命名具象化，避免 `api.ts` 爆量：曾把 `api.ts` 拆为 `routes.ts`（路由表）+ 精简的调度壳。
- WAL 重写仅在超限时发生：只 trim 终态 attempt，保留 in-flight。
- attemptId 回退用“时间戳–单调计数”而非纯时钟（同毫秒也不碰撞）。
- 去重计数收敛到 `shared/source-ref.ts` 单一模型。

## 6. 后台 bash 一坑（环境级，非本项目代码）

Git-bash 后台子进程缺 `readOutput/kill` 契约，`job_output` 在 win32 后台 bash 路径会炸。
不受本项目影响；规避：前台 bash / 后台 pwsh。不为此改工具（无上游诉求）。

## 7. 与 typert 迁移相关的调查与取舍

详见 `docs/native-migration-runbook.md`；这里只留结论：

- generator 曾因版本错配（旧版 analyzer 只认 `@deepseek-ai/dsh-type-meta`）报
  “publishes Remote artifacts but has no Remote methods”。升到配套版本后识别 `@Remote`。
- `@Remote` 方法参数**一律必填**（typert 协议不表达缺省）；缺省用空串/空对象在方法体内表示。
- 返回里 `undefined` 会被网关 `assertJsonValue` 拒；仅对需要 `undefined` 结果清洗（`stripUndefined`）。
- Host 端 `sessionResume/*` 可能被 reload 抽成 `withdrawn`；`installTypertSelfHeal` 自动重挂 +
  轮询兜底，保证 reload 后命名空间不长期失效。
- client 须 `remote.$mount(TYPERT_REMOTE)`；读取用 `remoteFacade`（`ctx.get` 优先）避免“without inject”。