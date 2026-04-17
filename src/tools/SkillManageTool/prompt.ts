export const prompt = `SkillManage — 建立、修改、刪除可重用的 skill。

## 何時使用
- 完成複雜任務（5+ 個工具呼叫）後，將方法保存為 skill
- 修復棘手錯誤或發現非顯而易見的 workflow 後
- 使用 skill 時發現過時或錯誤，立即 patch 修正
- 用戶要求建立或修改 skill

## Actions

### create
建立新 skill。需要 name（小寫、連字號）和 content（完整 SKILL.md，含 YAML frontmatter）。
Frontmatter 必須包含 name 和 description 欄位。

### edit
完整重寫已有 skill 的 SKILL.md。需要 name 和 content。

### patch
對 SKILL.md 做局部修改。需要 name、old_string、new_string。
預設要求唯一匹配；設 replace_all=true 替換所有匹配。
可選 file_path 指定修改支援檔案（預設 SKILL.md）。

### delete
刪除整個 skill 目錄。需要 name。

### write_file
寫入支援檔案到 skill 目錄下。需要 name、file_path、file_content。
file_path 必須在 references/、templates/、scripts/、assets/ 子目錄下。

### remove_file
移除 skill 目錄下的支援檔案。需要 name 和 file_path。

## SKILL.md 格式

\`\`\`markdown
---
name: skill-name
description: 一行描述
when_to_use: 觸發條件描述
allowed-tools:
  - Bash(bun:*)
  - Read
  - Edit
---

# Skill 標題

## Steps
1. 步驟一
2. 步驟二
\`\`\`

## 安全限制
所有寫入操作都經過安全掃描。包含危險模式（rm -rf、curl 外洩、prompt 注入等）的內容會被阻擋。
`
