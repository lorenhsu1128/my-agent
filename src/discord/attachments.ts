/**
 * M-DISCORD-3b：圖片進出。
 *
 * 進（Discord → agent）：使用者 upload attachment → fetch URL → 存到
 * `~/.my-agent/cache/discord-images/<msg>-<i>-<filename>` → 回傳本地路徑
 * 給 agent 的 messageAdapter 當 image block / `[Image attachment: name]` fallback。
 *
 * 出（agent → Discord）：掃 assistant text 的 Markdown `![alt](path|url)` +
 * absolute file path；回傳 paths 給 streamOutput / gateway 上傳。
 *
 * 設計：純 I/O 函式 + 純 regex；兩者都可單測（fetch 可注入）。
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, extname, join, basename, isAbsolute } from 'path'
import { getMemoryBaseDir } from '../memdir/paths.js'
import { logForDebugging } from '../utils/debug.js'

export const DISCORD_CACHE_DIRNAME = 'cache/discord-images'

export function getDiscordImageCacheDir(): string {
  return join(getMemoryBaseDir(), DISCORD_CACHE_DIRNAME)
}

/** 允許 MIME 前綴白名單（避免下載任意檔）。 */
const IMAGE_MIME_PREFIXES = ['image/']
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024 // 20MB

export interface DownloadOptions {
  /** fetch 實作注入（測試用）。 */
  fetchImpl?: typeof fetch
  /** 最大位元組；預設 20MB。 */
  maxBytes?: number
  /** 目標目錄；預設 ~/.my-agent/cache/discord-images */
  cacheDir?: string
}

export interface CachedAttachment {
  originalUrl: string
  localPath: string
  filename: string
  contentType?: string
  size: number
}

/**
 * 判定一個 attachment 是否為 image（contentType 開頭 image/，或副檔名 .png/.jpg/...）
 */
export function isImageAttachment(a: {
  contentType?: string
  filename: string
}): boolean {
  if (a.contentType) {
    for (const prefix of IMAGE_MIME_PREFIXES) {
      if (a.contentType.toLowerCase().startsWith(prefix)) return true
    }
  }
  const ext = extname(a.filename).toLowerCase()
  return (
    ext === '.png' ||
    ext === '.jpg' ||
    ext === '.jpeg' ||
    ext === '.gif' ||
    ext === '.webp' ||
    ext === '.bmp'
  )
}

/**
 * 下載一個 Discord attachment 到本地 cache。回傳 CachedAttachment；失敗 throw。
 *
 * 檔名格式：`<sha8(url)>-<safeFilename>`（避免衝突 + 保留原名方便 debug）。
 */
export async function cacheDiscordAttachment(
  att: {
    id: string
    filename: string
    url: string
    contentType?: string
    size: number
  },
  opts: DownloadOptions = {},
): Promise<CachedAttachment> {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_SIZE_BYTES
  if (att.size > maxBytes) {
    throw new Error(
      `attachment ${att.filename} (${att.size} bytes) exceeds max ${maxBytes}`,
    )
  }
  const cacheDir = opts.cacheDir ?? getDiscordImageCacheDir()
  await mkdir(cacheDir, { recursive: true })

  // Sanitize：非 word/dot/dash → _ ；連續多個 dot 收斂為單 dot 避免 `..` 出現
  const safeName = att.filename
    .replace(/[^\w.-]+/g, '_')
    .replace(/\.{2,}/g, '.')
  const hash = createHash('sha1').update(att.url).digest('hex').slice(0, 8)
  const localPath = join(cacheDir, `${hash}-${safeName}`)

  // 已快取就直接回傳（Discord CDN URL 是不變的 + 有 signature）
  if (existsSync(localPath)) {
    return {
      originalUrl: att.url,
      localPath,
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl(att.url)
  if (!res.ok) {
    throw new Error(
      `download failed: ${res.status} ${res.statusText} for ${att.url}`,
    )
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxBytes) {
    throw new Error(
      `downloaded content ${buf.length} bytes exceeds max ${maxBytes}`,
    )
  }
  await writeFile(localPath, buf)
  logForDebugging(
    `[discord:attachments] cached ${att.filename} → ${localPath} (${buf.length} bytes)`,
  )
  return {
    originalUrl: att.url,
    localPath,
    filename: att.filename,
    contentType: att.contentType,
    size: buf.length,
  }
}

/**
 * 掃 agent 產的文字找出應上傳到 Discord 的檔案路徑：
 *   - Markdown 圖片：`![alt](path)` 其中 path 是絕對 filesystem 路徑或 http(s) URL
 *   - 無 Markdown 包裝的絕對路徑不挑（太容易誤判）
 *
 * 回傳 `{ paths, urls }`：paths 用 AttachmentBuilder 上傳；urls 送 Discord 自動 preview。
 * cleaned 為把 Markdown 圖片語法移除後的純文字（避免 Discord 收到時顯示 broken path）。
 */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

export interface ExtractedImages {
  /** 絕對 filesystem 路徑（存在才保留）。 */
  paths: string[]
  /** http(s) URL（給 Discord 自動 preview）。 */
  urls: string[]
  /** 移除 markdown image 語法後的文字（使用者仍會看到 alt/url 說明）。 */
  cleanedText: string
}

export function extractImagesFromText(text: string): ExtractedImages {
  const paths: string[] = []
  const urls: string[] = []
  const cleaned = text.replace(
    MARKDOWN_IMAGE_RE,
    (_full, alt: string, href: string) => {
      if (/^https?:\/\//i.test(href)) {
        urls.push(href)
        return alt ? `[image: ${alt}]` : `[image]`
      }
      if (isAbsolute(href) && existsSync(href)) {
        paths.push(href)
        return alt ? `[image: ${alt}] (${basename(href)})` : `[image: ${basename(href)}]`
      }
      // 不認識的（相對路徑且不存在 / data: URL）→ 保留原文
      return `![${alt}](${href})`
    },
  )
  return { paths, urls, cleanedText: cleaned }
}
