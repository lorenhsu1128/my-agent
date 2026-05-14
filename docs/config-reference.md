# Config 設定檔總索引

> 本檔由 `bun run docs:gen` 自動產生連結表格。

## 來源優先序（所有 my-agent config 一致）

1. **Env var override**（最高）— 對應 env 存在且非空字串時
2. **`~/.virtual-assistant-desktop/<config>.jsonc`** 檔案值
3. **Schema default**（最低）

讀檔 / parse / schema validation 任一失敗 → fallback 到 schema default 並 stderr warn 一次。

<!-- AUTO-GENERATED-START — 跑 `bun run docs:gen` 重新產生 -->

## Config 一覽

| Config | 路徑 | 詳細欄位 |
|---|---|---|
| llamacpp | `~/.virtual-assistant-desktop/llamacpp.jsonc` | [docs/config-llamacpp.md](config-llamacpp.md) |
| web | `~/.virtual-assistant-desktop/web.jsonc` | [docs/config-web.md](config-web.md) |
| discord | `~/.virtual-assistant-desktop/discord.jsonc` | [docs/config-discord.md](config-discord.md) |
| global | `~/.virtual-assistant-desktop/.virtual-assistant-desktop.jsonc` | _(無 zod schema，請見 `src/utils/config.ts:184` GlobalConfig type)_ |
| system-prompt | `~/.virtual-assistant-desktop/system-prompt/` | _(純 markdown 文本，無 schema；外部化 sections 在 `src/systemPromptFiles/sections.ts`)_ |

<!-- AUTO-GENERATED-END -->
