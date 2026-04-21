/**
 * Accessibility-snapshot based ref system for puppeteer-core.
 *
 * Walks `page.accessibility.snapshot({ interestingOnly: true })` and emits
 * a Hermes-compatible `ref=eN` text tree. Each ref maps to a role+name tuple
 * resolvable back via puppeteer's `-p-aria` selector
 * (e.g. `::-p-aria([name="Sign in"][role="link"])`).
 *
 * Stale detection: session.ts bumps `generation` on every mainFrame
 * navigation; actions compare the stored snapshot generation to the
 * current generation and throw StaleRefError on mismatch.
 *
 * Virtual ARIA fallback: on SPAs (Google Maps, Gmail, Notion, ...) the
 * `-p-aria` selector can return handles that lack backendNodeId, causing
 * `DOM.resolveNode` to fail when the caller tries `el.click()` etc.
 * `refToElement` detects this and falls back to coordinate / CSS paths.
 */
import type { BoundingBox, ElementHandle, Page } from 'puppeteer-core'

interface AXNode {
  role?: string
  name?: string
  value?: string | number
  description?: string
  checked?: boolean | 'mixed'
  children?: AXNode[]
}

export interface RefEntry {
  ref: string // e.g. "e5"
  role: string
  name: string
  nth: number
}

export interface SnapshotResult {
  text: string
  refs: Map<string, RefEntry>
  title: string
  url: string
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
  'tab',
  'option',
])

function shortName(s: string | undefined, max = 80): string {
  if (!s) return ''
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export async function takeSnapshot(page: Page): Promise<SnapshotResult> {
  const ax = (await page.accessibility.snapshot({
    interestingOnly: true,
  })) as AXNode | null

  const lines: string[] = []
  const refs = new Map<string, RefEntry>()
  const roleNameCounts = new Map<string, number>()
  let refCounter = 0

  function walk(node: AXNode | undefined, depth: number): void {
    if (!node) return
    const role = node.role ?? ''
    const name = shortName(node.name)
    const indent = '  '.repeat(depth)

    let label = ''
    if (INTERACTIVE_ROLES.has(role) && (name || node.value != null)) {
      refCounter += 1
      const id = `e${refCounter}`
      const key = `${role}\0${name}`
      const nth = roleNameCounts.get(key) ?? 0
      roleNameCounts.set(key, nth + 1)
      refs.set(id, { ref: id, role, name, nth })
      label = `[ref=${id}]`
    }

    const extras: string[] = []
    if (node.value !== undefined && node.value !== '') {
      extras.push(`value="${shortName(String(node.value), 40)}"`)
    }
    if (node.checked !== undefined) extras.push(`checked=${node.checked}`)

    const parts = [role, name ? `"${name}"` : '', ...extras, label].filter(Boolean)
    if (parts.length > 0) lines.push(`${indent}- ${parts.join(' ')}`)

    for (const c of node.children ?? []) walk(c, depth + 1)
  }

  walk(ax ?? undefined, 0)
  const [title] = await Promise.all([page.title().catch(() => '')])

  return { text: lines.join('\n'), refs, title, url: page.url() }
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
        `with no backing DOM element (common on React/Angular SPAs). Try: ` +
        `use \`evaluate\` to run JS that locates the element by selector, ` +
        `or use \`snapshot\` again to get a fresh ref, ` +
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

/** Best-effort CSS fallback based on RefEntry role/name. Returns a list of
 *  selector candidates (tried in order). Not all roles map cleanly to CSS,
 *  and some sites use implicit roles (e.g. `<button>` without `role=`), so
 *  we try a few variants. */
function cssCandidatesFromRefEntry(entry: RefEntry): string[] {
  const out: string[] = []
  const role = entry.role
  const name = entry.name
  if (name) {
    const n = escapeCssAttr(name)
    out.push(`[role="${role}"][aria-label="${n}"]`)
    out.push(`[aria-label="${n}"]`)
    // Buttons/links often have visible text matching name rather than aria-label
    if (role === 'button') out.push(`button[title="${n}"]`)
    if (role === 'link') out.push(`a[title="${n}"]`)
  }
  out.push(`[role="${role}"]`)
  // Implicit roles — `<button>`, `<a>`, `<input>` etc.
  if (role === 'button') out.push('button')
  if (role === 'link') out.push('a[href]')
  if (role === 'textbox' || role === 'searchbox') {
    out.push('input:not([type="hidden"]):not([type="submit"])')
    out.push('textarea')
  }
  return out
}

/**
 * Resolve a ref into an actionable element reference.
 *
 * Fallback chain:
 *   A. `-p-aria(...)` + nth → if handle has boundingBox → return { handle, box }
 *   B. A matched but no box → return { handle: null, box: null } not useful;
 *      continue to C
 *   C. CSS selector candidates + nth → if boundingBox → return { handle, box }
 *   D. all failed → throw VirtualNodeError
 *
 * Callers prefer `handle` (normal click/focus/type path). If `handle` is null
 * but `box` is non-null, fall back to `page.mouse` coordinate actions.
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
  // Dispose the rest (either later or now if we skip)
  const disposeRest = async (
    handles: ElementHandle<Element>[],
    keep: ElementHandle<Element> | null,
  ): Promise<void> => {
    for (const h of handles) {
      if (h !== keep) await h.dispose().catch(() => void 0)
    }
  }
  if (ariaTarget) {
    const box = await tryBoundingBox(ariaTarget)
    if (box) {
      await disposeRest(ariaHandles, ariaTarget)
      return { handle: ariaTarget, box, strategy: 'aria', ref: id }
    }
    // virtual node — ariaTarget has no backing DOM. Drop and try CSS.
    await disposeRest(ariaHandles, null)
  }

  // --- C. CSS fallback --------------------------------------------------
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
    await disposeRest(handles, null)
  }

  // --- D. Give up -------------------------------------------------------
  throw new VirtualNodeError(id, entry.role, entry.name)
}
