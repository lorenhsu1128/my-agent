// 解析 stress-results/preset-comparison/*.log → markdown 對照表
//
// 每個 log 檔有 12 行 case 結果，格式：
//   ✅ D1.1 ...                    17305ms ttft=12622ms  in= 15931t  out= 270t/ 15.6t/s  think=213ch text=214ch turns=1 text~/...
//   ❌ ... timeout/note
//
// 末尾 "Overall: N/M 通過率 X%" + Failed cases 列表

import * as fs from 'node:fs'
import * as path from 'node:path'

type CaseRow = {
  case: string
  ok: boolean
  timeMs: number
  ttftMs: number | null
  inTok: number
  outTok: number
  rate: number
  thinkCh: number
  textCh: number
  turns: number
  tools: string[]
  note: string
}

const LINE_RE =
  /^\s*([✅❌])\s+(\S+\s+\S+(?:\s+\S+)*?)\s+(\d+)ms(?:\s+ttft=\s*(\d+)ms)?\s+in=\s*(\d+)t\s+out=\s*(\d+)t\/\s*([\d.n/a]+)t\/s\s+think=(\d+)ch\s+text=(\d+)ch\s+turns=(\d+)(?:\s+tools=\[([^\]]*)\])?\s*(.*)$/u

function parse(file: string): CaseRow[] {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const rows: CaseRow[] = []
  for (const line of lines) {
    const m = LINE_RE.exec(line)
    if (m == null) continue
    rows.push({
      ok: m[1] === '✅',
      case: m[2].trim(),
      timeMs: Number(m[3]),
      ttftMs: m[4] ? Number(m[4]) : null,
      inTok: Number(m[5]),
      outTok: Number(m[6]),
      rate: Number(m[7]) || 0,
      thinkCh: Number(m[8]),
      textCh: Number(m[9]),
      turns: Number(m[10]),
      tools: m[11] ? m[11].split(',').filter(Boolean) : [],
      note: (m[12] ?? '').trim(),
    })
  }
  return rows
}

function caseKey(name: string): string {
  // "D1.1 薛丁格時間演化算符" → "D1.1"
  const m = /^(D\d+\.\d+)/.exec(name)
  return m ? m[1] : name
}

const dir = path.join(__dirname, 'preset-comparison')
const presets = ['thinking-general', 'thinking-coding', 'instruct-general', 'instruct-reasoning']
const data: Record<string, Record<string, CaseRow>> = {}
for (const p of presets) {
  const f = path.join(dir, `${p}.log`)
  if (!fs.existsSync(f)) {
    console.error(`Missing: ${f}`)
    continue
  }
  data[p] = {}
  for (const r of parse(f)) data[p][caseKey(r.case)] = r
}

// 收集所有 case key（依出現順序）
const allKeys: string[] = []
const seen = new Set<string>()
for (const p of presets) {
  for (const k of Object.keys(data[p] ?? {})) {
    if (!seen.has(k)) {
      seen.add(k)
      allKeys.push(k)
    }
  }
}

// ---- markdown 輸出 ----
const out: string[] = []
out.push('# Sampling Preset 對照（live-test-realistic-v3-myagent）\n')
out.push('Model: qwen3.5-9b (Q4_K_M)  Shim: TCQ :8081 (256k turbo4 reasoning=on)\n')
out.push(`執行: ${new Date().toISOString()}\n`)

out.push('## Preset 參數\n')
out.push('| Preset | temp | top_p | top_k | min_p | presence_penalty | repetition_penalty |')
out.push('|--------|------|-------|-------|-------|------------------|--------------------|')
const presetParams: Record<string, [number, number, number, number, number, number]> = {
  'thinking-general': [1.0, 0.95, 20, 0.0, 1.5, 1.0],
  'thinking-coding': [0.6, 0.95, 20, 0.0, 0.0, 1.0],
  'instruct-general': [0.7, 0.8, 20, 0.0, 1.5, 1.0],
  'instruct-reasoning': [1.0, 0.95, 20, 0.0, 1.5, 1.0],
}
for (const p of presets) {
  const [t, tp, tk, mp, pp, rp] = presetParams[p]
  out.push(`| ${p} | ${t} | ${tp} | ${tk} | ${mp} | ${pp} | ${rp} |`)
}

// 1. 總覽：每 preset 通過率 + 總時間
out.push('\n## 總覽\n')
out.push('| Preset | Pass | Total Time | Total in | Total out | Total think (ch) | Avg ttft |')
out.push('|--------|------|-----------|----------|-----------|------------------|----------|')
for (const p of presets) {
  const rs = Object.values(data[p] ?? {})
  const pass = rs.filter((r) => r.ok).length
  const total = rs.length
  const time = rs.reduce((s, r) => s + r.timeMs, 0)
  const ti = rs.reduce((s, r) => s + r.inTok, 0)
  const to_ = rs.reduce((s, r) => s + r.outTok, 0)
  const think = rs.reduce((s, r) => s + r.thinkCh, 0)
  const ttfts = rs.map((r) => r.ttftMs).filter((x): x is number => x != null)
  const avgTtft = ttfts.length > 0 ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0
  out.push(
    `| ${p} | ${pass}/${total} | ${(time / 1000).toFixed(1)}s | ${ti} | ${to_} | ${think} | ${avgTtft}ms |`,
  )
}

// 2. 逐 case 對照（PASS/FAIL）
out.push('\n## 逐 Case PASS/FAIL\n')
out.push('| Case | thinking-general | thinking-coding | instruct-general | instruct-reasoning |')
out.push('|------|------------------|-----------------|------------------|--------------------|')
for (const k of allKeys) {
  const cells = presets.map((p) => {
    const r = data[p]?.[k]
    if (r == null) return '–'
    return `${r.ok ? '✅' : '❌'} ${(r.timeMs / 1000).toFixed(1)}s`
  })
  out.push(`| ${k} | ${cells.join(' | ')} |`)
}

// 3. thinking chars 對照
out.push('\n## Thinking Chars / case\n')
out.push('| Case | thinking-general | thinking-coding | instruct-general | instruct-reasoning |')
out.push('|------|------------------|-----------------|------------------|--------------------|')
for (const k of allKeys) {
  const cells = presets.map((p) => {
    const r = data[p]?.[k]
    return r == null ? '–' : `${r.thinkCh}ch`
  })
  out.push(`| ${k} | ${cells.join(' | ')} |`)
}

// 4. tool 命中對照
out.push('\n## Tool Calls / case\n')
out.push('| Case | thinking-general | thinking-coding | instruct-general | instruct-reasoning |')
out.push('|------|------------------|-----------------|------------------|--------------------|')
for (const k of allKeys) {
  const cells = presets.map((p) => {
    const r = data[p]?.[k]
    return r == null ? '–' : r.tools.length > 0 ? r.tools.join(',') : '(none)'
  })
  out.push(`| ${k} | ${cells.join(' | ')} |`)
}

// 5. fail note
out.push('\n## Fail Notes\n')
let anyFail = false
for (const p of presets) {
  const fails = Object.entries(data[p] ?? {}).filter(([_, r]) => !r.ok)
  if (fails.length === 0) continue
  anyFail = true
  out.push(`\n### ${p}`)
  for (const [k, r] of fails) {
    out.push(`- **${k}** ${r.case}  note=\`${r.note}\``)
  }
}
if (!anyFail) out.push('(無 fail)')

const outPath = path.join(dir, 'comparison.md')
fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8')
console.log(`Wrote ${outPath}`)
console.log(`\n${out.join('\n')}`)
