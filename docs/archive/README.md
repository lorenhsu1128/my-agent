# 歸檔文件

本目錄收納**已完成 milestone 的規劃文件**與**早期歷史文件**。內容凍結
於該 milestone ship 時的狀態，僅供回查設計脈絡。**不是當前文件**。

當前狀態請看 [CLAUDE.md](../../CLAUDE.md) 開發日誌與 [README.md](../../README.md)。

| 檔案 | 對應已完成項目 | Ship 日期 |
|---|---|---|
| `DEPLOYMENT_PLAN.md` | M1 — llama.cpp 本地模型支援（fetch adapter） | 2026-04-15 |
| `M_SP_PLAN.md` | ADR-008 / M-SP — System Prompt 外部化 | 2026-04-19 |
| `M_TOKEN_PLAN.md` | M-TOKEN — llamacpp 真實 cache token 計數 | 2026-04 |
| `M_VISION_PLAN.md` | M-VISION / M6 — llamacpp 多模態支援 | 2026-04-19 |
| `USER_MODELING_PLAN.md` | M-UM — `USER.md` 雙層使用者建模 | 2026-04 |
| `SKILL_SELF_CREATION_PLAN.md` | M6b — Skill 自主建立（Self-Improving Loop） | 2026-04-17 |
| `AUTODREAM_HERMES_MERGE_ANALYSIS.md` | M6 三階段 — AutoDream × Hermes 合併分析 | 2026-04-17 |
| `CLAUDE_CODE_GUIDE.md` | 早期 FreeHermes 開發工作流程指南（已被 CLAUDE.md / MY-AGENT.md 取代） | — |
| `changes.md` | Codex API 支援的舊 PR 描述 | — |

如需查閱某段歷史脈絡：

```bash
git log --follow docs/archive/<檔名>     # 追溯該檔的修改史（含搬遷前路徑）
```
