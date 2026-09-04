# @dsh-external/dsh-session-resume

把当前会话的 Host 日志自动物化成官方导出目录，把目录绝对路径带进新会话并发送续跑指令，替代
“下载 Session 日志 ZIP -> 解压 -> 复制 `session.jsonl` 文件地址 -> 粘贴”的手工流程。

## 用法

1. 在当前会话右上角点 `自动续跑`（在官方 `Session log` 下载按钮旁边）。
2. Host 先通过官方 `readRaw` 读取源会话日志并解析原工作区；日志会物化为官方导出同构目录
   `%TEMP%\dsh-session-resume\<sessionId>\snapshots\<snapshotId>\`，根文件名来自后端 `raw.filename`，
   子代理在 `subagents\<safeId>\<filename>`，引用图片在 `media\`，再返回一次
   `attemptId` 驱动的续跑计划（计划内带官方 `@[标题](dsh-session:...)` 引用；
   单会话与批量统一为 `sources[]` 形状）；
   客户端按该计划在原工作区创建或复用新会话，再发送：
   `官方会话引用（mention）或快照目录路径 + 请继续这个会话……`（有 mention 优先用 mention）
3. 如果原工作区无法确定，Host 直接失败，不会用任意 `cwd` 创建错工作区的会话；
   如果自动发送失败，新会话仍会创建，续跑指令会复制到剪贴板，按钮显示失败状态。

旧下载 URL 仍兼容：把 `/api/session.export?...` 或绝对 JSONL 路径粘到输入框后，
输入框上方会出现识别条，可 `一键续跑`、`仅填入` 或 `复制续跑指令`。
直接把日志 URL 发给 Host 时，`agent/pre-step` 仍会自动改写为官方
`@[标题](dsh-session:...)` 快照引用。

## 扩展能力

- **续跑指令配置化**：`POST /session-resume/api/config` 可写入自定义 `resumeInstruction`
  （全局生效，默认冻结官方措辞）与快照保留数 `snapshotRetention`（默认 10，范围 1–100）。
  配置存 `%TEMP%\dsh-session-resume\config.json`，Client 每次续跑前读取；指令缺省时回退冻结默认。
- **快照版本化 + 历史回滚**：每次续跑物化到
  `%TEMP%\dsh-session-resume\<sessionId>\snapshots\<snapshotId>\`，同会话保留最近 N 份（N 可配置）；
  `GET /session-resume/api/snapshots?sessionId=` 列出历史快照，`/resume` 带 `snapshotId` 可
  直接从历史快照续跑（不重新物化）。
- **工作区状态打包**：物化快照内含 `workspace-state/manifest.json`（文件树清单：路径/类型/大小/mtime，
  不含文件内容）与 `workspace-state/git.txt`（git HEAD + porcelain 状态或"工作区干净"）；
  续跑指令自动附加"请先阅读工作区状态"提示。扫描深度与条目数有界，失败不阻断续跑。
- **多会话批量续跑**：`POST /session-resume/api/resume-batch` 一次物化多个会话
  （`sessionIds` 数组，最多 3 个，与官方单消息引用上限一致），新会话收到全部快照引用列表；可传 `snapshotIds`
  指定各会话历史快照（键必须是 `sessionIds` 子集，悬空键返回 400）；
  Dock 识别到 2–3 个不同会话时出现 "批量续跑 N 个" 按钮。
- **订单持久化 + 失败重试**：订单状态追加写入 `%TEMP%\dsh-session-resume\orders.jsonl`（WAL），
  Host 重启后 `/complete` 对已终态 attemptId 保持幂等；Client 创建/复用目标会话后
  只对**发送**做有界重试（最多 3 次，500ms 起指数退避），发送失败不会重复创建新会话；
  仍失败则复制指令到剪贴板并回报 failed。

## 原理

- 官方 `dsh-session-log-export` 只负责浏览器下载 ZIP，不返回 Host 文件路径；
  手动流程里的 `session.jsonl` 实际来自下载后解压；父会话导出还包含
  `subagent/<id>/session.jsonl` 与 `media/`，所以“解压后的目录”才是完整快照。
- 官方持久化层 `dsh-session-persistence.readRaw(sessionId)` 返回后端原始 artifact
  文本；对 live 会话，插件先调用官方 `SessionStore.flush(session)`，再物化成官方导出目录。
- 本插件补上这一层适配：
  - Host 注册 `/session-resume/api/resume`，一次返回
    `{ attemptId, sources: [{ sessionId, label, path, kind, rootPath, layout, mention }], target: { workspaceId, cwd } }`；
    `sources[].path` 是物化目录，`sources[].rootPath` 是目录内根 artifact；
  - Host 通过 `workspaceRegistry` 先按源会话所属工作区锁定目标，再按 `cwd`
    路径解析或注册原工作区；无解时 fail-closed，不再使用裸 `sessions.create({ cwd })`；
  - Host 在 `agent/pre-step` 的普通监听位置改写直接用户消息，使旧下载 URL 仍能
    经过官方 `session-reference` prepend 监听器自动准备快照；
  - Client 注册 `conversation.session.header.utilities`（自动续跑按钮）与
    `conversation.input.dock`（URL/JSONL 路径识别 + 一键续跑）。
  - Header 与 Dock 的一键续跑共用同一执行器：先调 `/resume` 锁定原工作区，
    再走官方 `connectWorkspace(workspaceId)` 复用空会话，或
    `sessions.create({ workspaceId })` 创建新会话，最后用
    `sessions.binding(id).session.prompt` 发送续跑文本，不走浏览器下载。

## 边界与限制

- 主流程是“把物化后的 Host 日志目录作为文本交给新会话”，不是官方上下文状态恢复；
  新会话从日志目录中读取历史记录，再按续跑指令从断点继续。后台 job、运行中终端、
  未落盘文件、凭据等外部状态不恢复。
- 续跑目标必须能解析到原工作区：优先源会话所属工作区，其次按源 `cwd`
  在注册表中解析；仍未命中且允许注册时才会创建对应 workspace。无法解析时不会继续创建会话。
- Host 日志通过官方 `readRaw` 读取，读取失败、子代理日志缺失、附件服务缺失或图片附件
  不可读时返回 501，不把残缺目录交给新会话。
- Host API 仅允许本机访问，按调用方限流（20 次/分钟），每次响应回显 `requestId`，
  并在 Host 日志中输出结构化 `session-resume.order` 审计行。
- 插件物化到 `%TEMP%\dsh-session-resume\<sessionId>\snapshots\<snapshotId>\`，目录布局与官方
  导出 ZIP 一致（非安全 ID 使用防碰撞映射，见下）：根 artifact、子代理 `subagent\<safeId>\<filename>`、图片 `media\<safeAttachmentId>.<ext>`
  （历史版本无 `snapshots\` 层，直接是会话目录，仍可被旧逻辑读取）；
  Windows 上非安全 ID（如 `sha256:<digest>`）会映射为 `~<sanitized>_<sha256摘要>`，
  避免 `sha256:` 与 `sha256_` 等路径碰撞；全安全字符 ID 保持原名。
- 物化缓存按快照版本保留，超配后自动裁剪最旧快照，避免无限增长；若临时目录被系统清理，
  再次点击会重新物化。
- 单条消息最多支持 3 个不同路径/会话；超过时 Client 会提示，避免触发官方
  `maxReferences` 失败。批量续跑一次最多 3 个会话。
- sessionId 使用官方 UTF-8 安全的
  `dsh-session:<base64url(JSON.stringify(sessionId))>` 编码，支持任意字符串。
- 本插件不处理任何费用、税、利率或金融事务，不能作为“0税0息”承诺的依据。

## 订单约束

- `/resume` 与 `/complete` 构成订单链：`requestId -> attemptId -> planned -> accepted/failed`；
  订单状态追加式落盘 `orders.jsonl`（WAL），Host 重启后可恢复已终态 attemptId 的幂等性。
- 同一 `attemptId + sessionId` 重复调用返回同一份计划，不重复物化；同一 attemptId 绑定其他会话时返回 409。
- 同一源会话的并发计划在 Host 端串行执行；Client 端按 `sessionId` 共享执行 Promise，避免 Header 与 Dock 同时下单。
- Client 发送续跑文本失败时有限重试（最多 3 次，指数退避），超限后把指令复制到剪贴板并
  通过 `/complete` 回报 failed，不静默丢弃。
- 审计行包含 `requestId`、`remoteAddress`、`attemptId`、`sourceSessionId`、
  `targetWorkspaceId`、`targetSessionId` 与终态，客户端创建/发送结果通过 `/complete` 回报 Host。
- 日志工件文件名只允许单层安全文件名；绝对路径、分隔符、`.`、`..` 与超长文件名都会 fail-closed。

## 依赖

Host 依赖官方 `dsh-session-query`、`dsh-session-reference`、
`dsh-session-persistence`、`dsh-attachment`、`dsh-workspace` 与 Host `sessions` 服务；Client 依赖
`dsh-client-runtime`、`dsh-client-ui-slots`、`dsh-client-ui-conversation` 与
client `workspaces` 服务。标准 DSH web profile 已包含这些服务；独立加载时应先满足
`package.json` 中的 peer dependencies。

## 文档

- [文档索引](docs/README.md)：全部文档入口（架构、验证、质量评估、变更历史）。
- [技术文档](docs/session-resume-architecture.md)：架构、拓扑、Host API、握手协议、技术选型。
- [验证报告](docs/verification.md)：真实 Host API 与 Playwright E2E 实测结果。

## 文件

- `src/index.ts`：Host 实现与插件入口。
- `src/host/`：Host 日志读取与官方导出目录物化、工作区解析、续跑计划、订单幂等守卫与 WAL、
  快照列表、批量续跑、工作区状态扫描、HTTP 安全与审计模块。
- `src/client/`：Client 实现（入口 + 按钮 + 输入 dock + 订单执行器 + 批量执行器）。
- `src/shared/`：Host/Client 共用的 URL、URI、JSONL 路径解析、统一引用扫描、批量续跑文本与配置读取，
  避免两套正则与握手分叉。
- `tests/`：无依赖 Node 测试，覆盖 UTF-8 URI、URL 解析、路径解析、多引用上限、
  Host 路径定位、原工作区解析、幂等连接、订单幂等与 WAL、安全边界、限流、配置、
  快照版本化、工作区状态扫描、批量续跑和 pre-step 改写。
- `scripts/smoke-api.mjs`：对运行中 DSH web 的 live API 冒烟脚本（配置往返、快照列表、
  批量守卫、404 兜底），可作 CI 门禁。
- `lib/` 由 `npm run build` 从 `src/` 生成；`scripts/build.sh` 在无 DSH 源码
  checkout 时自动退回本地 devDependencies，有 checkout 时仍按官方目录链接。

## 验证

```bash
npm install
npm test
npm run typecheck
```

> 若 shell 环境注入了 `npm_config_allow_scripts`（npm ≥ 11 的安全策略，
> npm 12 会在项目级 `npm ci` 直接报 `EALLOWSCRIPTS`），先移除该变量再安装：

```bash
env -u npm_config_allow_scripts npm ci   # 本仓库依赖均无 install 脚本，移除后即可跑通
```

## 构建与注入

```bash
npm run build
# 注入器环境内：dev_inject_plugin <本目录>
```

当前装配通道为 super-injector：`dev_inject_plugin` 维护
`~/.dsh/super-injector/registry.json`，DSH 启动时由 super-injector 自动恢复。
bundle 与 super 是互斥通道，不要把本包同时加入 profile 的 `dsh.profile.bundles`；
两通道并存会让 `/session-resume/api` 重复注册而启动失败。若切换为 bundle 通道，
先从 super registry 移除本包，再确认 `dsh.bundle.patch` 指向的 `cordis.patch.yml`
随安装包存在。

需要按官方 checkout 目录链接构建时：

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
```

`.npmrc` 开启 `legacy-peer-deps`，用于绕过官方
`dsh-client-ui-conversation -> dsh-token-meter -> dsh-compact` 当前的 npm 解析冲突。