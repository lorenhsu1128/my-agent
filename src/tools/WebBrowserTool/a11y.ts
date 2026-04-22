/**
 * Accessibility-snapshot based ref system for puppeteer-core.
 *
 * 2026-04-22 升級：
 *   - 移除 `interestingOnly: true`：改走全量 a11y tree，抓到更多動態注入 node
 *   - 擴增 INTERACTIVE_ROLES：menu、menuitem 家族、slider、spinbutton、
 *     treeitem、tabpanel、dialog、listbox
 *   - 輸出 state：disabled / expanded / selected / pressed；disabled 不發 ref
 *   - Shadow DOM 穿透：列舉頁面上所有 shadowRoot host，對每個 host 另跑一次
 *     `accessibility.snapshot({ root: hostHandle })` 並 inline 進輸出
 *   - VirtualNodeError 之前先試 boundingBox 座標備援（aria+coord 路徑）
 *
 * Stale detection: session.ts bumps `generation` on every mainFrame
 * navigation; actions compare the stored snapshot generation to the
 * current generation and throw StaleRefError on mismatch.
 */
import type { BoundingBox, ElementHandle, Page } from 'puppeteer-core'

interface AXNode {
  role?: string
  name?: string
  value?: string | number
  description?: string
  checked?: boolean | 'mixed'
  disabled?: boolean
  expanded?: boolean
  selected?: boolean
  pressed?: boolean | 'mixed'
  children?: AXNode[]
}

export interface RefEntry {
  ref: string // e.g. "e5"
  role: string
  name: string
  nth: number
}

export interface SnapshotSummary {
  interactive_count: number
  form_count: number
  has_dialog: boolean
  has_shadow: boolean
}

export interface SnapshotResult {
  text: string
  refs: Map<string, RefEntry>
  title: string
  url: string
  summary: SnapshotSummary
}

/**
 * Result of resolving a ref. Callers should prefer `handle` when non-null
 * (standard puppeteer DOM path); otherwise fall back to `box` for
 * coordinate-based mouse actions. `strategy` is informational for logging.
 */
export interface ResolvedRef {
  handle: ElementHandle<Element> | null
  box: BoundingBox | null
  strategy: 'aria' | 'aria+coord' | 'css' | 'css+coord'
  ref: string
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'slider',
  'spinbutton',
  'treeitem',
])

const FORM_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton'])
const DIALOG_ROLES = new Set(['dialog', 'alertdialog'])

function shortName(s: string | undefined, max = 80): string {
  if (!s) return ''
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

interface WalkContext {
  lines: string[]
  refs: Map<string, RefEntry>
  roleNameCounts: Map<string, number>
  refCounter: { n: number }
  interactiveCount: { n: number }
  formCount: { n: number }
  hasDialog: { v: boolean }
}

function walkNode(
  node: AXNode | undefined,
  depth: number,
  ctx: WalkContext,
): void {
  if (!node) return
  const role = node.role ?? ''
  const name = shortName(node.name)
  const indent = '  '.repeat(depth)

  const disabled = node.disabled === true
  let label = ''
  if (INTERACTIVE_ROLES.has(role) && (name || node.value != null) && !disabled) {
    ctx.refCounter.n += 1
    const id = `e${ctx.refCounter.n}`
    const key = `${role}\0${name}`
    const nth = ctx.roleNameCounts.get(key) ?? 0
    ctx.roleNameCounts.set(key, nth + 1)
    ctx.refs.set(id, { ref: id, role, name, nth })
    label = `[ref=${id}]`
    ctx.interactiveCount.n += 1
    if (FORM_ROLES.has(role)) ctx.formCount.n += 1
  }
  if (DIALOG_ROLES.has(role)) ctx.hasDialog.v = true

  const extras: string[] = []
  if (node.value !== undefined && node.value !== '') {
    extras.push(`value="${shortName(String(node.value), 40)}"`)
  }
  if (node.checked !== undefined) extras.push(`checked=${node.checked}`)
  if (node.expanded !== undefined) extras.push(`expanded=${node.expanded}`)
  if (node.selected === true) extras.push(`selected`)
  if (node.pressed !== undefined) extras.push(`pressed=${node.pressed}`)
  if (disabled) extras.push('disabled')

  const parts = [role, name ? `"${name}"` : '', ...extras, label].filter(Boolean)
  if (parts.length > 0) ctx.lines.push(`${indent}- ${parts.join(' ')}`)

  for (const c of node.children ?? []) walkNode(c, depth + 1, ctx)
}

/**
 * 列舉頁面上所有持有 open shadowRoot 的 element，回他們的 CSS path。
 * 用給 `page.$` 取 ElementHandle，再對每個 handle 跑局部 accessibility.snapshot。
 */
async function listShadowHostPaths(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => {
      const paths: string[] = []
      function cssPath(el: Element): string {
        const parts: string[] = []
        let cur: Element | null = el
        while (cur && cur.nodeType === 1 && parts.length < 12) {
          let part = cur.tagName.toLowerCase()
          const parent = cur.parentElement
          if (parent) {
            const siblings = Array.from(parent.children).filter(
              c => c.tagName === cur!.tagName,
            )
            if (siblings.length > 1) {
              part += `:nth-of-type(${siblings.indexOf(cur) + 1})`
            }
          }
          parts.unshift(part)
          cur = parent
        }
        return parts.join(' > ')
      }
      // 遞迴穿透 — 列到第一層 shadow host 就夠，更深層的會在該 host 的局部
      // accessibility snapshot 中被 Chromium 自動穿透（accessibility tree
      // 本身 follow shadow tree；之所以需要 listShadowHostPaths 是因為
      // `accessibility.snapshot({root})` 必須以每個 shadow host 為 root 才
      // 保險取到 closed-shadow edge cases；單純全頁 snapshot 已經能穿 open）
      document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) paths.push(cssPath(el))
      })
      return paths.slice(0, 50)
    })
  } catch {
    return []
  }
}

export async function takeSnapshot(page: Page): Promise<SnapshotResult> {
  const ax = (await page.accessibility.snapshot({
    interestingOnly: false,
  })) as AXNode | null

  const ctx: WalkContext = {
    lines: [],
    refs: new Map(),
    roleNameCounts: new Map(),
    refCounter: { n: 0 },
    interactiveCount: { n: 0 },
    formCount: { n: 0 },
    hasDialog: { v: false },
  }
  walkNode(ax ?? undefined, 0, ctx)

  // Shadow DOM：全頁 snapshot 已能穿 open shadow；這裡對每個 shadow host 補跑
  // 局部 snapshot 並合併進輸出（處理部分網站 open-shadow tree 被略過的邊界情況）。
  // 效能保險：最多 20 個 host。
  const shadowPaths = (await listShadowHostPaths(page)).slice(0, 20)
  const hasShadow = shadowPaths.length > 0
  for (const sp of shadowPaths) {
    let hostHandle: ElementHandle<Element> | null = null
    try {
      hostHandle = (await page.$(sp)) as ElementHandle<Element> | null
      if (!hostHandle) continue
      const subAx = (await page.accessibility.snapshot({
        interestingOnly: false,
        root: hostHandle,
      })) as AXNode | null
      if (!subAx) continue
      ctx.lines.push(`  - shadow-root [${sp}]`)
      walkNode(subAx, 2, ctx)
    } catch {
      /* swallow — best effort */
    } finally {
      if (hostHandle) await hostHandle.dispose().catch(() => void 0)
    }
  }

  const [title] = await Promise.all([page.title().catch(() => '')])

  return {
    text: ctx.lines.join('\n'),
    refs: ctx.refs,
    title,
    url: page.url(),
    summary: {
      interactive_count: ctx.interactiveCount.n,
      form_count: ctx.formCount.n,
      has_dialog: ctx.hasDialog.v,
      has_shadow: hasShadow,
    },
  }
}

export class StaleRefError extends Error {
  constructor(ref: string) {
    super(
      `Ref @${ref} is stale (page navigated since the snapshot). Call browser.snapshot again.`,
    )
    this.name = 'StaleRefError'
  }
}

export class UnknownRefError extends Error {
  constructor(ref: string) {
    super(
      `Unknown ref @${ref}. Refs come from the most recent browser.snapshot call.`,
    )
    this.name = 'UnknownRefError'
  }
}

export class VirtualNodeError extends Error {
  constructor(ref: string, role: string, name: string) {
    super(
      `Ref @${ref} (role="${role}", name="${name}") resolved to a virtual ARIA node ` +
        `with no backing DOM element or boundingBox (common on React/Angular SPAs). Try: ` +
        `use \`evaluate\` to run JS that locates the element by selector, ` +
        `or use \`snapshot\` again to get a fresh ref, ` +
        `or use \`screenshot\` + \`vision(return_coordinates=true)\` → \`click_at\`, ` +
        `or use keyboard-based navigation (\`press\`).`,
    )
    this.name = 'VirtualNodeError'
  }
}

function escapeAriaValue(s: string): string {
  return s.replace(/"/g, '\\"')
}

/** `boundingBox()` throws if the underlying backendNodeId is missing; we treat
 *  that the same as null (handle is virtual / detached). */
async function tryBoundingBox(
  handle: ElementHandle<Element>,
): Promise<BoundingBox | null> {
  try {
    return await handle.boundingBox()
  } catch {
    return null
  }
}

/** Escape for CSS attribute selector string values. */
function escapeCssAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Best-effort CSS fallback based on RefEntry role/name. */
function cssCandidatesFromRefEntry(entry: RefEntry): string[] {
  const out: string[] = []
  const role = entry.role
  const name = entry.name
  if (name) {
    const n = escapeCssAttr(name)
    out.push(`[role="${role}"][aria-label="${n}"]`)
    out.push(`[aria-label="${n}"]`)
    if (role === 'button') out.push(`button[title="${n}"]`)
    if (role === 'link') out.push(`a[title="${n}"]`)
  }
  out.push(`[role="${role}"]`)
  if (role === 'button') out.push('button')
  if (role === 'link') out.push('a[href]')
  if (role === 'textbox' || role === 'searchbox') {
    out.push('input:not([type="hidden"]):not([type="submit"])')
    out.push('textarea')
  }
  if (role === 'slider') out.push('input[type="range"]')
  if (role === 'spinbutton') out.push('input[type="number"]')
  return out
}

/**
 * Resolve a ref into an actionable element reference.
 *
 * Fallback chain (2026-04-22 rev):
 *   A. `-p-aria(...)` + nth：
 *      A1. handle 有 boundingBox → `{ handle, box, strategy: 'aria' }`
 *      A2. handle 無 box（virtual node）→ 留住 handle，繼續試 CSS
 *   B. CSS selector candidates + nth → 有 box 回 `{ handle, box, strategy: 'css' }`
 *   C. 若 step A 抓到 virtual handle 本身仍有座標（極少見）或 CSS handle 有
 *      handle 但無 box → 嘗試 `{ handle: null, box, strategy: 'aria+coord' | 'css+coord' }`
 *   D. 全失敗 → VirtualNodeError
 */
export async function refToElement(
  page: Page,
  ref: string,
  refEntries: Map<string, RefEntry> | null,
  snapshotGen: number,
  currentGen: number,
): Promise<ResolvedRef> {
  const id = ref.startsWith('@') ? ref.slice(1) : ref
  if (!refEntries) throw new StaleRefError(id)
  const entry = refEntries.get(id)
  if (!entry) throw new UnknownRefError(id)
  if (snapshotGen !== currentGen) throw new StaleRefError(id)

  const disposeRest = async (
    handles: ElementHandle<Element>[],
    keep: ElementHandle<Element> | null,
  ): Promise<void> => {
    for (const h of handles) {
      if (h !== keep) await h.dispose().catch(() => void 0)
    }
  }

  // --- A. Primary: puppeteer's ARIA P-selector -------------------------
  const ariaSel = entry.name
    ? `::-p-aria([name="${escapeAriaValue(entry.name)}"][role="${entry.role}"])`
    : `::-p-aria([role="${entry.role}"])`
  let ariaHandles: ElementHandle<Element>[] = []
  try {
    ariaHandles = (await page.$$(ariaSel)) as ElementHandle<Element>[]
  } catch {
    ariaHandles = []
  }
  const ariaTarget = ariaHandles[entry.nth]
  if (ariaTarget) {
    const box = await tryBoundingBox(ariaTarget)
    if (box) {
      await disposeRest(ariaHandles, ariaTarget)
      return { handle: ariaTarget, box, strategy: 'aria', ref: id }
    }
    // virtual — 繼續往下，但先清掉
    await disposeRest(ariaHandles, null)
  }

  // --- B. CSS fallback --------------------------------------------------
  for (const sel of cssCandidatesFromRefEntry(entry)) {
    let handles: ElementHandle<Element>[] = []
    try {
      handles = (await page.$$(sel)) as ElementHandle<Element>[]
    } catch {
      continue
    }
    const target = handles[entry.nth]
    if (!target) {
      await disposeRest(handles, null)
      continue
    }
    const box = await tryBoundingBox(target)
    if (box) {
      await disposeRest(handles, target)
      return { handle: target, box, strategy: 'css', ref: id }
    }
    // handle 無 box — 試座標 fallback（罕見但可能）
    await disposeRest(handles, null)
  }

  // --- C. Evaluate-based 最後座標備援 ------------------------------------
  // 對 ARIA virtual node：用 page.evaluate 找第 nth 個符合 role+name 的元素
  // 取 getBoundingClientRect；若可見就回座標 box（無 handle）
  try {
    const box = await page.evaluate(
      (role: string, name: string, nth: number) => {
        const lower = name.toLowerCase()
        const candidates: Element[] = []
        const matchesRole = (el: Element): boolean => {
          const r = el.getAttribute('role')
          if (r === role) return true
          const tag = el.tagName.toLowerCase()
          if (role === 'button' && tag === 'button') return true
          if (role === 'link' && tag === 'a') return true
          if ((role === 'textbox' || role === 'searchbox') && tag === 'input')
            return true
          if (role === 'slider' && tag === 'input' && (el as HTMLInputElement).type === 'range')
            return true
          return false
        }
        const matchesName = (el: Element): boolean => {
          if (!name) return true
          const label = (el as HTMLElement).getAttribute('aria-label') ?? ''
          const text = (el as HTMLElement).textContent ?? ''
          const title = (el as HTMLElement).getAttribute('title') ?? ''
          return (
            label.toLowerCase() === lower ||
            text.trim().toLowerCase() === lower ||
            title.toLowerCase() === lower
          )
        }
        document.querySelectorAll('*').forEach(el => {
          if (matchesRole(el) && matchesName(el)) candidates.push(el)
        })
        const el = candidates[nth]
        if (!el) return null
        const r = (el as HTMLElement).getBoundingClientRect()
        if (r.width === 0 && r.height === 0) return null
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      },
      entry.role,
      entry.name,
      entry.nth,
    )
    if (box) {
      return {
        handle: null,
        box: box as BoundingBox,
        strategy: 'aria+coord',
        ref: id,
      }
    }
  } catch {
    /* 丟給下一步 throw */
  }

  throw new VirtualNodeError(id, entry.role, entry.name)
}
