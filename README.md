# @dsh-external/dsh-session-resume

面向 DSH Web 的"一键续跑"插件：把当前会话的 Host 日志物化成官方导出目录、锁定原工作区、在新会话里
创建并发送续跑指令，省去"下载 ZIP → 解压 → 复制路径 → 粘贴"的手工流程。

> 以当前源码为准（typert remote，不自建 HTTP），已淘汰的历史描述不再出现；文档分层见
> [docs/README.md](docs/README.md)。

## 简介

这个插件把"续跑"压缩成一次点击。它能自动完成日志物化、工作区确认、会话创建/复用与指令发送四件事，
并让旧的手工下载链接继续可用。适合在 DSH Web 里高频"旧会话 → 新会话从断点继续"的用户。

## 安装与运行

装配走 super-injector：在注入器环境里执行 `dev_inject_plugin <本仓库目录>`，由
`~/.dsh/super-injector/registry.json` 在 DSH 启动时自动恢复。

```bash
env -u npm_config_allow_scripts npm ci   # 环境注入了 npm_config_allow_scripts 时（npm≥11 的 EALLOWSCRIPTS）
npm run typecheck                        # 类型检查
npm test                                 # 单元测试（pretest 自动构建）
npm run build                            # 生成 lib/（含 client bundle 与 lib/typert.*）
```

真机可复现验证（运行中的 DSH Web）：`scripts/e2e-final.mjs`（Host typert 网关 9 端点）与
`scripts/e2e-user-click.mjs`（真实点击的快照序号 / WAL accepted / 终态不变性）。

## 使用

在当前会话右上角点「自动续跑」，它随后自动完成：

1. 读取源会话日志、解析其原工作区，物化成官方导出同构目录（含 `subagents\`、`media\`、
   `workspace-state\`）。
2. 在原工作区复用空白会话或新建会话，打开并发出续跑指令：带官方 `@[标题](dsh-session:...)`
   引用，缺省回退快照目录路径（legacy 缺 id 会话走路径续跑）。
3. 解析不到工作区时 fail-closed 不创建；发送失败把指令复制到剪贴板并提示，不静默丢消息。

旧下载链接仍兼容：粘贴 `/api/session.export?...` 或绝对 JSONL 路径会出现识别条
（一键续跑 / 仅填入 / 复制指令），直接发送 URL 则被 Host 改写为官方快照引用。

## 特性

- **配置化**：自定义续跑指令与快照保留份数（默认 10，范围 1–100）。
- **快照可回滚**：按序号物化、按保留裁剪，可列出历史或指定某份直接续跑。
- **工作区状态随带**：快照内含文件树清单与 git 状态（不含文件内容）。
- **多会话**：一次续跑 1–3 个会话。
- **幂等有序**：`attemptId` 幂等＋`orders.jsonl` WAL，终态可重启恢复；发送有限重试，失败复制到
  剪贴板并回报「失败」。

## 实现

官方链接只产 ZIP、不返回 Host 路径；完整快照＝解压后的目录（根 `session.jsonl`＋`subagents/`＋`media/`）。
插件用官方 `readRaw` 把 live 会话落盘后物化该目录，再把它作为续跑文本交给新会话。跨主两端走 typert
remote（Host `SessionResumeService`，客户端 `ctx.remote.sessionResume.*`）。

## 限制

- 属于"把物化目录作为文本交给新会话"，**不是上下文状态恢复**：job、运行终端、未落盘文件、凭据不还原。
- 必须能解析原工作区，否则不创建；日志读不到、附件缺失、图片不可读 → 501，绝不交付残缺目录。
- 目录与官方解压 ZIP 同构；非安全 ID 做防碰撞映射；未知媒体类型 fail-closed 跳过（不生成 `.undefined`）。
- 单条消息 / 批量均最多 3 个路径；不处理任何费用、税、利率或金融事务。
- 依赖官方 session-query / session-reference / session-persistence / attachment / workspace /
  sessions / typert 及客户端 runtime 与 UI slots（独立加载按 `package.json` peerDependencies 补齐）。

## 参考

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](docs/README.md) | 活文档分类账（当前为真 / 历史决策 / 归档分层与防漂移约定） |
| [架构](docs/session-resume-architecture.md) | typt remote 契约、拓扑、不变量、限制 |
| [复现](docs/reproduction-guide.md) / [验证](docs/verification.md) | 从零重建 / 可复现验证 |

```text
src/
  index.ts  插件入口（SessionResumeService + typert 自愈 + agent/pre-step 改写）
  host/     Host 半区：物化 / 工作区 / 计划 / 订单 + WAL / 快照 / 审计
  client/   Client 半区：按钮 / 输入 dock / 统一执行器（remote 直调）
  shared/   Host/Client 共用纯逻辑（无 React）
tests/      无依赖 Node 测试
scripts/    build.sh / e2e-final.mjs / e2e-user-click.mjs
lib/        npm run build 生成（不入库）
```