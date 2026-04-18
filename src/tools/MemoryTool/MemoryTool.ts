/**
 * M2-14 + M2-15：MemoryTool — memdir 四型檔案管理工具。
 *
 * 三個動作：add / replace / remove。
 * 操作 memdir 記憶檔案（user / feedback / project / reference），
 * 並自動維護 MEMORY.md 索引行。
 *
 * M2-15：原子寫入（temp file + rename）+ advisory lock（proper-lockfile）。
 * 鎖定目標是 memdir 目錄，保護記憶檔和 MEMORY.md 索引的一致性。
 * extractMemories forked agent 的 Edit/Write 不查 lock，但 MemoryTool 的
 * 短暫鎖定（毫秒級）不會造成可感知的阻擋。
 */
import {
  readFile as readFileAsync,
  rename as renameAsync,
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
import {
  isUserModelEnabled,
} from '../../userModel/paths.js'
import { writeUserModel } from '../../userModel/userModel.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { lock } from '../../utils/lockfile.js'
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
    target: z
      .enum(['file', 'user_profile'])
      .optional()
      .describe(
        'Target type. "file" (default) writes a typed memdir file; "user_profile" writes to USER.md (persona block injected into system prompt).',
      ),
    scope: z
      .enum(['global', 'project'])
      .optional()
      .describe(
        'Only for target="user_profile". "global" (default) writes ~/.my-agent/USER.md; "project" writes ~/.my-agent/projects/<slug>/USER.md.',
      ),
    filename: z
      .string()
      .optional()
      .describe(
        'Memory file name for target="file", e.g. "user_role.md". Must end with .md. No path separators. Ignored for target="user_profile".',
      ),
    type: z
      .enum(['user', 'feedback', 'project', 'reference'])
      .optional()
      .describe('Memory type. Required for add (target="file"). For replace, updates the type if provided.'),
    name: z
      .string()
      .optional()
      .describe('Memory name for YAML frontmatter. Required for add (target="file").'),
    description: z
      .string()
      .optional()
      .describe(
        'One-line description for frontmatter and MEMORY.md index. Required for add (target="file").',
      ),
    content: z
      .string()
      .optional()
      .describe(
        'Memory body content (for target="file": file body after frontmatter, required for add). For target="user_profile": the entry text (add), full replacement (replace), or substring to locate entry for removal (remove, empty = clear file).',
      ),
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

// ---------------------------------------------------------------------------
// M2-16：Prompt injection scanner
// ---------------------------------------------------------------------------

/**
 * 可疑 pattern 清單。每個 entry 有一個 regex 和人類可讀的描述。
 * 命中任一 pattern 就拒絕寫入，回傳描述讓 LLM 知道為什麼被擋。
 *
 * 設計原則：寧可漏抓不誤殺。只擋「幾乎不可能出現在合法記憶內容中」的 pattern。
 * 模糊地帶（如一般提到 "system" 的句子）不列入。
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /ignore\s+(all\s+)?previous\s+instructions/i,
    description: 'Prompt injection: "ignore previous instructions"',
  },
  {
    pattern: /disregard\s+(all\s+)?(prior|previous|above)\s+(instructions|context)/i,
    description: 'Prompt injection: "disregard prior instructions"',
  },
  {
    pattern: /you\s+are\s+now\s+(a\s+)?(?:different|new|evil|unrestricted)/i,
    description: 'Prompt injection: role override attempt',
  },
  {
    pattern: /^system\s*:/im,
    description: 'Prompt injection: "system:" prefix (偽造系統訊息)',
  },
  {
    pattern: /<script[\s>]/i,
    description: 'XSS: <script> tag',
  },
  {
    pattern: /javascript\s*:/i,
    description: 'XSS: javascript: URI',
  },
  {
    pattern: /data:[a-z]+\/[a-z]+;base64,[\w+/=]{100,}/i,
    description: 'Data exfil: 大型 base64 data URI',
  },
  {
    pattern: /https?:\/\/[^\s]+\?.*(?:key|token|secret|password|api_?key)=[^\s&]+/i,
    description: 'Data exfil: URL 含疑似敏感參數（key/token/secret）',
  },
  {
    pattern: /\]\(https?:\/\/[^\s)]+\/(?:collect|exfil|steal|log|track)\b/i,
    description: 'Data exfil: 可疑 markdown link 目標',
  },
]

/**
 * 掃描文字內容是否含可疑 prompt injection pattern。
 * @returns null 表示通過；否則回傳第一個命中的 pattern 描述。
 */
function scanForInjection(text: string): string | null {
  for (const { pattern, description } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return description
    }
  }
  return null
}

/**
 * 原子寫入：先寫到 `.tmp` 再 rename。
 * rename 在同一 volume 上是原子的（POSIX guarantee；Windows NTFS 亦然）。
 * 若 rename 失敗（Windows 檔案被佔用等），fallback 到直接 writeFile。
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmpPath = targetPath + '.tmp'
  await writeFileAsync(tmpPath, content, 'utf-8')
  try {
    await renameAsync(tmpPath, targetPath)
  } catch {
    // rename 失敗（e.g. Windows cross-volume 或鎖定）→ fallback 直接寫
    await writeFileAsync(targetPath, content, 'utf-8')
    // 清理殘留 tmp（ignore errors）
    try {
      await unlinkAsync(tmpPath)
    } catch {
      // ignore
    }
  }
}

/**
 * 取得 memdir 目錄的 advisory lock。
 * 使用 proper-lockfile（已在 src/utils/lockfile.ts 包裝）。
 * 鎖定目標是 memdir 目錄本身，同時保護記憶檔和 MEMORY.md。
 *
 * 回傳 unlock 函式；呼叫端在 finally 中 release。
 * 若 lock 取不到（其他實例佔用），等待最多 3 秒後放棄。
 */
async function acquireMemdirLock(
  memDir: string,
): Promise<(() => Promise<void>) | null> {
  try {
    const release = await lock(memDir, {
      stale: 10_000, // 鎖超過 10 秒視為 stale（crash 殘留）
      retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
    })
    return release
  } catch (err) {
    logForDebugging(
      `memdir lock 取得失敗，繼續無鎖操作：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// M2-17：配額警告
// ---------------------------------------------------------------------------

const TOKEN_QUOTA_THRESHOLD = 10_000
const CHARS_PER_TOKEN = 3 // 中英混合保守估計

/**
 * 估算 memdir 目錄下所有記憶檔案的總 token 量。
 * 用 char count / 3 做粗略估算（不含 MEMORY.md 索引本身）。
 * 失敗時回傳 0（不觸發警告）。
 */
async function estimateMemdirTokens(memDir: string): Promise<number> {
  try {
    const { readdir, stat: statAsync } = await import('fs/promises')
    const entries = await readdir(memDir)
    let totalChars = 0
    for (const entry of entries) {
      if (!entry.endsWith('.md') || entry === ENTRYPOINT_NAME) continue
      try {
        const st = await statAsync(join(memDir, entry))
        totalChars += st.size
      } catch {
        // 單檔 stat 失敗跳過
      }
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN)
  } catch {
    return 0
  }
}

/**
 * 若 memdir token 估算超過閾值，回傳警告字串；否則 null。
 */
async function checkQuotaWarning(memDir: string): Promise<string | null> {
  const tokens = await estimateMemdirTokens(memDir)
  if (tokens >= TOKEN_QUOTA_THRESHOLD) {
    return `⚠ memdir 總量約 ${tokens.toLocaleString()} tokens（閾值 ${TOKEN_QUOTA_THRESHOLD.toLocaleString()}），建議整理或刪除不再需要的記憶檔案。`
  }
  return null
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
    await atomicWrite(indexPath, lines.join('\n'))
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
    const target = input.target ?? 'file'
    if (target === 'user_profile') {
      return `${input.action} user_profile (${input.scope ?? 'global'})`
    }
    return `${input.action} ${input.filename ?? ''}`
  },

  async validateInput(input): Promise<ValidationResult> {
    const target = input.target ?? 'file'

    if (target === 'user_profile') {
      if (!isUserModelEnabled()) {
        return {
          result: false,
          message:
            '使用者建模已停用（FREECODE_DISABLE_USER_MODEL 或 settings.userModelEnabled=false）',
          errorCode: 1,
        }
      }
      const { action } = input
      if (action === 'add' && !input.content?.trim()) {
        return {
          result: false,
          message: 'add user_profile 必須提供 content',
          errorCode: 1,
        }
      }
      if (action === 'replace' && input.content === undefined) {
        return {
          result: false,
          message: 'replace user_profile 必須提供 content（可為空字串清空）',
          errorCode: 1,
        }
      }
      return { result: true }
    }

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
    const { action } = input
    const target = input.target ?? 'file'

    // ---------------------------------------------------------------------
    // user_profile 路徑：USER.md（global 或 project scope）
    // ---------------------------------------------------------------------
    if (target === 'user_profile') {
      const scope = input.scope ?? 'global'
      const rawContent = input.content ?? ''

      // Injection scan（add / replace 才掃；remove 用 content 定位條目不需掃）
      if (action === 'add' || action === 'replace') {
        const hit = scanForInjection(rawContent)
        if (hit) {
          return {
            data: {
              success: false,
              action,
              filename: `USER.md (${scope})`,
              filePath: '',
              message: `寫入被拒：偵測到可疑內容 — ${hit}`,
              indexUpdated: false,
            } satisfies Output,
          }
        }
      }

      const res = await writeUserModel({ action, scope, content: rawContent })
      return {
        data: {
          success: res.success,
          action,
          filename: `USER.md (${scope})`,
          filePath: res.filePath,
          message: res.message,
          indexUpdated: false,
        } satisfies Output,
      }
    }

    const filename = input.filename!
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

    // Advisory lock：保護「記憶檔 + MEMORY.md 索引」的一致性。
    // lock 失敗時繼續（無鎖操作），不阻塞工具執行。
    const release = await acquireMemdirLock(memDir)
    try {
    // -----------------------------------------------------------------------
    // ADD
    // -----------------------------------------------------------------------
    if (action === 'add') {
      // 檢查檔案不存在
      try {
        await fsOps.stat(filePath)
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

      // M2-16：Injection scan（掃 content + name + description）
      const injectionHit = scanForInjection(
        `${input.name}\n${input.description}\n${input.content}`,
      )
      if (injectionHit) {
        return {
          data: {
            success: false,
            action,
            filename,
            filePath,
            message: `寫入被拒：偵測到可疑內容 — ${injectionHit}`,
            indexUpdated: false,
          } satisfies Output,
        }
      }

      const fileContent = buildFileContent(
        input.name!,
        input.description!,
        input.type!,
        input.content!,
      )

      try {
        await atomicWrite(filePath, fileContent)
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

      // M2-17：配額警告
      const quotaWarn = await checkQuotaWarning(memDir)
      const msg = `已建立記憶檔案 ${filename}（type=${input.type}）`

      return {
        data: {
          success: true,
          action,
          filename,
          filePath,
          message: quotaWarn ? `${msg}\n${quotaWarn}` : msg,
          indexUpdated,
        } satisfies Output,
      }
    }

    // -----------------------------------------------------------------------
    // REPLACE
    // -----------------------------------------------------------------------
    if (action === 'replace') {
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

      const { frontmatter, content: existingBody } = parseFrontmatter(
        existingContent,
        filePath,
      )

      const mergedName =
        input.name ?? (frontmatter as Record<string, unknown>).name as string ?? filename
      const mergedDescription =
        input.description ?? frontmatter.description ?? ''
      const mergedType =
        input.type ?? frontmatter.type ?? 'project'
      const mergedContent =
        input.content !== undefined ? input.content : existingBody.trim()

      // M2-16：Injection scan（掃 merged 結果）
      const injectionHit = scanForInjection(
        `${mergedName}\n${mergedDescription}\n${mergedContent}`,
      )
      if (injectionHit) {
        return {
          data: {
            success: false,
            action,
            filename,
            filePath,
            message: `寫入被拒：偵測到可疑內容 — ${injectionHit}`,
            indexUpdated: false,
          } satisfies Output,
        }
      }

      const fileContent = buildFileContent(
        mergedName,
        mergedDescription,
        mergedType,
        mergedContent,
      )

      try {
        await atomicWrite(filePath, fileContent)
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

      // M2-17：配額警告
      const quotaWarn = await checkQuotaWarning(memDir)
      const msg = `已更新記憶檔案 ${filename}`

      return {
        data: {
          success: true,
          action,
          filename,
          filePath,
          message: quotaWarn ? `${msg}\n${quotaWarn}` : msg,
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
    } finally {
      if (release) {
        try {
          await release()
        } catch {
          // unlock 失敗不致命
        }
      }
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
