# dsh-session-resume 文档索引

本目录是插件的全部文档入口。按"读者想做什么"组织，避免在源码里翻找说明。

## 快速开始

- [使用说明](../README.md)：安装、用法、原理、边界与限制、构建与注入。

## 设计与实现

- [架构文档](session-resume-architecture.md)：总体拓扑、主流程、模块职责、技术选型（ts 而非 tsx/js）、Host API 契约、握手协议、路径识别、兼容旧流程、已知限制。
- [复现指南](reproduction-guide.md)：不读源码、从零重建本插件的可执行技术规范（环境、构建、注入、CI、验收清单）。

## 验证与质量

- [验证报告](verification.md)：真实 Host API 与 Playwright E2E 实测结果、测试覆盖、残余风险；
  含 live API 冒烟脚本 `scripts/smoke-api.mjs` 的 9/9 实测记录。
- [热核评审综合报告](thermo-nuclear-review-consolidated.md)：全部热核评审轮次的单份汇总
  （轮次时间线、去重后的主发现清单与状态、保留的文档化说明、当前验证基线）。

## 变更记录

- [变更历史](CHANGELOG.md)：关键决策与已验证事实，按日期记录。

## 文档约定

- 所有文档为 UTF-8 纯文本 Markdown，无 emoji。
- 只写不易过时、久经考验、忠诚的内容：不记录文件行数、测试数量、拆分细节等会随重构变化的描述。
- 产物（`lib/`、`dist/`、`node_modules/`）不入版本库，构建命令见 README「验证」一节。