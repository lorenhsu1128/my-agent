/**
 * M-DISCORD-3b：Discord Message → agent prompt + image blocks。
 *
 * 把 DiscordIncomingMessage 轉成 agent 可以直接 submit 的 prompt。
 *
 * 設計：
 *   - 純文字 → router.prompt 當 prompt body
 *   - image attachments → 下載快取 + 組成 Anthropic image block 陣列
 *     （或 `[Image attachment: name]` 字串 fallback — 依 llamacpp vision 狀態 + user 決策）
 *   - 非 image attachment（.pdf / .txt）先忽略（可在 prompt 尾加 `[Attached: filename]` 提示）
 *
 * 本模組不呼叫 broker.queue；只負責產出 submit 的字串 / image block 陣列。
 * 實際的 "submit 進 ProjectRuntime.broker.queue" 是 gateway 的事。
 */
import {
  cacheDiscordAttachment,
  isImageAttachment,
  type CachedAttachment,
  type DownloadOptions,
} from './attachments.js'
import type {
  DiscordAttachment,
  DiscordIncomingMessage,
} from './types.js'

/**
 * Anthropic-style image source block（my-agent vision path 用）。
 * 與 M-VISION 的 imageBlockToOpenAIPart 介面一致。
 */
export interface AgentImageBlock {
  type: 'image'
  source: {
    type: 'base64' | 'path'
    media_type?: string
    data?: string
    path?: string
  }
}

export interface AdaptedMessage {
  /** 要 submit 給 broker.queue 的文字 body（純文字；不含圖片）。 */
  text: string
  /** 已下載快取的 image attachments（用於 image block / 提示文字）。 */
  images: CachedAttachment[]
  /** 非圖片附件（目前只記錄不轉；future 可接 PDF 讀取等）。 */
  otherAttachments: DiscordAttachment[]
  /** image block 陣列（給支援 vision 的 provider）。 */
  imageBlocks: AgentImageBlock[]
  /** 下載失敗清單（不中斷流程，由 gateway 回饋給使用者）。 */
  failedAttachments: Array<{ filename: string; reason: string }>
}

export interface AdaptMessageOptions {
  /** 由 router 給的去前綴後 prompt（不含 `#projectId`）。 */
  promptText: string
  /** 下載 options（fetch inject / cache dir override）。 */
  download?: DownloadOptions
  /** vision 是否啟用。false 時 images 仍下載但不組 imageBlocks（字串佔位）。 */
  visionEnabled?: boolean
}

export async function adaptDiscordMessage(
  msg: DiscordIncomingMessage,
  opts: AdaptMessageOptions,
): Promise<AdaptedMessage> {
  const images: CachedAttachment[] = []
  const otherAttachments: DiscordAttachment[] = []
  const failed: Array<{ filename: string; reason: string }> = []

  for (const att of msg.attachments) {
    if (!isImageAttachment(att)) {
      otherAttachments.push(att)
      continue
    }
    try {
      const cached = await cacheDiscordAttachment(att, opts.download)
      images.push(cached)
    } catch (e) {
      failed.push({
        filename: att.filename,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // Build image blocks (only if vision)
  const imageBlocks: AgentImageBlock[] = opts.visionEnabled
    ? images.map(img => ({
        type: 'image',
        source: {
          type: 'path',
          path: img.localPath,
          media_type: img.contentType,
        },
      }))
    : []

  // 如果 vision 未啟用，image 改以 inline 提示：`[Image attachment: name]`。
  const visionHints = !opts.visionEnabled
    ? images.map(img => `[Image attachment: ${img.filename}]`)
    : []
  const otherHints = otherAttachments.map(
    a => `[Attached (not processed): ${a.filename}]`,
  )
  const failedHints = failed.map(
    f => `[Attachment download failed: ${f.filename} — ${f.reason}]`,
  )

  const pieces: string[] = []
  if (opts.promptText.trim().length > 0) pieces.push(opts.promptText)
  if (visionHints.length > 0) pieces.push(visionHints.join('\n'))
  if (otherHints.length > 0) pieces.push(otherHints.join('\n'))
  if (failedHints.length > 0) pieces.push(failedHints.join('\n'))
  const text = pieces.join('\n\n')

  return { text, images, otherAttachments, imageBlocks, failedAttachments: failed }
}
