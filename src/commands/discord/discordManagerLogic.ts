/**
 * `/discord` TUI 純函式邏輯 — list 處理、cwd 標星、binding ↔ project 對應。
 *
 * 不 import React / Ink；給 unit test 直接覆蓋。
 */
import { readFile } from 'fs/promises'
import {
  DEFAULT_DISCORD_CONFIG,
  DiscordConfigSchema,
  type DiscordConfig,
} from '../../discordConfig/schema.js'
import { normalizeProjectPath } from '../../discordConfig/pathNormalize.js'
import { parseJsonc } from '../../utils/jsoncStore.js'
import { getDiscordConfigPath } from '../../discordConfig/paths.js'

/** 每筆 binding 的 enriched 資料（給 list 顯示）。 */
export interface BindingRow {
  channelId: string
  projectPath: string
  /** 對應到 projects[] 找到的 project（找不到 = orphan binding）。 */
  projectId: string | null
  projectName: string | null
  /** 是否對應到當前 cwd。 */
  isCwd: boolean
  /** 對應 project 不在 projects[] 時為 true（orphan）。 */
  orphan: boolean
}

export function buildBindings(
  cfg: DiscordConfig,
  cwd: string,
): BindingRow[] {
  const cwdNorm = normalizeProjectPath(cwd)
  const rows: BindingRow[] = []
  for (const [channelId, projectPath] of Object.entries(cfg.channelBindings)) {
    const proj = cfg.projects.find(p => p.path === projectPath) ?? null
    rows.push({
      channelId,
      projectPath,
      projectId: proj?.id ?? null,
      projectName: proj?.name ?? null,
      isCwd: projectPath === cwdNorm,
      orphan: proj === null,
    })
  }
  // 排序：cwd 在最前 → 有 project 的 → orphan 最後
  rows.sort((a, b) => {
    if (a.isCwd !== b.isCwd) return a.isCwd ? -1 : 1
    if (a.orphan !== b.orphan) return a.orphan ? 1 : -1
    return (a.projectId ?? a.projectPath).localeCompare(b.projectId ?? b.projectPath)
  })
  return rows
}

/**
 * 直接從 disk 讀 discord.jsonc — 跳過 loader 的 module-level cache（REPL process
 * 不會接收 daemon 的 in-memory mutate）。schema 驗證失敗或檔不存在 → 回 DEFAULT。
 */
export async function readDiscordConfigFresh(): Promise<DiscordConfig> {
  const path = getDiscordConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return DEFAULT_DISCORD_CONFIG
  }
  let parsed: unknown
  try {
    parsed = parseJsonc(raw.replace(/^﻿/, ''))
  } catch {
    return DEFAULT_DISCORD_CONFIG
  }
  const result = DiscordConfigSchema.safeParse(parsed)
  if (!result.success) return DEFAULT_DISCORD_CONFIG
  const cfg = result.data
  for (const p of cfg.projects) p.path = normalizeProjectPath(p.path)
  for (const chId of Object.keys(cfg.channelBindings)) {
    cfg.channelBindings[chId] = normalizeProjectPath(cfg.channelBindings[chId]!)
  }
  return cfg
}

/** Discord snowflake user / channel ID 驗證（17–20 位純數字，留 5–25 容錯）。 */
export function isValidSnowflake(s: string): boolean {
  return /^\d{5,25}$/.test(s)
}

/** Project key 解析 — 比對 id / aliases（case-insensitive）。 */
export function findProjectByKey(
  projects: ReadonlyArray<{ id: string; path: string; aliases: string[] }>,
  key: string,
): { id: string; path: string } | null {
  const lower = key.toLowerCase()
  for (const p of projects) {
    if (p.id.toLowerCase() === lower) return p
    if (p.aliases.some(a => a.toLowerCase() === lower)) return p
  }
  return null
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
