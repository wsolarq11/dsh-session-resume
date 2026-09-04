# @dsh-external/dsh-session-resume

把官方 Session 日志下载链接桥接为跨会话只读快照引用，用于在新会话中继续旧会话。

## 用法

1. 在当前会话右上角点 `复制日志链接`（在官方 `Session log` 下载按钮旁边），得到
   `.../api/session.export?sessionId=...` 下载地址。
2. 打开一个新会话，把链接粘贴进输入框。
3. 输入框上方出现 `检测到 Session 日志链接` 提示条：
   - `一键续跑`：把链接替换为官方 `@session` 引用并自动发送续跑指令；
   - `仅填入`：只替换链接，不发送；
   - `复制续跑指令`：把可直接发送的续跑文本复制到剪贴板。

也可以不点按钮：在新会话输入框里直接粘贴日志链接并发送
`继续这个会话`。Host 的 `agent/pre-step` 钩子会自动把链接改写成
`@[标题](dsh-session:...)` 规范引用，交给官方 `session-reference` 服务注入旧会话快照。

## 原理

- 官方 `dsh-session-log-export` 只负责浏览器下载，不提供“复制地址”和“解析地址”。
- 官方 `dsh-session-reference` 会把直接用户消息里的
  `@[label](dsh-session:<base64url JSON sessionId>)` mention 解析为跨会话只读快照，
  但它不认识 `/api/session.export?sessionId=...` 下载 URL。
- 本插件补上这一层适配：
  - Host 注册 `/session-resume/api/copy` 与 `/session-resume/api/resolve`；
  - Host 在 `agent/pre-step` 的普通监听位置改写直接用户消息，使其先经过
    `session-reference` 的 prepend 监听器，从而自动准备快照；
  - Client 注册 `conversation.session.header.utilities`（复制按钮）与
    `conversation.input.dock`（粘贴识别 + 一键续跑）。

## 边界与限制

- 这是快照续写，不是执行状态恢复。官方 `session-reference` 只投影文本、compact
  checkpoint 和最新消息；工具调用、reasoning、旧消息、后台 job、未落盘文件、
  运行中终端和凭据不会恢复。
- 单条消息最多重写 3 个不同会话；超过时 Client 会提示，Host 也只改写前 3 个，
  避免触发官方 `maxReferences` 失败。
- sessionId 使用官方 UTF-8 安全的
  `dsh-session:<base64url(JSON.stringify(sessionId))>` 编码，支持任意字符串。
- 本插件不处理任何费用、税、利率或金融事务，不能作为“0税0息”承诺的依据。

## 依赖

Host 依赖官方 `dsh-session-query` 和 `dsh-session-reference`，Client 依赖
`dsh-client-runtime`、`dsh-client-ui-slots` 与 `dsh-client-ui-conversation`。
标准 DSH web profile 已包含这些服务；独立加载时应先满足 `package.json` 中的
peer dependencies。

## 文件

- `src/index.ts` / `lib/index.js`：Host 实现。
- `src/client/index.ts` / `lib/client.js`：Client 实现（ModuleLoader bundle）。
- `src/shared/`：Host/Client 共用的 URL 与 URI 解析，避免两套正则分叉。
- `tests/`：无依赖 Node 测试，覆盖 UTF-8 URI、URL 解析、多引用上限和 pre-step 改写。
- `lib/` 由 `npm run build` 从 `src/` 生成；`scripts/build.sh` 在无 DSH 源码
  checkout 时自动退回本地 devDependencies，有 checkout 时仍按官方目录链接。

## 验证

```bash
npm install
npm test
npm run typecheck
```

本地 `devDependencies` 已钉到与 `dsh-routing-suite/injector` 相同的 DSH 版本
（`0.1.1-rc.2`），不需要借用它的 `node_modules`。这里不直接 junction 共享
npx 缓存，因为 npm 会把被链接目录当作当前项目依赖树的一部分并可能清理其内容。

## 构建与注入

```bash
npm run build
# 注入器环境内：dev_inject_plugin <本目录>
```

需要按官方 checkout 目录链接构建时：

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
```

`.npmrc` 开启 `legacy-peer-deps`，用于绕过官方
`dsh-client-ui-conversation -> dsh-token-meter -> dsh-compact` 当前的 npm 解析冲突。
