# dsh-session-resume 验证报告

验证对象：`@dsh-external/dsh-session-resume`
验证环境：运行中的 DSH Web 实例；插件经注入器装载为 Host `SessionResumeService` + Client（`remote.$mount`）后 active。
说明：本文是**活的当前基线**：不记时间戳、测试数量、行数、机器路径。凡是你能在当前仓库复现的，以固定命令与行为不变量为准。

## 结论

插件把“下载 export ZIP、手工解压、复制路径”压缩成一次 Host 续跑计划：

1. 会话头部新增“自动续跑”按钮；输入框 Dock 识别绝对路径 / 旧 export URL / `dsh-session:`。
2. 点击后经 `ctx.remote.sessionResume.resolvePlan` 解析：flush 当前会话、`readRaw` 物化为官方导出同构目录、锁定原工作区。
3. Client 用 `target.workspaceId` 通过官方 `connectWorkspace`/`sessions.create` 创建或复用新会话，打开并发送续跑指令。
4. 新会话不再要求用户重复下载/解压/粘贴；不会落到错误工作区。
5. 传输为 typert remote（不经过自建 HTTP）；旧 export URL 兼容路径保留。

> 字节级一致性结论适用于全安全字符 ID；非安全 ID 用 `~<sanitized>_<sha256>` 防碰撞映射，
> 目录结构一致但不保证与官方 ZIP 同名。

## 验证方式（可复现命令）

| 命令 | 期望 |
| --- | --- |
| `npm run typecheck` | PASS（`tsc -p tsconfig.json --noEmit`） |
| `npm run build` | PASS，生成 `lib/index.js`、`lib/client.js`、`lib/types/` 与 `lib/typert.*` |
| `npm test` | 全部 PASS（`node --test "tests/*.test.mjs"`，pretest 自动 build） |
| 真机网关 | `scripts/e2e-final.mjs`：宿主 typert 网关 9 端点全 `ok:true`（任一失败即 FAIL 退出码） |
| 真实点击副作用 | `scripts/e2e-user-click.mjs`：磁盘新快照序数 +1、WAL accepted 落盘、终态不变性（任一失败 FAIL） |

## 行为不变量（当前为真）

单会话 / 批量：

- `resolvePlan(sessionId, attemptId, snapshotId)`：同 attemptId 幂等（同源只一次）；`snapshotId` 命中复用历史快照，否则重新物化；至少 1 个不可读源返回 404，全部不可解析工作区返回 409。
- `resolveBatchPlan(sessionIds, attemptId, snapshotIds)`：`sessionIds[0]` 为主键串行与幂等；`snapshotIds` 键必须是 `sessionIds` 子集（悬空键 400）。
- `completeResume(attemptId, status, targetSessionId, error)`：`accepted|failed` 终态；同 attempt 重复回报幂等保留首终态；`accepted` 后 `failed` 返回当前终态不覆盖。
- WAL：终态追加落 `orders.jsonl`（最近行胜出）；Host 重启后 `loadFromWal()` 恢复已终态 attemptId，跨重启幂等。
- 物化目录与官方 export ZIP 逐字节一致（根 artifact + `subagents/` + `media/`；安全 ID）。
- 新鲜度：源会话新增标记后 `resolvePlan`，物化根日志含该标记。
- legacy 旧会话（缺 `message.id`）：续跑走快照路径而非 `dsh-session:` mention（避免触发 fragile surface 读的
  “lacks an identified message”）。

配置与快照：

- `getConfig`/`setConfig`：往返生效；非法值归一化回默认（retention 默认 10，范围 1–100）。
- `listSnapshots(sessionId)`：未知会话返回 `[]`。

装配与运维：

- client 经 `remote.$mount(TYPERT_REMOTE)` 挂载 `ctx.remote.sessionResume`；`remoteFacade`（`ctx.get` 优先）可用。
- Host 端 `sessionResume/*` 在 reload/self-heal 下保持 LIVE（withdrawn 时自动重挂）。
- 装配通道 super-injector（autoRestore）；bundle 与 super 互斥，重复 apply 报 `duplicate prefix route`。

## 协议与错误语义

详见 `docs/session-resume-architecture.md` §5（Remote 契约）——`{ok:false,status,error}` 表达失败，
status 语义：400 缺参 / 404 会话不可读 / 409 工作区不可解析 / 501 不支持原始工件等。

## 限制与实际差异

- 像素级页面视觉（无 headless 浏览器条件）以“协议 + host 真实副作用 + 数字增量断言”替代（见 `e2e-user-click.mjs`）。
- 真实 media 已用 PNG 验证；jpeg/webp/gif 仍只由单测覆盖。
- 深层后代已用真实三代会话验证；更复杂环状/重复 lineage 仍由单测覆盖。
- 无 cwd 且无 workspace 的真实会话未能在环境构造；fail-closed 分支由单测覆盖。
- `orders.jsonl` 追加写无跨进程锁；多 Host 进程共享缓存根“最新行胜出”，不保证强一致。
- 新会话读取物化目录的权限取决于 Agent 运行环境。
- 关注标尺：本仓库不设自建 HTTP，任何“`/session-resume/api/*` URL”都证明文档/README 已落后于源码。