# 更原生实现的选型与决策记录

目的：解释“为什么插件现在用 typert typed-remote 而不是自建 HTTP”。这是**决策记录**（保留"为什么"），
不是执行 Step-by-step；当前由 `docs/session-resume-architecture.md` 描述现状，`docs/native-migration-runbook.md`
描述迁移方法与结果。因此本文不再出现“尚未解锁”“待办”“正在改码”等失效状态。

## 结论（仍成立）

插件真正的增值只有两块：

1. **旧 export URL / 绝对路径 的识别与归一化**（`shared/source-ref.ts` + `agent/pre-step` 改写 + 输入框识别）。
   这是官方没有的，是本项目独有增值，保留。
2. **「锁定原工作区 -> 物化日志 -> 创建/复用新会话 -> 续跑」的编排语义**（plan + order + WAL + audit）。
   其中“建会话/复用/打开/prompt”本就走官方客户端服务。

其余大量代码是在复刻 DSH 第一方已有的基础设施，曾以自建 HTTP microservice 形态存在，现改为：

| 曾手写 | 现状（原生 seam） |
| --- | --- |
| `webServer.register(/session-resume/api/*)` + loopback + 限流 + JSON 分发 + 手写 readBody | **typert typed-remote**（`SessionResumeService` + `@Remote`，Client 直调 `ctx.remote.sessionResume.*`） |
| 客户端裸 `fetch` + `fetchJson` + 手工退避/重试/幂等上报 | typert 客户端 `ctx.remote.<ns>.<fn>()`，错误/取消/参数校验由协议自带 |
| 物化目录/快照布局/计划 | 保留（官方 `prepare` 语义有重叠但未下放，见下） |
| 自定义 `%TEMP%\...\config.json` 配置 | 保留（DSH 无官方 per-plugin 注册表，此空缺由本项目填充） |

## 为什么选 typert（档位取舍）

按“改动从小到大、收益从硬到软”四档，最终取**只换传输层（档位 A）**：

- **档位 A（采用）**：把自建 HTTP 栈换成 typert typed-remote。域逻辑（`resume-plan`/`order-wal`/`session-log`/
  `snapshot-store`/`audit`/`source-ref`）原样保留，只换方言。风险低，行为 100% 不变，是“功能一致”最干净的割面。
  更底层的边界到：客户端 `api.*` wire client（官方 UI 同款）已是最底层；“识别/归一化”是唯一需要跨边界的
  解析，typert remote 一个 `@Remote` 就够。
- **档位 B（可选）**：复用官方 `sessionPersistence.prepare` 语义下放“快照/续跑原子性”。当前保留自定义
  （与官方 `prepare` 有意重叠，因其“另一会话只读 attach”语义未完全覆盖本项目跨会话续跑）。
- **档位 C（可选）**：用官方 `session-reference.listCandidates` 统一“候选/归一化”，只在官方不认的
  “旧 URL / 裸路径”上保留本项目识别。当前保留本项目的统一引用扫描。
- **档位 D（不采用）**：越过插件边界（改 `apps/web` shell 或 build 产物）不符可分发性与“功能一致”。

> 更深一档的发现：官方 `workspaces.connectWorkspace` 本身就是幂等复用空白会话的通道，因此“会话级幂等”
> 原生已有；本项目的 WAL 承担的是“跨 Host 重启后对一次 attempt 裁定终态并审计”这一更稳定的保证，
> 二者互补而非重复。默认保留 WAL（见 migration runbook 决策 flag）。

## 为何不依赖老生成器版本

迁移曾遇到 typt 生成器与 protocol 版本错配（旧 analyzer 只认 `@deepseek-ai/dsh-type-meta`，不认
`Remote`/`TypertRemoteService`，报“publishes Remote artifacts but has no Remote methods”）。解法是
**跟随官方版本**（generator 与 protocol/reference 同裁剪）而不是锁死旧版。属于“开发 link、发布 peer”策略。

## 保留的测试策略（防误测）

`@Remote` service envelope 无法脱离真实 Host 单测（Cordis 构造需挂载 `ctx`/typert）；可验证逻辑要活在它
委托的**纯域核心**里，由 `tests/*.test.mjs` 直接测核心。不要试图 stub 装饰器类。