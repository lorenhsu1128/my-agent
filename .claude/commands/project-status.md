給我一份簡潔的專案狀態報告。執行以下步驟：

1. 讀取 TODO.md 並計算：
   - 總任務數：符合 `- [ ]` 或 `- [x]` 的行
   - 已完成任務數：符合 `- [x]` 的行
   - 顯示當前里程碑名稱和階段

2. 顯示最近 5 個 git commit：
   ```
   conda activate aiagent && git log --oneline -5
   ```

3. 執行 typecheck 並報告結果（通過/失敗，如有錯誤則報告數量）：
   ```
   conda activate aiagent && bun run typecheck 2>&1 | tail -5
   ```

4. 檢查 LiteLLM proxy 是否可連線（如與當前里程碑相關）：
   ```
   curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/v1/models 2>/dev/null || echo "未執行"
   ```

5. 檢查 Ollama 是否執行中：
   ```
   curl -s -o /dev/null -w "%{http_code}" http://localhost:11434/v1/models 2>/dev/null || echo "未執行"
   ```

6. 列出已修改但未提交的檔案：
   ```
   git status --short
   ```

以簡潔的摘要呈現所有結果。不要開始處理任何任務 — 僅報告狀態。
