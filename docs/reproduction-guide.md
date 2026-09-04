# dsh-session-resume 复现指南（源码级可复现技术文档）

版本：0.0.1
适用对象：希望在不阅读本仓库 `src/` 实现的前提下，从零重建
`@dsh-external/dsh-session-resume`（后续简称「本插件」）源码、测试、构建产物与
注入行为的工程师。
目标：**依据本文 + 官方 DSH 环境 + 仓库内 `tests/` 断言，不阅读 `src/` 实现细节**，
重建出与本仓库**契约级一致**的实现：全部测试通过、构建产物结构与入口一致、
注入后 GUI 行为一致、Host API 契约一致。

> 本文是一份「可执行技术规范」，与三份既有文档互补：
> - `docs/session-resume-architecture.md` —— 设计意图与 API/协议契约（必读）；
> - `docs/verification.md` —— 已验证事实与行为基线（必读）；
> - `docs/CHANGELOG.md` —— 决策史与踩坑记录（必读）。
>
> **权威行为规范 = 架构文档 + 验证报告 + `tests/*.test.mjs` 断言 + 本文第 3 节源码结构规范**。
> 复现作者以这四者为输入写 `src/`，无需逐行对照原实现；`tests/` 属于版本库，
> 复现时随仓库一并 checkout，是行为契约的机器可执行部分。
>
> 「完整准确」的边界：可再生产物（`lib/`、`dist/`、测试通过）逐字节/逐断言一致；
> 源码本身为**契约级等价**（行为、导出、边界一致），不承诺逐字符相同——后者等价于
> 复制源码，不是文档复现。

---

## 0. 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| OS | Windows 10+ / macOS / Linux | 路径与 shell 命令以 Windows + Git Bash 为准，POSIX 相同 |
| Node.js | ≥ 20（CI 用 24） | `node -v` 应输出 `v24.x` |
| npm | ≥ 10 | `npm -v` 应输出 `12.x` |
| Git | ≥ 2.40 | 用于 clone |
| DSH Web 运行时 | 正在运行且可访问 `http://127.0.0.1:3080` | 注入与 E2E 验证需要 |
| DSH 源码 checkout（可选） | 官方仓库 checkout | 构建时自动探测；缺失时回退本地 devDependencies |
| Playwright（可选） | 仅 E2E 视觉验证需要 | `npm i -D playwright` + `npx playwright install chromium` |

---

## 1. 复现目标产物清单

复现成功后，仓库内应存在以下**可再生产物**（均被 `.gitignore` 排除，不入版本库）：

```text
lib/                    # tsc 编译产物 + tsdown client bundle
  index.js              # Host 半区入口（NodeNext ESM）
  index.js.map
  client.js             # Client 半区 bundle（浏览器，含 ModuleLoader 包装）
  client.js.map
  host/ shared/ client/ # tsc 按目录镜像的 JS 产物（client/ 为 tsc 镜像，
                        # 与 tsdown 生成的顶层 client.js 并存）
  types/                # 声明文件（declarationDir）
dist/
  dsh-external-dsh-session-resume-0.0.1.tgz   # npm pack 发布包
node_modules/           # npm ci/install 安装的依赖 + build.sh 建立的 junction 链接
```

以及**版本库内应存在的文件**（来自复现作者的提交）：

```text
package.json  package-lock.json  .npmrc  .gitignore  tsconfig.json  tsdown.config.ts
scripts/build.sh  src/**  tests/**  docs/**  .github/workflows/ci.yml
```

> `dist/`、`lib/`、`node_modules/` 一律不提交；`.gitignore` 恰好排除这三者与
> `*.tsbuildinfo`、`*.tgz`。

---

## 2. 从零复现分步操作

### 步骤 2.1：获取仓库与初始依赖

```bash
# 1. 克隆（若已有空目录则：git init && git remote add origin ...）
git clone https://github.com/wsolarq11/dsh-session-resume.git
cd dsh-session-resume

# 2. 确认已检出以下文件（未检出则从 PR/commit 完整还原后再继续）
ls package.json tsconfig.json tsdown.config.ts scripts/build.sh .npmrc .github/workflows/ci.yml

# 3. 依据 lockfile 安装依赖（.npmrc 已开启 legacy-peer-deps，绕过
#    dsh-client-ui-conversation -> dsh-token-meter -> dsh-compact 的解析冲突）
npm ci
```

> **关键决策 1（版本锁定）**：CI 锁定 Node 24；`package-lock.json`（lockfileVersion 3）
> 锁死 devDependencies 精确版本。**复现必须用 `npm ci`**（不是 `npm install`），
> 否则可能装上不同版本导致类型/行为漂移。

> **环境注意（npm ≥ 11 的 allow-scripts 策略，实测本机 npm 12.0.2）**：
> 若 shell 环境注入了 `npm_config_allow_scripts`（如本机 `@deepseek-ai/dsh-subprocess-local,
> koffi,node-pty,@google/genai,protobufjs`），npm 12 在**项目级 `npm ci` 启动时**直接拒绝
> （`EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped installs`），
> 与依赖是否有 install 脚本无关。
> **合规解法**（不修改任何 npmrc/package.json）：
>
> ```bash
> env -u npm_config_allow_scripts npm ci
> ```
>
> 本仓库 lockfile 中**没有任何依赖声明 install 脚本**（`hasInstallScript: 0`），
> 因此移除该 env 变量后 `npm ci` 即可在官方默认状态跑通（实测 53 包、2 秒）。
> CI（ubuntu-latest + Node 24）不存在该环境变量，直接 `npm ci` 即可。

### 步骤 2.2：类型检查

```bash
npm run typecheck
# 期望：无输出、exit 0（tsc -p tsconfig.json --noEmit）
```

`tsconfig.json` 关键项：

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM"],
    "strict": true,
    "types": ["node"],
    "declaration": true,
    "declarationDir": "lib/types",
    "outDir": "lib",
    "rootDir": "src",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

### 步骤 2.3：构建（Host 编译 + Client bundle）

```bash
npm run build
# = scripts/build.sh，按以下顺序执行：
```

`scripts/build.sh` 的行为（**这是可复现的关键**）：

1. **探测 DSH_CHECKOUT**：环境变量 `DSH_CHECKOUT` → `$HOME/dsh-harness` →
   `$HOME/dsh` → `$HOME/.dsh/dsh-harness`（要求含 `packages/` 目录）。
2. **两种分支**：
   - 无 checkout：若本地 `node_modules/.bin/tsc` 存在 → `tsc -p tsconfig.json` + `npm run build:client`。
   - 有 checkout：先删除并重建 `node_modules` 下的 `cordis`、`cosmokit`、`schemastery`、
     `@standard-schema`，再把 checkout 内的
     `vendor/cordis`、`vendor/cosmokit`、`vendor/schemastery`、
     `packages/core/tools`、`packages/llm/llm`、`packages/core/system-prompt`、
     `node_modules/@types/node` 以 **junction（Windows）** 链接到本地 `node_modules`；
     再从 checkout 的 `.pnpm` 里找到 `@standard-schema+spec@*` 并链接其 spec 子目录。
   - 然后 `"$TSC" -p tsconfig.json`（checkout 的 tsc）+ `npm run build:client`。
3. **`npm run build:client` = `tsdown`**，读取 `tsdown.config.ts`：
   - 入口 `src/client/index.ts` → 输出 `lib/client.js`；
   - `format: 'cjs'`、`platform: 'browser'`、`dts: false`、`sourcemap: true`、`clean: false`；
   - **externals**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
     `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、
     `@deepseek-ai/dsh-client-runtime/client`；
   - `define` 注入 `process.env.NODE_ENV`；
   - `outputOptions`：单文件 `client.js`、**无代码分割**，且带 ModuleLoader 包装：

```js
// lib/client.js 最外层结构（由 tsdown banner/intro/footer 生成，无需手写）
var module = { exports: {} }; var exports = module.exports;
window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-session-resume",
  factory: (require) => { /* bundle 主体 */ }
});
// ...footer: return module.exports;
```

> **关键决策 2（client 包装）**：`window.__ModuleLoader__` 是 DSH Web 客户端的模块加载器。
> bundle 必须是**单文件 CJS + 无代码分割**，且 id 固定为包名；否则注入后无法被识别。

### 步骤 2.4：运行测试

```bash
npm test
# 等价于：npm run build（pretest 已声明）&& node --test "tests/*.test.mjs"
```

`package.json` 的 `test` 脚本：

```jsonc
{
  "scripts": {
    "build": "bash scripts/build.sh",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build:client": "tsdown",
    "pretest": "npm run build",
    "test": "node --test \"tests/*.test.mjs\""
  }
}
```

> 测试是**无依赖 Node 测试**（`node --test` + `node:assert/strict`），全部 import
> `../lib/index.js` 构建产物，因此**必须先构建再测试**（pretest 已保证）。
> `node --test "tests/*.test.mjs"` 自动发现 `tests/` 下的测试文件，新增测试无需改动脚本。

### 步骤 2.5：打包发布产物

```bash
mkdir -p dist
npm pack --pack-destination dist
# 生成 dist/dsh-external-dsh-session-resume-0.0.1.tgz
# files: ["lib", "cordis.patch.yml"]，故只打包 lib/ 与装配补丁
```

> `npm pack` 默认不会创建不存在的 `--pack-destination` 目录，需先 `mkdir -p dist`
> （npm 12 实测如此）。本仓库未定义 `prepack`/`prepare` 钩子，打包即直接读取现有
> `lib/`；若 `lib/` 尚未构建，先 `npm run build`。

---

## 3. 源码结构规范（复现作者按此编写 src/）

> 本节是**源码的可执行规范**：复现作者不需要读原码，而是按下面每一节的约束**写出来**，
> 并保证与本文档 + 架构文档逐条吻合。此节同时是评审清单。

### 3.1 包元数据（package.json）

```jsonc
{
  "name": "@dsh-external/dsh-session-resume",
  "version": "0.0.1",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/types/index.d.ts",
  "files": ["lib", "cordis.patch.yml",
    "lib/typert.host.js", "lib/typert.host.d.ts",
    "lib/typert.client.js", "lib/typert.client.d.ts",
    "lib/typert.remote-client.js", "lib/typert.remote-client.d.ts"],
  "private": true,
  "license": "BSD-3-Clause",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "types": "./lib/types/client/index.d.ts",
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json",
    "./types": {
      "types": "./lib/types/types.d.ts",
      "default": "./lib/types/types.js"
    },
    "./typert": {
      "types": "./lib/typert.host.d.ts",
      "default": "./lib/typert.host.js"
    },
    "./remote": {
      "types": "./lib/typert.remote-client.d.ts",
      "default": "./lib/typert.remote-client.js"
    }
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-conversation"
      ],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.0-rc <5",
    "@deepseek-ai/dsh-agent": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-attachment": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-client-runtime": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-client-ui-conversation": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-client-ui-slots": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-llm": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-session-query": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-session-persistence": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-session-reference": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-tools": ">=0.0.1-rc <2",
    "@deepseek-ai/dsh-workspace": ">=0.0.1-rc <2",
    "@deepseek-ai/schemastery": "^3.18.0"
  }
}
```

### 3.2 源码目录布局

```text
src/
  index.ts              # 插件入口：实例化 SessionResumeService、安装 typert 自愈、挂钩 agent/pre-step；导出全部能力
  typert-meta.d.ts      # 单包协议面（供 generator 与 client type-face 解析）
  shared/               # Host/Client 共用纯逻辑（无 React）
    constants.ts        # MAX_REFERENCES=3、RESUME_INSTRUCTION
    session-uri.ts      # dsh-session: base64url(JSON.stringify(sessionId)) 编解码 + mention
    session-url.ts      # /api/session.export?sessionId=... 识别与解析
    session-path.ts     # Windows/POSIX 绝对 session 日志路径识别
    source-ref.ts       # 路径/URL 统一引用扫描与计数
    resume.ts           # 客户端握手：connectResumeSession 等
    config.ts           # 全局配置：resumeInstruction + snapshotRetention（JSON 文件，原子写）
    batch-text.ts       # 批量续跑文本构建（多快照路径列表）
  host/
    types.ts            # Host 侧 DSH 服务显式接口
    session-resume-service.ts  # SessionResumeService（typert @Remote，9 端点，委托给纯域核心）
    session-log.ts      # 会话记录查找、标题/mention、日志定位
    log-materialize.ts  # readRaw -> 官方导出同构快照目录物化（snapshots/<snapshotId> + workspace-state + 裁剪）
    snapshot-store.ts   # 快照布局唯一所有者：安全路径段、缓存根、list/prune、layout 真实读取
    resume-plan.ts      # 续跑计划（工作区解析、snapshotId 复用、单/批量统一）
    resume-order.ts     # attemptId 订单幂等守卫 + 可选 WAL 持久化
    order-wal.ts        # orders.jsonl 追加式 WAL（最新行胜出、容忍坏行）
    workspace-state.ts  # 文件树清单 + git 状态扫描（有界、降级为空）
    audit.ts            # session-resume.order 结构化审计
    service.ts          # readService：统一读取注入服务（属性或 ctx.get 二选一）
    workspace.ts        # workspaceRegistry 解析/创建
  client/
    index.ts            # client 入口（ModuleLoader bundle）
    types.ts            # client 侧最小结构契约
    button.ts           # conversation.session.header.utilities「自动续跑」按钮
    dock.ts             # conversation.input.dock URL 识别 + 一键续跑 + 批量续跑入口
    dock-ui.ts          # dock/button 共用 UI 样式、状态标签、动作簇
    order.ts            # 单会话 ResumeOrder 薄包装（in-flight 去重）
    batch.ts            # 批量续跑薄包装（in-flight 去重）
    resume-executor.ts   # 单/批量共用执行器（resolve → connect → prompt 重试 → 上报）
    resume-client.ts     # 会话创建/复用、指令解析、typert remote 调用（remoteFacade）
tests/
  session-uri.test.mjs  session-url.test.mjs  session-path.test.mjs  source-ref.test.mjs
  rewrite.test.mjs      batch-key.test.mjs    legacy-surface.test.mjs
  host-path.test.mjs    resume.test.mjs       resume-plan.test.mjs
  order.test.mjs        order-wal.test.mjs    order-no-wal-empirical.test.mjs
  config.test.mjs       snapshots.test.mjs    workspace-state.test.mjs
  batch.test.mjs        client-executor.test.mjs
scripts/
  build.sh              # Host 编译 + client bundle（junction 链）
  release.ps1           # 打包发布产物
  e2e-final.mjs         # 真机 typt 网关 9 端点断言
  e2e-user-click.mjs    # 真实点击数字增量断言
docs/
  README.md  session-resume-architecture.md  verification.md  reproduction-guide.md
  CHANGELOG.md  native-migration-runbook.md  # 本指南即在其中
.github/workflows/ci.yml
```

### 3.3 Host 入口契约（src/index.ts 必须导出）

```ts
export const name = '@dsh-external/dsh-session-resume'
export const inject = [
  'webServer', 'sessionQuery', 'sessionPersistence',
  'sessions', 'workspaceRegistry', 'attachments', 'typert',
]
// 声明模块：'agent/pre-step'(payload, next) 事件
// 导出：SessionResumeService / SESSION_RESUME_SERVICE_KEY / RemoteResolveResult
//       rewriteText / MAX_REFERENCES / RESUME_INSTRUCTION
// apply(ctx):
//   ctx.effect(() => { new SessionResumeService(ctx) }, 'session-resume: remote service')
//   installTypertSelfHeal(ctx)   // reload 后重挂被 withdraw 的 sessionResume/* 命名空间
//   ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
//       decision = await next()
//       if kind !== 'enter' return decision
//       对每条 user 文本块调用 rewriteMessage -> 把旧 export URL 改写为 mention
//   }), 'session-resume: pre-step')
```

上面 ts 块对应 Host 半区。Client 半区（`src/client/index.ts`）另外挂载 remote：

```ts
export const inject = ['slots', 'sessions', 'workspaces', 'remote']
// apply(ctx):
//   ctx.effect(() => remote.$mount(TYPERT_REMOTE), 'session-resume: remote mount')
//   ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', '自动续跑' 按钮))
//   ctx.effect(() => ctx.slots.inject('conversation.input.dock', 路径识别 dock))
```

> **传输真相：** 不经过自建 HTTP。Host 暴露 `ctx.remote.sessionResume.*`；Client 经
> `remoteFacade(ctx)`（优先 `ctx.get('remote.sessionResume')`，回退 `ctx.remote.sessionResume`）调用。

### 3.4 Remote 契约（ctx.remote.sessionResume.*）

见 `docs/session-resume-architecture.md` §5。要点（参数一律必填，空串/空对象表缺省）：

- `resolveFromText(text)` / `resolveSession(sessionId)` / `resolveLogPath(sessionId)`：
  从文本 / id 解析源会话。
- `resolvePlan(sessionId, attemptId, snapshotId)`：单会话续跑计划
  （`snapshotId` 命中则复用历史快照；不解析时 `{ok:false,status,error}`）。
- `resolveBatchPlan(sessionIds, attemptId, snapshotIds)`：批量续跑计划，`sessionIds[0]` 为主键串行。
- `completeResume(attemptId, status, targetSessionId, error)`：`accepted|failed` 终态；同 attempt 幂等。
- `getConfig()` / `setConfig(config)` / `listSnapshots(sessionId)`：配置读写与历史快照列表。
- 审计：每次计划解析输出一行结构化审计（`attemptId/sourceSessionId/targetWorkspaceId/status`）。

### 3.5 物化目录契约

```text
%TEMP%\dsh-session-resume\<sessionId>\
  <raw.filename>                                # 根 artifact（如 session.jsonl）
  subagents\<safeId>\<filename>                 # 每个后代
  media\<safeAttachmentId>.<ext>               # 图片附件
```

- `<safeId>` = 全安全字符 ID 保持原名；非安全 ID（如 `sha256:<digest>`）映射为
  `~<sanitized>_<sha256摘要>`；未知 mediaType **fail-closed 跳过并记录**（不落 `.undefined`）。
- 文件名 fail-closed：拒绝 `..`、`/`、`\`、绝对路径、超长。
- 物化前要求 `sessionPersistence.supportsRawArtifacts === true` 且附件服务可用；
  live 会话先 `sessions.flush()`；不可用返回 501，不产生残缺目录。

### 3.6 续跑文本

单条消息最多 3 个不同路径/会话（`MAX_REFERENCES=3`，与官方一致）。

```text
<path> 请继续这个会话：直接读取上述日志快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续。若快照缺失或不可读，请如实说明。
```

> 唯一事实源是 `src/shared/constants.ts` 的 `RESUME_INSTRUCTION`（另由
> `tests/resume.test.mjs` 冻结断言全文）；本示例仅为文档快照，若与常量不一致，
> 以常量与测试为准。自动流程（Header/Dock）统一经 `buildResumePrompt`（`src/shared/resume-text.ts`）拼前缀。

### 3.7 客户端握手（src/client/resume-client.ts 行为）

```text
if (target.workspaceId && workspaces?.connectWorkspace)  -> connectWorkspace(workspaceId)
else if (target.workspaceId)                              -> sessions.create({ workspaceId })
else                                                      -> 抛「没有续跑目标工作区」并停止
sessions.open(newId)
binding(newId).session.prompt([{ type: "text", text }], "queue")  // 同一 newId 上重试
```

- `prompt()` 失败：复制到剪贴板 + 显示失败状态，不静默丢消息，也不重复创建新会话。
- Header 与 Dock 共用同一执行器，并按 `sessionId` 共享 Promise 防重复下单。

---

## 4. 注入与运行验证

### 方式 A：注入器一键注入（推荐，运行中 DSH Web）

在 DSH 注入器环境（拥有 `dev_inject_plugin` 工具的开发会话）中：

```text
dev_inject_plugin <本仓库绝对路径>
```

- 该工具在本仓库目录建 junction → 动态 `loader.create`，**不重启即可生效**。
- 注入成功后 `dev_plugin_status` 应看到本插件 active，
  且 `dev_injected_list` 出现本包目录与注入时间。

### 方式 B：切换为 bundle 装配（可选，与 super 互斥）

当前默认通道是 super-injector，registry 条目会在 DSH 启动时 autoRestore，所以“重启后仍生效”
已由 super 通道满足。只有主动切换通道时才用本方式：

1. 先从 `~/.dsh/super-injector/registry.json` 移除本包条目。
2. 确认插件包声明 `dsh.bundle.patch`，且 `cordis.patch.yml` 随安装包存在。
3. 再把本包加入 profile 的 `dependencies` 与 `dsh.profile.bundles`
   （`dev_install_package` 可免重启热装配，但会同时写入 profile bundles 装配链）。
4. 重启后验证 `sessionResume/*` remote 命名空间只注册一次（reload 后被 self-heal 重挂仍稳定 LIVE）。

bundle 与 super 不能并存；同时存在会重复 apply，报 `duplicate prefix route`。

### 验证清单（复现 → 确认行为一致）

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | `npm ci && npm run typecheck && npm test` | 全部 PASS，`lib/` 生成且含 `lib/typert.*` |
| 2 | 刷新 DSH Web，打开任意会话 | Header utilities 槽出现「自动续跑」按钮 |
| 3 | 点击「自动续跑」 | `resolvePlan` 成功；新会话在原工作区打开；首条消息含目录路径 + 续跑指令 |
| 4 | Host 日志 | 出现 `session-resume.order` 审计行；`completeResume` accepted 落入 WAL |
| 5 | 旧路径兼容 | 粘贴旧 export URL → 输入框出现识别条；直接发 URL 被 pre-step 改写为 mention |
| 6 | 契约回归 | 缺 sessionId → `{ok:false,status:400}`；未知会话 → 404；冲突终态 → 返回当前终态 |
| 7 | 物化一致性 | `%TEMP%\dsh-session-resume\<sid>\` 与官方 export ZIP 解压逐字节一致（安全 ID；非安全 ID 走防碰撞映射） |

> 完整 E2E 实测记录见 `docs/verification.md`；本文不再重复。

---

## 5. CI 复现

`.github/workflows/ci.yml`：

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```

复现 CI ≈ 本地执行上述三条命令。

---

## 6. 常见坑（复现时对照）

1. **`npm install` 而非 `npm ci`**：会解析出不同版本 → 用 `npm ci`。
2. **`EALLOWSCRIPTS`（npm ≥ 11）**：若环境注入了 `npm_config_allow_scripts`，
   `npm ci` 在项目级被拒。解法：`env -u npm_config_allow_scripts npm ci`
   （本仓库依赖均无 install 脚本；详见 2.1 节）。**不要**在项目 .npmrc 写
   `allow-scripts`——npm 12 项目级声明同样被拒，且属绕过环境策略。
3. **`npm pack --pack-destination dist` 报 ENOENT**：npm 不自动创建
   `--pack-destination` 目录，先 `mkdir -p dist`。
4. **无 checkout 但本地无 tsc**：`npm install` 未安装 devDependencies → 先 `npm ci`。
5. **Windows 上 junction 失败**：build.sh 已用 `process.platform === 'win32' ? 'junction' : 'dir'`，
   但需管理员/开发者模式权限；失败则检查 `node_modules/@deepseek-ai` 下的链接是否存在。
6. **client bundle 无法注入**：确认 `tsdown.config.ts` 的 banner/footer 包装与
   externals 未被改动，`lib/client.js` 开头必须包含 `window.__ModuleLoader__.load(...)`。
7. **`dsh-client-ui-conversation -> dsh-token-meter -> dsh-compact` 解析冲突**：
   `.npmrc` 必须是 `legacy-peer-deps=true`。
8. **Cordis Proxy 读未声明属性抛错**：任何对测试缓存目录的读取须先 `Reflect.has` 探测
   （详见架构文档 §9、CHANGELOG）。
9. **`lib/` 中 `client/` 目录与 `client.js` 并存**：这是 tsc 镜像（`src/client/*.ts`）
   与 tsdown 单文件 bundle（`src/client/index.ts`）的正常共存，不要删任一。
10. **client 读 `ctx.remote.sessionResume` 报 `without inject`**：须先 `remote.$mount(TYPERT_REMOTE)` 挂载，
   并经 `remoteFacade`（`ctx.get('remote.sessionResume')` 优先）取用，不要裸读属性。
11. **Host 端 `sessionResume/*` 被 withdraw**：reload/re-inject 可能把 typert 注册抽离成 withdrawn，
    网关拒调。由 `installTypertSelfHeal` 在 `hasSeen && get()===undefined` 时自动重挂 + 轮询兜底；
    若失效先确认 `src/index.ts` 的自愈守卫在位。
12. **Remote 方法可选参数**：typert 协议不支持可选参数（SRC 不表达缺省）。所有 `@Remote` 方法
    参数一律必填，缺省用空串/空对象在方法体内表示；不要手写"可选参数"。

---

## 7. 判定「复现成功」的验收清单

- [ ] 空仓库 `git clone` 后 `npm ci` 成功（命中 lockfile）。
- [ ] `npm run typecheck` exit 0。
- [ ] `npm test` 自动发现 `tests/` 下全部测试文件并 PASS。
- [ ] `npm run build` 生成 `lib/index.js`、`lib/client.js`、`lib/types/`；
      client bundle 含 ModuleLoader 包装。
- [ ] `npm pack --pack-destination dist` 生成 `dist/...tgz`，内容含 `lib/` 与 typert 产物。
- [ ] 注入后 GUI 出现「自动续跑」按钮，点击后新会话收到续跑指令。
- [ ] `ctx.remote.sessionResume.*`（resolvePlan / resolveBatchPlan / completeResume / getConfig / …
      ）与架构文档契约一致；终端 session 冲突幂等。
- [ ] Host reload/re-inject 后 `sessionResume/*` 仍 LIVE（self-heal 未漂回 withdrawn）。
- [ ] 物化目录与官方 export ZIP 逐字节一致（安全 ID；非安全 ID 走防碰撞映射）。
