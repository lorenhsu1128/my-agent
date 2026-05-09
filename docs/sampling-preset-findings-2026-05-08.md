# Sampling Preset 與 Prompt 工程驗證紀錄（2026-05-08）

> 一次完整的 E2E 測試紀錄：sampling preset 行為刻劃 + prompt engineering 驗證。
>
> 平台：my-agent (Windows 11) → TCQ-shim:8081 → Qwen3.5-9B Q4_K_M (256k turbo4 reasoning=on)
> 模型：qwen3.5-9b（GPU：RTX 5070 Ti Laptop 12GB）

---

## TL;DR

1. **Qwen3.5-9b 在大 system prompt 下，``` fence 區塊內的 code 模型完全看不見**（thinking-coding 100% 失敗）
2. **唯一可靠的 prompt 寫法**：(a) 短 code 用 inline `` ` `` backtick，(b) 長 code 寫 fixture 檔讓模型用 Read 工具讀
3. **加強指令、plain-text 縮排都救不了** ``` fence 問題
4. **thinking-coding** 是「精準 coding」preset，但 **不適合 refusal 類任務**（拒絕率 0%；thinking-general 也只有 20%）
5. **B2/E1 在所有 preset 下都會觸發 tool-loop**（27+ tool calls 3-10 min）— 是 prompt 結構問題不是 preset 問題

---

## 測試設計總覽

| 階段 | 範圍 | 樣本 | 主要發現 |
|------|------|------|----------|
| 1. 4-preset 對照（v3-myagent 12 case） | thinking-general / coding / instruct-general / instruct-reasoning | 48 runs | thinking-general 唯一全綠（12/12）；preset 間結果差距大 |
| 2. thinking-coding 24-case 深度（v3-coding-deep） | 9 類 24 case 單跑 | 24 runs | 17/24 (70.8%)；強項算法/code-review/tool-heavy；弱項 bug-fix 0/3 |
| 3. 7-fail diagnostic（dump full text） | 7 個失敗 case 完整 dump | 7 runs | 4/7 是 ``` fence 問題；1 個 shim parser、1 個 preset、1 個 regex 嚴 |
| 4. Rate verify（隨機性） | thinking-coding × fence × N=5；thinking-general × F2 × N=5 | 20 runs | fence 100% 失敗（決定性，非隨機）；F2 thinking-general 20% 拒絕率 |
| 5. Prompt variants V1-V3 | thinking-coding × 3 case × 3 變體 × N=3 | 27 runs | V1 fence 0%、V2 強調指令 0%、V3 inline 89% |
| 6. V4 plain-text 縮排 | 同上 × V4 × N=3 | 9 runs | 0% — 縮排沒救 |
| 7. V5 fixture+Read | 同上 × V5 × N=3 | 9 runs | 78% — 慢但穩 |

**總跑量**：~144 runs，wall-clock 約 5-6 小時。

---

## Sampling Preset 對照（1：4-preset × v3-myagent）

| Preset | 參數（temp/top_p/top_k/min_p/presence_p） | Pass | 總時間 | 備註 |
|--------|-------------------------------------------|------|--------|------|
| **thinking-general** | 1.0 / 0.95 / 20 / 0 / 1.5 | **12/12 ✅** | 425s | 全綠但 D8.1 拒絕花 154s |
| thinking-coding | 0.6 / 0.95 / 20 / 0 / 0.0 | 11/12 | **296s ⚡** | 收斂最快；D8.1 refusal 失敗 |
| instruct-general | 0.7 / 0.8 / 20 / 0 / 1.5 | 11/12 | 330s | D6.1 analyze 失敗 |
| instruct-reasoning | 1.0 / 0.95 / 20 / 0 / 1.5 | 8/12 | 262s | 4 fail（D2/D5/D6/D8）|

**警示**：thinking-general 與 instruct-reasoning 參數完全相同（差別僅在 thinking 強制開關），但結果差 4 case — sampling 隨機性對單次跑樣本影響大。**N=1 樣本不足以做 preset 採用決策**。

---

## thinking-coding 24-case 深度（2）

按類型分組 pass rate：

| 類型 (case 數) | Pass | 觀察 |
|---------------|------|------|
| algorithm (3) | **3/3 ✅** | 強項：fibonacci / binsearch / LRU 全寫對 |
| **bug-fix (3)** | **0/3 ❌** | **全敗**：B2 timeout 594s；B1/B3 模型沒看到 fence 內 code |
| refactor (3) | 2/3 | C1/C2 ✅；C3 沒看到 fence code |
| code-review (3) | **3/3 ✅** | 100% 完美 |
| multi-file (3) | 2/3 | E1 timeout 379s 16k chars Grep loop |
| negative (3) | 2/3 | F1 俳句 ✅、F3 含糊 ✅、F2 拒絕 ❌ |
| streaming (2) | **2/2 ✅** | 大檔讀取 + 質數列舉穩定 |
| tool-heavy (2) | **2/2 ✅** | 9-24 tool call chain 全 OK |
| retry (2) | 1/2 | I1 被外部殺掉、I2 ✅ |

**強項**：算法 / code review / tool 鏈 / 長 stream
**弱項**：fence 框 buggy code（0/3）、refusal（0/3）

---

## 7-fail 根因分類（3）

| Case | 假設根因 | 驗證後真因 |
|------|---------|-----------|
| B1 修 off-by-one | regex 嚴 | **``` fence 內 code 不可見** — thinking 自述「沒看到 code」 |
| B2 修 missing await | tool loop | 同上 + tool loop（找不到原檔不斷搜） |
| B3 修 TS narrowing | regex 嚴 | 同 B1 |
| C3 if-else→switch | regex 嚴 | 同 B1 |
| E1 找 callers | tool loop | **shim Qwen pythonic-XML tool format 漏出** — 連續 Grep 16k chars |
| F2 拒絕訂機票 | regex 嚴 | **preset 特性** — thinking-coding 偏「執行」而非「拒絕」 |
| I1 retry | 模型錯 | **regex 嚴** + 我手動殺到 — 模型實際答對 |

---

## Rate Verify：隨機性 vs 決定性（4）

驗 「``` fence 失敗是隨機還是決定性？」

| 測試 | Sampling | N | Pass rate | 結論 |
|------|----------|---|-----------|------|
| B1/B3/C3 ``` fence | thinking-coding | 5 | **0/15 (0%)** | **決定性失敗** |
| F2 訂機票 | thinking-general | 5 | 1/5 (20%) | 80% 模型試圖收集資訊執行 |

**關鍵發現**：thinking-coding 對 ``` fence 內 code 的失敗 **不是 sampling 隨機性，而是 deterministic 行為**。

---

## Prompt Engineering 5 變體（5+6+7）

針對「修 buggy code」3 個 case（B1/B3/C3）試 5 種 prompt 寫法：

| Variant | 範例（B3） | B1 | B3 | C3 | 總 |
|---------|-----------|-----|-----|-----|-----|
| **V1** ``` fence | <code>下面 TS：```ts<br>function len(x: string\|null) {...}<br>```<br>修</code> | 0/3 | 0/3 | 0/3 | **0%** |
| **V2** fence + 強調指令 | <code>**重要：以下訊息中已附完整代碼**<br>```ts<br>...<br>```</code> | 0/3 | 0/3 | 0/3 | **0%** |
| **V3** inline backtick ⭐ | <code>修正 \`function len(x: string\|null) { return x.length; }\` — 錯誤是...</code> | 3/3 | 2/3 | 3/3 | **89%** |
| **V4** plain-text 縮排 | <code>下面 TS：<br><br>    function len(x: string\|null) {<br>      return x.length;<br>    }<br><br>修</code> | 0/3 | 0/3 | 0/3 | **0%** |
| **V5** fixture+Read ⭐ | <code>用 Read 讀 tests/fixtures/B3-buggy-len.ts，給最簡修法。</code> | 2/3 | 2/3 | 3/3 | **78%** |

### 結論

只有兩種寫法可行：
- **V3 inline `` ` ``**：適合單行短 code（< ~150 字元），**89% 通過率**
- **V5 fixture+Read**：適合多行長 code，**78% 通過率**（慢一倍）

完全無效：
- V1/V2 ``` fence — 100% 失敗（即便加強調指令）
- V4 plain-text 縮排 — 100% 失敗（模型不認得縮排是 code）

---

## 對 my-agent 設計的具體建議

### 1. Prompt 模板（給 Qwen 模型）

```ts
// ❌ 不要這樣寫（thinking-coding 100% 失敗）
const prompt = `修這段 bug：
\`\`\`js
${code}
\`\`\`
`;

// ✅ 短 code 用 inline backtick
const prompt = `修這個 bug：\`${code.replace(/\n/g, ' ')}\` — ${context}`;

// ✅ 長 code 寫 fixture 檔
fs.writeFileSync('tests/fixtures/buggy.js', code);
const prompt = `用 Read 讀 tests/fixtures/buggy.js，${task}。`;
```

### 2. Sampling preset 適用任務矩陣（建議 metadata.taskType 分流）

| 任務類型 | 建議 preset | 注意事項 |
|---------|------------|---------|
| 算法實作 / 純寫 code | thinking-coding | 強項 |
| Read + 分析 / code review | thinking-coding | 強項 |
| Tool chain / multi-step | thinking-coding | 強項 |
| 修 buggy code | thinking-coding **+ V3 或 V5 prompt** | 必須避開 ``` fence |
| Refusal / 含糊澄清 | thinking-general | 但仍只 20-66% 拒絕率 |
| 創作 / 寫詩 | thinking-general | temperature=1 探索性高 |
| 簡短摘要 / 已知事實 | instruct-general | 低 top_p=0.8 簡潔 |

### 3. 已知 prompt 結構性 bug

- **B2「修 missing await」prompt 觸發 tool-loop**：低溫也壓不住，模型反覆 Grep/Bash 找原檔。建議改 fixture+Read 寫法
- **E1「找 callers」觸發 Qwen pythonic-XML tool format 漏出**：shim 端 parser 問題，可能要 GBNF 強制（M-TCQ-SHIM-2-5 已知 defer）

### 4. 測試框架改進

- 對 thinking-coding 跑 buggy code 類測試 → 改用 fixture
- 跑 v3-myagent / v3-coding-deep 等批次 → 加入 per-case 全域 timeout（Windows SIGKILL 對 bun child 不可靠）
- regex 應放寬 / 加 dump body 機制以區分「regex 嚴」vs「真錯」

---

## 已驗證但本次未深入的議題

- **thinking-general vs instruct-reasoning 參數相同結果差** — 隨機性影響大，N≥3 才能下結論
- **F2 在 instruct-general/instruct-reasoning 拒絕率** — 未跑（會是 A 方案）
- **fixture path 透露給模型造成 retry loop** — V5 r3 觀察到，未深入

---

## 檔案產出

| 檔案 | 內容 |
|------|------|
| `stress-results/preset-comparison/comparison.md` | 4-preset × 12 case 對照表 |
| `stress-results/coding-deep-tc-only/thinking-coding.log` | 24-case raw log |
| `stress-results/diagnostic/_index.md` + `<case>.md` | 7 fail 完整 dump |
| `stress-results/rate-{fence,refusal}.md` | rate verify 結果 |
| `stress-results/prompt-variants.md` | V1/V2/V3 比較 |
| `stress-results/v4-plaintext.md` | V4 結果 |
| `stress-results/v5-fixture.md` | V5 結果 |
| `tests/fixtures/preset-verify/*` | V5 用的 buggy code fixtures |
| `vendor/node-llama-tcq/scripts/live-test-{coding-deep,coding-fast,failure-diagnostic,rate-verify,prompt-variants,v4-plaintext,v5-fixture}.ts` | 7 支測試 driver |

---

執行：Loren · 2026-05-08
