/**
 * M2-14：MemoryTool — memdir 四型檔案管理工具。
 *
 * 三個動作：add / replace / remove。
 * 操作 memdir 記憶檔案（user / feedback / project / reference），
 * 並自動維護 MEMORY.md 索引行。
 *
 * M2-15 會加原子寫入與檔案鎖；M2-16 會加 injection 掃描。
 * 本階段用簡單 writeFile / unlink。
 */
import {
  readFile as readFileAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
} from 'fs/promises'
import { join, normalize } from 'path'
import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  ensureMemoryDirExists,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from '../../memdir/memdir.js'
import { MEMORY_TYPES } from '../../memdir/memoryTypes.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logForDebugging } from '../../utils/debug.js'
import { DESCRIPTION, MEMORY_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['add', 'replace', 'remove'])
      .describe('Action to perform: add (create new), replace (update existing), remove (delete)'),
    filename: z
      .string()
      .describe(
        'Memory file name, e.g. "user_role.md". Must end with .md. No path separators.',
      ),
    type: z
      .enum(['user', 'feedback', 'project', 'reference'])
      .optional()
      .describe('Memory type. Required for add. For replace, updates the type if provided.'),
    name: z
      .string()
      .optional()
      .describe('Memory name for YAML frontmatter. Required for add.'),
    description: z
      .string()
      .optional()
      .describe(
        'One-line description for frontmatter and MEMORY.md index. Required for add.',
      ),
    content: z
      .string()
      .optional()
      .describe('Memory body content (after frontmatter). Required for add.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    action: z.string(),
    filename: z.string(),
    filePath: z.string(),
    message: z.string(),
    indexUpdated: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 驗證 filename 安全性，回傳完整路徑或錯誤字串。
 */
function validateMemoryFilename(
  filename: string,
  memDir: string,
): { ok: true; filePath: string } | { ok: false; error: string } {
  if (!filename.endsWith('.md')) {
    return { ok: false, error: '檔名必須以 .md 結尾' }
  }
  if (/[/\\]/.test(filename)) {
    return { ok: false, error: '檔名不可含路徑分隔符（/ 或 \\）' }
  }
  if (filename.includes('..')) {
    return { ok: false, error: '檔名不可含 ".."' }
  }
  if (filename.includes('\0')) {
    return { ok: false, error: '檔名不可含 null byte' }
  }
  if (filename === ENTRYPOINT_NAME) {
    return { ok: false, error: `不可直接操作索引檔 ${ENTRYPOINT_NAME}` }
  }

  const filePath = normalize(join(memDir, filename))
  // 路徑穿越防護：normalize 後必須仍在 memDir 內
  const normalizedMemDir = normalize(memDir)
  if (!filePath.startsWith(normalizedMemDir)) {
    return { ok: false, error: '路徑穿越偵測：目標不在 memdir 內' }
  }

  return { ok: true, filePath }
}

/**
 * 組裝 YAML frontmatter + body 的完整檔案內容。
 */
function buildFileContent(
  name: string,
  description: string,
  type: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`
}

/**
 * 更新 MEMORY.md 索引。
 * - add：追加一行（若 filename 已存在則跳過）
 * - replace：找到同 filename 的行替換（找不到則追加）
 * - remove：找到同 filename 的行刪除
 *
 * 回傳 indexUpdated: boolean。
 */
async function updateMemoryIndex(
  action: 'add' | 'replace' | 'remove',
  memDir: string,
  filename: string,
  name?: string,
  description?: string,
): Promise<boolean> {
  const indexPath = join(memDir, ENTRYPOINT_NAME)

  let content = ''
  try {
    content = await readFileAsync(indexPath, 'utf-8')
  } catch {
    // 檔案不存在 — 從空開始
  }

  const lines = content.split('\n')
  // 用 filename 作為唯一錨點搜尋
  const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*-\\s*\\[.*\\]\\(\\s*${escapedFilename}\\s*\\)`)
  const existingIdx = lines.findIndex(line => pattern.test(line))

  const indexLine =
    name && description
      ? `- [${name}](${filename}) — ${description}`
      : undefined

  let changed = false

  switch (action) {
    case 'add':
      if (existingIdx === -1 && indexLine) {
        // 追加到最後一個非空行之後
        // 找最後一個有內容的行
        let insertAt = lines.length
        while (insertAt > 0 && lines[insertAt - 1]!.trim() === '') {
          insertAt--
        }
        lines.splice(insertAt, 0, indexLine)
        changed = true
      }
      break

    case 'replace':
      if (existingIdx !== -1 && indexLine) {
        lines[existingIdx] = indexLine
        changed = true
      } else if (existingIdx === -1 && indexLine) {
        // 補缺：原本沒索引行就追加
        let insertAt = lines.length
        while (insertAt > 0 && lines[insertAt - 1]!.trim() === '') {
          insertAt--
        }
        lines.splice(insertAt, 0, indexLine)
        changed = true
      }
      break

    case 'remove':
      if (existingIdx !== -1) {
        lines.splice(existingIdx, 1)
        changed = true
      }
      break
  }

  if (!changed) return false

  if (lines.length > MAX_ENTRYPOINT_LINES) {
    logForDebugging(
      `MEMORY.md 索引行數 (${lines.length}) 超過上限 (${MAX_ENTRYPOINT_LINES})`,
      { level: 'warn' },
    )
  }

  try {
    await writeFileAsync(indexPath, lines.join('\n'), 'utf-8')
    return true
  } catch (err) {
    logForDebugging(
      `MEMORY.md 索引寫入失敗：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const MemoryTool = buildTool({
  name: MEMORY_TOOL_NAME,
  searchHint: '管理持久化記憶檔案 — 新增/替換/移除',
  maxResultSizeChars: 10_000,

  async description() {
    return DESCRIPTION
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `記憶管理：${summary}` : '記憶管理'
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.action} ${input.filename}`
  },

  async validateInput(input): Promise<ValidationResult> {
    if (!isAutoMemoryEnabled()) {
      return {
        result: false,
        message: 'Auto memory 已停用（CLAUDE_CODE_DISABLE_AUTO_MEMORY 或 settings）',
        errorCode: 1,
      }
    }

    const { action, filename } = input
    if (!filename || !filename.trim()) {
      return { result: false, message: 'filename 不能為空', errorCode: 1 }
    }

    const memDir = getAutoMemPath()
    const validation = validateMemoryFilename(filename, memDir)
    if (!validation.ok) {
      return { result: false, message: validation.error, errorCode: 1 }
    }

    if (action === 'add') {
      if (!input.type) {
        return {
          result: false,
          message: `add 動作必須提供 type（${MEMORY_TYPES.join(' / ')}）`,
          errorCode: 1,
        }
      }
      if (!input.name) {
        return { result: false, message: 'add 動作必須提供 name', errorCode: 1 }
      }
      if (!input.description) {
        return {
          result: false,
          message: 'add 動作必須提供 description',
          errorCode: 1,
        }
      }
      if (input.content === undefined || input.content === null) {
        return {
          result: false,
          message: 'add 動作必須提供 content',
          errorCode: 1,
        }
      }
    }

    if (action === 'replace') {
      // 至少要有一個可更新的欄位
      if (!input.type && !input.name && !input.description && input.content === undefined) {
        return {
          result: false,
          message: 'replace 動作至少需要提供 type / name / description / content 其中之一',
          errorCode: 1,
        }
      }
    }

    return { result: true }
  },

  async prompt() {
    return DESCRIPTION
  },

  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,

  async call(input) {
    const { action, filename } = input
    const memDir = getAutoMemPath()

    const validation = validateMemoryFilename(filename, memDir)
    if (!validation.ok) {
      return {
        data: {
          success: false,
          action,
          filename,
          filePath: '',
          message: validation.error,
          indexUpdated: false,
        } satisfies Output,
      }
    }
    const { filePath } = validation

    const fsOps = getFsImplementation()
    await ensureMemoryDirExists(memDir)

    // -----------------------------------------------------------------------
    // ADD
    // -----------------------------------------------------------------------
    if (action === 'add') {
      // 檢查檔案不存在
      try {
        await fsOps.stat(filePath)
        // 如果走到這裡，代表檔案已存在
        return {
          data: {
            success: false,
            action,
            filename,
            filePath,
            message: `檔案 ${filename} 已存在。請使用 action "replace" 來更新。`,
            indexUpdated: false,
          } satisfies Output,
        }
      } catch {
        // ENOENT — 正常，繼續
      }

      const fileContent = buildFileContent(
        input.name!,
        input.description!,
        input.type!,
        input.content!,
      )

      try {
        await writeFileAsync(filePath, fileContent, 'utf-8')
      } catch (err) {
        return {
          data: {
            success: false,
            action,
            filename,
            filePath,
            message: `寫入失敗：${err instanceof Error ? err.message : String(err)}`,
            indexUpdated: false,
          } satisfies Output,
        }
      }

      const indexUpdated = await updateMemoryIndex(
        'add',
        memDir,
        filename,
        input.name!,
        input.description!,
      )

      return {
        data: {
          success: true,
          action,
          filename,
          filePath,
          message: `已建立記憶檔案 ${filename}（type=${input.type}）`,
          indexUpdated,
        } satisfies Output,
      }
    }

    // -----------------------------------------------------------------------
    // REPLACE
    // -----------------------------------------------------------------------
    if (action === 'replace') {
      // 檢查檔案存在
      let existingContent: string
      try {
        existingContent = await readFileAsync(filePath, 'utf-8')
      } catch {
        return {
          data: {
            success: false,
            action,
            filename,
            filePath,
            message: `檔案 ${filename} 不存在。請使用 action "add" 來建立。`,
            indexUpdated: false,
          } satisfies Output,
        }
      }

      // 解析舊 frontmatter
      const { frontmatter, content: existingBody } = parseFrontmatter(
        existingContent,
        filePath,
      )

      // Merge：提供的欄位覆蓋，未提供的保留原值
      const mergedName =
        input.name ?? (frontmatter as Record<string, unknown>).name as string ?? filename
      const mergedDescription =
        input.description ?? frontmatter.description ?? ''
      const mergedType =
        input.type ?? frontmatter.type ?? 'project'
      const mergedContent =
        input.content !== undefined ? input.content : existingBody.trim()

      const fileContent = buildFileContent(
        mergedName,
        mergedDescription,
        mergedType,
        mergedContent,
      )

      try {
        await writeFileAsync(filePath, fileContent, 'utf-8')
      } catch (err) {
        return {
          data: {
            success: false,
            action,
            filename,
            filePath,
            message: `寫入失敗：${err instanceof Error ? err.message : String(err)}`,
            indexUpdated: false,
          } satisfies Output,
        }
      }

      const indexUpdated = await updateMemoryIndex(
        'replace',
        memDir,
        filename,
        mergedName,
        mergedDescription,
      )

      return {
        data: {
          success: true,
          action,
          filename,
          filePath,
          message: `已更新記憶檔案 ${filename}`,
          indexUpdated,
        } satisfies Output,
      }
    }

    // -----------------------------------------------------------------------
    // REMOVE
    // -----------------------------------------------------------------------
    // action === 'remove'
    try {
      await fsOps.stat(filePath)
    } catch {
      return {
        data: {
          success: false,
          action,
          filename,
          filePath,
          message: `檔案 ${filename} 不存在，無法移除。`,
          indexUpdated: false,
        } satisfies Output,
      }
    }

    try {
      await unlinkAsync(filePath)
    } catch (err) {
      return {
        data: {
          success: false,
          action,
          filename,
          filePath,
          message: `刪除失敗：${err instanceof Error ? err.message : String(err)}`,
          indexUpdated: false,
        } satisfies Output,
      }
    }

    const indexUpdated = await updateMemoryIndex('remove', memDir, filename)

    return {
      data: {
        success: true,
        action,
        filename,
        filePath,
        message: `已刪除記憶檔案 ${filename}`,
        indexUpdated,
      } satisfies Output,
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const statusIcon = output.success ? '✓' : '✗'
    const indexNote = output.indexUpdated ? '（MEMORY.md 已更新）' : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${statusIcon} ${output.message}${indexNote}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
