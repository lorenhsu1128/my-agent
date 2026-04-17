// SkillManageTool — agent-callable tool for creating, editing, patching,
// and deleting skills. Every write operation goes through scanSkill()
// for code-level security scanning with auto-rollback on failure.
//
// Modeled after MemoryTool. Ported from Hermes Agent's skill_manager_tool.py.

import { join, normalize, dirname } from 'path'
import { readFile, writeFile, mkdir, rm, unlink, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { z } from 'zod'
import { getProjectRoot } from '../../bootstrap/state.js'
import { scanSkill } from '../../services/selfImprove/skillGuard.js'
import { logError } from '../../utils/log.js'
import { toError } from '../../utils/errors.js'
import { buildTool } from '../../Tool.js'
import type { ToolResult } from '../../Tool.js'
import { prompt } from './prompt.js'
import {
  userFacingName,
  renderToolUseMessage,
  renderToolResultMessage,
} from './UI.js'

// ── Constants ────────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 64
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/
const MAX_CONTENT_CHARS = 100_000
const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets'])

// ── Types ────────────────────────────────────────────────────────────────

type SkillManageResult = {
  success: boolean
  message?: string
  error?: string
  path?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getSkillsRoot(): string {
  return join(getProjectRoot(), '.my-agent', 'skills')
}

function getSkillDir(name: string): string {
  return join(getSkillsRoot(), name)
}

function getSkillMdPath(name: string): string {
  return join(getSkillDir(name), 'SKILL.md')
}

function validateName(name: string): string | null {
  if (!name) return '名稱不可為空'
  if (name.length > MAX_NAME_LENGTH) return `名稱不可超過 ${MAX_NAME_LENGTH} 字元`
  if (!VALID_NAME_RE.test(name)) return '名稱只能含小寫字母、數字、連字號、底線、句點，且必須以字母或數字開頭'
  if (name.includes('..')) return '名稱不可包含 ..'
  return null
}

function validateFrontmatter(content: string): string | null {
  if (!content.startsWith('---')) return 'SKILL.md 必須以 --- 開始（YAML frontmatter）'
  const endIdx = content.indexOf('\n---', 3)
  if (endIdx === -1) return 'SKILL.md 缺少結束的 ---'
  const yaml = content.slice(4, endIdx)
  if (!yaml.includes('name:')) return 'frontmatter 必須包含 name 欄位'
  if (!yaml.includes('description:')) return 'frontmatter 必須包含 description 欄位'
  const bodyAfterFrontmatter = content.slice(endIdx + 4).trim()
  if (!bodyAfterFrontmatter) return 'SKILL.md 必須有 frontmatter 之後的 markdown 主體'
  return null
}

function validateSubdir(filePath: string): string | null {
  const parts = filePath.split('/')
  if (parts.length < 2) return `file_path 必須在子目錄下（${[...ALLOWED_SUBDIRS].join('/')}）`
  const subdir = parts[0]
  if (!subdir || !ALLOWED_SUBDIRS.has(subdir)) {
    return `file_path 必須在允許的子目錄下：${[...ALLOWED_SUBDIRS].join(', ')}`
  }
  if (filePath.includes('..')) return 'file_path 不可包含 ..'
  return null
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const tmpPath = targetPath + '.tmp'
  try {
    await writeFile(tmpPath, content, 'utf-8')
    const { rename } = await import('fs/promises')
    await rename(tmpPath, targetPath)
  } catch {
    // fallback: direct write
    await writeFile(targetPath, content, 'utf-8')
    try { await unlink(tmpPath) } catch { /* ignore */ }
  }
}

// ── Action implementations ───────────────────────────────────────────────

async function createSkill(name: string, content: string): Promise<SkillManageResult> {
  const nameErr = validateName(name)
  if (nameErr) return { success: false, error: nameErr }

  if (content.length > MAX_CONTENT_CHARS) {
    return { success: false, error: `內容超過 ${MAX_CONTENT_CHARS} 字元限制` }
  }

  const fmErr = validateFrontmatter(content)
  if (fmErr) return { success: false, error: fmErr }

  const skillDir = getSkillDir(name)
  if (existsSync(skillDir)) {
    return { success: false, error: `Skill '${name}' 已存在。使用 edit 或 patch 修改` }
  }

  // Security scan BEFORE write
  const guard = scanSkill(content)
  if (guard.verdict === 'dangerous') {
    return {
      success: false,
      error: `安全掃描阻擋：${guard.findings.map(f => f.pattern).join('; ')}`,
    }
  }

  await atomicWrite(getSkillMdPath(name), content)

  return {
    success: true,
    message: `Skill '${name}' 已建立`,
    path: getSkillMdPath(name),
  }
}

async function editSkill(name: string, content: string): Promise<SkillManageResult> {
  const nameErr = validateName(name)
  if (nameErr) return { success: false, error: nameErr }

  const mdPath = getSkillMdPath(name)
  if (!existsSync(mdPath)) {
    return { success: false, error: `Skill '${name}' 不存在` }
  }

  if (content.length > MAX_CONTENT_CHARS) {
    return { success: false, error: `內容超過 ${MAX_CONTENT_CHARS} 字元限制` }
  }

  const fmErr = validateFrontmatter(content)
  if (fmErr) return { success: false, error: fmErr }

  // Security scan BEFORE write
  const guard = scanSkill(content)
  if (guard.verdict === 'dangerous') {
    return {
      success: false,
      error: `安全掃描阻擋：${guard.findings.map(f => f.pattern).join('; ')}`,
    }
  }

  // Backup for rollback
  const backup = await readFile(mdPath, 'utf-8')
  try {
    await atomicWrite(mdPath, content)
  } catch (e) {
    // Restore backup
    await writeFile(mdPath, backup, 'utf-8').catch(() => {})
    throw e
  }

  return { success: true, message: `Skill '${name}' 已更新`, path: mdPath }
}

async function patchSkill(
  name: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  filePath?: string,
): Promise<SkillManageResult> {
  const nameErr = validateName(name)
  if (nameErr) return { success: false, error: nameErr }

  const targetPath = filePath
    ? join(getSkillDir(name), filePath)
    : getSkillMdPath(name)

  // Path traversal check
  const normalized = normalize(targetPath)
  if (!normalized.startsWith(normalize(getSkillDir(name)))) {
    return { success: false, error: '路徑穿越嘗試被拒絕' }
  }

  if (!existsSync(targetPath)) {
    return { success: false, error: `檔案不存在：${filePath || 'SKILL.md'}` }
  }

  const original = await readFile(targetPath, 'utf-8')

  if (!original.includes(oldString)) {
    return {
      success: false,
      error: `找不到要替換的文字`,
    }
  }

  // Check uniqueness if not replaceAll
  if (!replaceAll) {
    const count = original.split(oldString).length - 1
    if (count > 1) {
      return {
        success: false,
        error: `找到 ${count} 處匹配，請設定 replace_all=true 或提供更精確的 old_string`,
      }
    }
  }

  const patched = replaceAll
    ? original.replaceAll(oldString, newString)
    : original.replace(oldString, newString)

  // If patching SKILL.md, validate frontmatter
  if (!filePath || filePath === 'SKILL.md') {
    const fmErr = validateFrontmatter(patched)
    if (fmErr) return { success: false, error: `patch 後 frontmatter 無效：${fmErr}` }
  }

  // Security scan
  const guard = scanSkill(patched)
  if (guard.verdict === 'dangerous') {
    return {
      success: false,
      error: `安全掃描阻擋 patch 結果：${guard.findings.map(f => f.pattern).join('; ')}`,
    }
  }

  await atomicWrite(targetPath, patched)

  const matchCount = replaceAll
    ? original.split(oldString).length - 1
    : 1

  return {
    success: true,
    message: `已 patch ${filePath || 'SKILL.md'}（${matchCount} 處替換）`,
  }
}

async function deleteSkill(name: string): Promise<SkillManageResult> {
  const nameErr = validateName(name)
  if (nameErr) return { success: false, error: nameErr }

  const skillDir = getSkillDir(name)
  if (!existsSync(skillDir)) {
    return { success: false, error: `Skill '${name}' 不存在` }
  }

  await rm(skillDir, { recursive: true, force: true })

  return { success: true, message: `Skill '${name}' 已刪除` }
}

async function writeSkillFile(
  name: string,
  filePath: string,
  fileContent: string,
): Promise<SkillManageResult> {
  const nameErr = validateName(name)
  if (nameErr) return { success: false, error: nameErr }

  const skillDir = getSkillDir(name)
  if (!existsSync(skillDir)) {
    return { success: false, error: `Skill '${name}' 不存在。請先用 create 建立` }
  }

  const subdirErr = validateSubdir(filePath)
  if (subdirErr) return { success: false, error: subdirErr }

  const targetPath = join(skillDir, filePath)
  const normalized = normalize(targetPath)
  if (!normalized.startsWith(normalize(skillDir))) {
    return { success: false, error: '路徑穿越嘗試被拒絕' }
  }

  // Security scan the file content
  const guard = scanSkill(fileContent)
  if (guard.verdict === 'dangerous') {
    return {
      success: false,
      error: `安全掃描阻擋：${guard.findings.map(f => f.pattern).join('; ')}`,
    }
  }

  await atomicWrite(targetPath, fileContent)

  return {
    success: true,
    message: `檔案 '${filePath}' 已寫入 skill '${name}'`,
    path: targetPath,
  }
}

async function removeSkillFile(
  name: string,
  filePath: string,
): Promise<SkillManageResult> {
  const nameErr = validateName(name)
  if (nameErr) return { success: false, error: nameErr }

  const skillDir = getSkillDir(name)
  const targetPath = join(skillDir, filePath)
  const normalized = normalize(targetPath)
  if (!normalized.startsWith(normalize(skillDir))) {
    return { success: false, error: '路徑穿越嘗試被拒絕' }
  }

  if (!existsSync(targetPath)) {
    // List available files for hint
    let available: string[] = []
    try {
      for (const sub of ALLOWED_SUBDIRS) {
        const subDir = join(skillDir, sub)
        if (existsSync(subDir)) {
          const files = await readdir(subDir)
          available.push(...files.map(f => `${sub}/${f}`))
        }
      }
    } catch { /* ignore */ }

    return {
      success: false,
      error: `檔案 '${filePath}' 不存在`,
      ...(available.length > 0 ? { message: `可用檔案：${available.join(', ')}` } : {}),
    }
  }

  await unlink(targetPath)

  return { success: true, message: `檔案 '${filePath}' 已從 skill '${name}' 移除` }
}

// ── Tool definition ──────────────────────────────────────────────────────

const inputSchema = z.strictObject({
  action: z.enum(['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file']),
  name: z.string(),
  content: z.string().optional(),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  replace_all: z.boolean().optional(),
  file_path: z.string().optional(),
  file_content: z.string().optional(),
})

type Input = z.infer<typeof inputSchema>

export const SkillManageTool = buildTool({
  name: 'SkillManage',
  inputSchema,
  maxResultSizeChars: 4000,

  async prompt() {
    return prompt
  },

  userFacingName,
  renderToolUseMessage,
  renderToolResultMessage,

  async description(input: Input) {
    return `${input.action} skill "${input.name}"`
  },

  mapToolResultToToolResultBlockParam(output: SkillManageResult, toolUseID: string) {
    const text = output.success
      ? output.message ?? 'OK'
      : `Error: ${output.error ?? 'Unknown error'}`
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: text,
    }
  },

  async call(input: Input): Promise<ToolResult<SkillManageResult>> {
    try {
      let result: SkillManageResult

      switch (input.action) {
        case 'create':
          if (!input.content) {
            result = { success: false, error: 'create 動作需要 content 參數（完整 SKILL.md 內容）' }
          } else {
            result = await createSkill(input.name, input.content)
          }
          break

        case 'edit':
          if (!input.content) {
            result = { success: false, error: 'edit 動作需要 content 參數（完整 SKILL.md 內容）' }
          } else {
            result = await editSkill(input.name, input.content)
          }
          break

        case 'patch':
          if (!input.old_string || input.new_string === undefined) {
            result = { success: false, error: 'patch 動作需要 old_string 和 new_string 參數' }
          } else {
            result = await patchSkill(
              input.name,
              input.old_string,
              input.new_string,
              input.replace_all ?? false,
              input.file_path,
            )
          }
          break

        case 'delete':
          result = await deleteSkill(input.name)
          break

        case 'write_file':
          if (!input.file_path || !input.file_content) {
            result = { success: false, error: 'write_file 動作需要 file_path 和 file_content 參數' }
          } else {
            result = await writeSkillFile(input.name, input.file_path, input.file_content)
          }
          break

        case 'remove_file':
          if (!input.file_path) {
            result = { success: false, error: 'remove_file 動作需要 file_path 參數' }
          } else {
            result = await removeSkillFile(input.name, input.file_path)
          }
          break

        default:
          result = { success: false, error: `未知的動作：${input.action}` }
      }

      return { data: result }
    } catch (e) {
      logError(toError(e))
      return { data: { success: false, error: `執行失敗：${(e as Error).message}` } }
    }
  },
})
