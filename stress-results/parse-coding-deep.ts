// 解析 stress-results/coding-deep/<preset>-rep<N>.log → markdown 對照表
//
// 4 preset × 3 rep = 12 logs，每 log 含 24 case 結果行。
// 聚合：每 (preset, case) cell = 3 reps 的 pass-rate / 中位時間 / std。
//
// 不變性：thinking-coding 在 coding 類（A/B/C/D/E）應該 pass-rate 高且
// 時間 std 低；在 negative（F）類可能 pass-rate 顯著低於 thinking-general。

import * as fs from 'node:fs'
import * as path from 'node:path'

type CaseRow = {
  case: string
  ok: boolean
  timeMs: number
  ttftMs: number | null
  inTok: number
  outTok: number
  thinkCh: number
  textCh: number
  turns: number
  tools: string[]
  note: string
}

const LINE_RE =
  /^\s*([✅❌])\s+(\S+(?:\s+\S+)*?)\s+(\d+)ms(?:\s+ttft=\s*(\d+)ms)?\s+in=\s*(\d+)t\s+out=\s*(\d+)t\/\s*([\d.n/a]+)t\/s\s+think=(\d+)ch\s+text=(\d+)ch\s+turns=(\d+)(?:\s+tools=\[([^\]]*)\])?\s*(.*)$/u

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
  // "A1 fibonacci 兩寫法" → "A1"
  const m = /^([A-I]\d+)/.exec(name)
  return m ? m[1] : name
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length
  return Math.round(Math.sqrt(v))
}

const dir = path.join(__dirname, 'coding-deep')
const presets = ['thinking-general', 'thinking-coding', 'instruct-general', 'instruct-reasoning']
const REPS = 3

// data[preset][caseKey] = CaseRow[] (length = reps actually parsed)
const data: Record<string, Record<string, CaseRow[]>> = {}
for (const p of presets) {
  data[p] = {}
  for (let r = 1; r <= REPS; r++) {
    const f = path.join(dir, `${p}-rep${r}.log`)
    if (!fs.existsSync(f)) {
      console.error(`Missing: ${f}`)
      continue
    }
    for (const row of parse(f)) {
      const k = caseKey(row.case)
      if (!data[p][k]) data[p][k] = []
      data[p][k].push(row)
    }
  }
}

// 收集 case key 與 type（從第一個能解析的 log 取）
const allKeys: string[] = []
const seen = new Set<string>()
const caseDescr: Record<string, string> = {}
const caseType: Record<string, string> = {}
for (const p of presets) {
  for (const k of Object.keys(data[p])) {
    if (!seen.has(k)) {
      seen.add(k)
      allKeys.push(k)
      const first = data[p][k][0]
      caseDescr[k] = first.case
    }
  }
}

// 從 v3-coding-deep.ts 推 type — 用前綴：A=algorithm, B=bug-fix, C=refactor, D=code-review, E=multi-file, F=negative, G=streaming, H=tool-heavy, I=retry
const TYPE_BY_PREFIX: Record<string, string> = {
  A: 'algorithm',
  B: 'bug-fix',
  C: 'refactor',
  D: 'code-review',
  E: 'multi-file',
  F: 'negative',
  G: 'streaming',
  H: 'tool-heavy',
  I: 'retry',
}
for (const k of allKeys) caseType[k] = TYPE_BY_PREFIX[k[0]] ?? '?'

allKeys.sort()

// ---- markdown 輸出 ----
const out: string[] = []
out.push('# v3-coding-deep — thinking-coding 深度刻劃 + 4-preset 對照（N=3）\n')
out.push('Model: qwen3.5-9b (Q4_K_M)  Shim: TCQ :8081 (256k turbo4 reasoning=on)\n')
out.push(`執行: ${new Date().toISOString()}\n`)
out.push('每 cell 顯示: `pass/3 · 中位ms[std]`；pass=3/3 = stable，pass<3 = unstable\n')

// 1. Preset 參數提醒
out.push('## Preset 參數\n')
out.push('| Preset | temp | top_p | top_k | min_p | presence_p | repetition_p |')
out.push('|--------|------|-------|-------|-------|------------|--------------|')
const params: Record<string, [number, number, number, number, number, number]> = {
  'thinking-general': [1.0, 0.95, 20, 0.0, 1.5, 1.0],
  'thinking-coding': [0.6, 0.95, 20, 0.0, 0.0, 1.0],
  'instruct-general': [0.7, 0.8, 20, 0.0, 1.5, 1.0],
  'instruct-reasoning': [1.0, 0.95, 20, 0.0, 1.5, 1.0],
}
for (const p of presets) {
  const [t, tp, tk, mp, pp, rp] = params[p]
  out.push(`| ${p} | ${t} | ${tp} | ${tk} | ${mp} | ${pp} | ${rp} |`)
}

// 2. 總覽
out.push('\n## 總覽（N=3 聚合）\n')
out.push('| Preset | Pass rate | Stable cases (3/3 pass) | Total runtime (median sum) | Total tokens out | Total think (ch) |')
out.push('|--------|-----------|--------------------------|----------------------------|-----------------|------------------|')
for (const p of presets) {
  let totalPass = 0, totalCase = 0, stableCase = 0
  let totalT = 0, totalOut = 0, totalThink = 0
  for (const k of allKeys) {
    const rows = data[p][k] ?? []
    if (rows.length === 0) continue
    const passN = rows.filter((r) => r.ok).length
    totalPass += passN
    totalCase += rows.length
    if (passN === rows.length && rows.length === REPS) stableCase++
    totalT += median(rows.map((r) => r.timeMs))
    totalOut += rows.reduce((s, r) => s + r.outTok, 0) / rows.length
    totalThink += rows.reduce((s, r) => s + r.thinkCh, 0) / rows.length
  }
  const rate = totalCase > 0 ? ((totalPass / totalCase) * 100).toFixed(1) : '0.0'
  out.push(
    `| ${p} | ${totalPass}/${totalCase} (${rate}%) | ${stableCase}/${allKeys.length} | ${(totalT / 1000).toFixed(1)}s | ${Math.round(totalOut)} | ${Math.round(totalThink)} |`,
  )
}

// 3. 依類型分組的 pass-rate 對照（核心摘要）
out.push('\n## 依類型 pass-rate（每 cell = N=3 通過數）\n')
out.push('| 類型 | thinking-general | thinking-coding | instruct-general | instruct-reasoning |')
out.push('|------|------------------|-----------------|------------------|--------------------|')
const typesByOrder = ['algorithm', 'bug-fix', 'refactor', 'code-review', 'multi-file', 'negative', 'streaming', 'tool-heavy', 'retry']
for (const t of typesByOrder) {
  const keysOfType = allKeys.filter((k) => caseType[k] === t)
  if (keysOfType.length === 0) continue
  const cells = presets.map((p) => {
    let pass = 0,
      tot = 0
    for (const k of keysOfType) {
      const rows = data[p][k] ?? []
      pass += rows.filter((r) => r.ok).length
      tot += rows.length
    }
    return `${pass}/${tot}`
  })
  out.push(`| ${t} (${keysOfType.length} case) | ${cells.join(' | ')} |`)
}

// 4. 逐 case 對照（pass · 中位 · std）
out.push('\n## 逐 case 詳細（cell = pass/3 · median ms · [std]）\n')
out.push('| Case | Type | thinking-general | thinking-coding | instruct-general | instruct-reasoning |')
out.push('|------|------|------------------|-----------------|------------------|--------------------|')
for (const k of allKeys) {
  const cells = presets.map((p) => {
    const rows = data[p][k] ?? []
    if (rows.length === 0) return '–'
    const pass = rows.filter((r) => r.ok).length
    const med = median(rows.map((r) => r.timeMs))
    const sd = stddev(rows.map((r) => r.timeMs))
    return `${pass}/${rows.length} · ${(med / 1000).toFixed(1)}s [${(sd / 1000).toFixed(1)}]`
  })
  out.push(`| **${k}** ${caseDescr[k].slice(k.length).trim()} | ${caseType[k]} | ${cells.join(' | ')} |`)
}

// 5. Thinking chars per case (median over 3 reps)
out.push('\n## Thinking chars / case（中位）\n')
out.push('| Case | Type | thinking-general | thinking-coding | instruct-general | instruct-reasoning |')
out.push('|------|------|------------------|-----------------|------------------|--------------------|')
for (const k of allKeys) {
  const cells = presets.map((p) => {
    const rows = data[p][k] ?? []
    if (rows.length === 0) return '–'
    return `${median(rows.map((r) => r.thinkCh))}ch`
  })
  out.push(`| **${k}** | ${caseType[k]} | ${cells.join(' | ')} |`)
}

// 6. Tool count per case (median tool uses)
out.push('\n## Tool 命中次數 / case（中位）\n')
out.push('| Case | Type | thinking-general | thinking-coding | instruct-general | instruct-reasoning |')
out.push('|------|------|------------------|-----------------|------------------|--------------------|')
for (const k of allKeys) {
  const cells = presets.map((p) => {
    const rows = data[p][k] ?? []
    if (rows.length === 0) return '–'
    const tools = median(rows.map((r) => r.tools.length))
    const sample = rows[0].tools.slice(0, 4).join(',')
    return `${tools}${sample ? ` (${sample})` : ''}`
  })
  out.push(`| **${k}** | ${caseType[k]} | ${cells.join(' | ')} |`)
}

// 7. thinking-coding 專屬：穩定性 ranking（不穩 case 列首）
out.push('\n## thinking-coding 穩定性排序（不穩排前）\n')
out.push('| Case | pass/3 | median ms | std ms | thinking ch (median) |')
out.push('|------|--------|-----------|--------|----------------------|')
const tcRows = allKeys
  .map((k) => {
    const rows = data['thinking-coding'][k] ?? []
    if (rows.length === 0) return null
    return {
      k,
      pass: rows.filter((r) => r.ok).length,
      total: rows.length,
      med: median(rows.map((r) => r.timeMs)),
      sd: stddev(rows.map((r) => r.timeMs)),
      think: median(rows.map((r) => r.thinkCh)),
    }
  })
  .filter((x): x is NonNullable<typeof x> => x != null)
  .sort((a, b) => a.pass - b.pass || b.sd - a.sd) // 不穩定優先
for (const r of tcRows) {
  out.push(`| ${r.k} | ${r.pass}/${r.total} | ${(r.med / 1000).toFixed(1)}s | ${(r.sd / 1000).toFixed(1)} | ${r.think} |`)
}

// 8. fail notes
out.push('\n## Fail notes（per preset）\n')
for (const p of presets) {
  const fails: string[] = []
  for (const k of allKeys) {
    const rows = data[p][k] ?? []
    rows.forEach((r, i) => {
      if (!r.ok) fails.push(`- **${k}.r${i + 1}** note=\`${r.note}\` tools=[${r.tools.join(',')}]`)
    })
  }
  if (fails.length === 0) continue
  out.push(`\n### ${p} (${fails.length} fail across ${REPS} reps)`)
  for (const f of fails) out.push(f)
}

const outPath = path.join(dir, 'comparison.md')
fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8')
console.log(`Wrote ${outPath}`)
console.log(`\n=== Top of report ===`)
console.log(out.slice(0, 50).join('\n'))
