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
 */
import type { ElementHandle, Page } from 'puppeteer-core'

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

function escapeAriaValue(s: string): string {
  return s.replace(/"/g, '\\"')
}

/**
 * Resolve a ref into a Puppeteer ElementHandle via the `-p-aria` selector.
 * Returns null if element not found (caller should treat as stale).
 */
export async function refToElement(
  page: Page,
  ref: string,
  refEntries: Map<string, RefEntry> | null,
  snapshotGen: number,
  currentGen: number,
): Promise<ElementHandle<Element>> {
  const id = ref.startsWith('@') ? ref.slice(1) : ref
  if (!refEntries) throw new StaleRefError(id)
  const entry = refEntries.get(id)
  if (!entry) throw new UnknownRefError(id)
  if (snapshotGen !== currentGen) throw new StaleRefError(id)

  // Puppeteer's P-selector for ARIA: ::-p-aria([name="..."][role="..."])
  const sel = entry.name
    ? `::-p-aria([name="${escapeAriaValue(entry.name)}"][role="${entry.role}"])`
    : `::-p-aria([role="${entry.role}"])`
  const handles = await page.$$(sel)
  const target = handles[entry.nth]
  if (!target) throw new StaleRefError(id)
  // Dispose the rest
  for (let i = 0; i < handles.length; i++) {
    if (i !== entry.nth) await handles[i]!.dispose().catch(() => void 0)
  }
  return target as ElementHandle<Element>
}
