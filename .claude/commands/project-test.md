執行專案的完整測試套件。依序執行以下步驟：

```bash
conda activate aiagent

echo "=== 1. TypeScript 型別檢查 ==="
bun run typecheck

echo ""
echo "=== 2. 單元測試 ==="
bun test tests/unit/ 2>/dev/null || echo "尚未找到單元測試"

echo ""
echo "=== 3. 整合測試 ==="
if curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/v1/models 2>/dev/null | grep -q "200"; then
  echo "LiteLLM proxy 執行中 — 執行整合測試"
  LITELLM_URL=http://localhost:4000 TEST_MODEL=qwen3.5:9b bun test tests/integration/ 2>/dev/null || echo "尚未找到整合測試"
else
  echo "⚠️  LiteLLM proxy 未執行 — 跳過整合測試"
  echo "   啟動方式：litellm --model ollama/qwen3.5:9b --port 4000 --drop_params"
fi

echo ""
echo "=== 4. 建構檢查 ==="
bun run build 2>&1 | tail -5
```

執行完畢後，總結：
- 多少測試通過/失敗
- 是否有型別錯誤
- 建構是否成功
- 修復任何失敗的建議

不要自動修復任何東西 — 僅報告結果並詢問我如何處理。
