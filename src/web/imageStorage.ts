/**
 * M-WEB-PARITY-5：Web 圖片上傳 storage。
 *
 * 設計：
 *   - 存到 ~/.my-agent/web-images/<projectIdSafe>/<imageId>.<ext>
 *   - imageId = randomUUID 沒做 hash 去重（簡單起見；同檔多次上傳兩份）
 *   - refToken 格式 `[Image:<imageId>]`，daemon 端轉送 ask() 前解析成 image
 *     content block。Lifetime 與 ProjectRuntime 解耦：rotateProject 後仍可用，
 *     但因為 sessionId 換了已沒人引用 → 後台清理留 P3
 *   - 大小上限 10MB（base64 encoded 約 13MB）
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

function rootDir(): string {
  return process.env.MY_AGENT_CONFIG_HOME ?? join(homedir(), '.my-agent')
}

function imagesDir(projectIdSafe: string): string {
  return join(rootDir(), 'web-images', projectIdSafe)
}

export interface StoredImage {
  imageId: string
  refToken: string
  path: string
  mimeType: string
  size: number
}

export function storeImage(opts: {
  projectId: string
  data: Buffer
  mimeType: string
}): StoredImage {
  if (opts.data.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large: ${opts.data.length} bytes (max ${MAX_IMAGE_BYTES})`,
    )
  }
  const ext = MIME_EXT[opts.mimeType.toLowerCase()]
  if (!ext) {
    throw new Error(`unsupported image mimetype: ${opts.mimeType}`)
  }
  // 對 projectId 簡單清洗（防 traversal）
  const safe = opts.projectId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  const dir = imagesDir(safe)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const imageId = randomUUID()
  const filename = `${imageId}.${ext}`
  const fullPath = join(dir, filename)
  writeFileSync(fullPath, opts.data, { mode: 0o600 })
  return {
    imageId,
    refToken: `[Image:${imageId}]`,
    path: fullPath,
    mimeType: opts.mimeType,
    size: opts.data.length,
  }
}

/**
 * 解析 prompt 字串中的 `[Image:<id>]` refToken；對每個 token 讀檔回 base64
 * + mimeType。回傳 ContentBlockParam-compatible 物件。
 *
 * 找不到的 imageId（檔案不存在）保留原 token（讓 user 看到引用失敗，模型也能
 * 在文字裡看到 placeholder）。
 */
export interface ResolvedImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export function resolveImageRefs(
  prompt: string,
  projectId: string,
): { text: string; images: ResolvedImageBlock[] } {
  const tokenRe = /\[Image:([0-9a-f-]{16,})\]/gi
  const safe = projectId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  const dir = imagesDir(safe)
  const images: ResolvedImageBlock[] = []
  const seen = new Set<string>()
  let resultText = prompt
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(prompt)) !== null) {
    const id = m[1]!
    if (seen.has(id)) continue
    seen.add(id)
    // 找 ext
    let found: { path: string; ext: string } | null = null
    for (const ext of Object.values(MIME_EXT)) {
      const p = join(dir, `${id}.${ext}`)
      if (existsSync(p)) {
        found = { path: p, ext }
        break
      }
    }
    if (!found) continue
    const data = readFileSync(found.path)
    const media =
      Object.entries(MIME_EXT).find(([, e]) => e === found!.ext)?.[0] ??
      'image/png'
    images.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: media,
        data: data.toString('base64'),
      },
    })
    // 把 token 從 prompt 移除（避免模型看到雜訊）；用空字串置換
    resultText = resultText.replace(m[0], '')
  }
  return { text: resultText.trim(), images }
}
