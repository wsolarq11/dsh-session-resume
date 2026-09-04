# （已归档）续跑失败「lacks an identified message」诊断记录

本文件是早期一次**具体问题诊断**（含具体会话 id / seq 样本）。为保持活文档、避免具体样本随时间漂移，
诊断的**机制、根因与当前缓解**已提炼并迁移到新文档：

- `docs/legacy-surface-known-issue.md`（活文档，已知缺陷+当前缓解）

当时的诊断结论（仍成立）已并入新文档：旧引擎无 `id` 的 `user/message` 记录仅在"续跑用的 query
读路径未套用 `migrateLegacyMessageEvent`"时报错；插件以 `sessionId + seq` 为锚、不依赖 `message.id`；
对 legacy 源走快照路径续跑，已由 `tests/legacy-surface.test.mjs` 覆盖。

> 归档性质：本文不再更新。机制与缓解见上方指向；本目录其余文件（`docs/参考资料/tools/` 的诊断脚本）仍可作工具使用。