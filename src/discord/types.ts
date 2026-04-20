/**
 * M-DISCORD-3b：Discord 整合用的平台抽象。
 *
 * 這層把 discord.js Message / Channel / Attachment 抽成 my-agent 自己的
 * 最小介面，讓 router / streamOutput / reactions / attachments 等純函式
 * 模組可以在單元測試裡用 mock 實作取代，不用起真 WS client。
 */

/** 從 Discord 進來的訊息（已解析重要欄位）。 */
export interface DiscordIncomingMessage {
  id: string
  channelId: string
  channelType: 'dm' | 'guild'
  guildId?: string
  authorId: string
  authorUsername?: string
  /** 純文字 content（已含 mention 等原文字串）。 */
  content: string
  /** 附件：下載前的 URL + 元資料。由 attachments module 下載到 cache。 */
  attachments: ReadonlyArray<DiscordAttachment>
  /** 收訊時間 — Unix ms */
  receivedAt: number
}

export interface DiscordAttachment {
  id: string
  filename: string
  url: string
  /** MIME type（image/png 之類）；可能沒值 */
  contentType?: string
  size: number
}

/** Discord channel 端的輸出抽象；真實實作在 gateway 裡用 discord.js。 */
export interface DiscordChannelSink {
  /**
   * 送一則訊息到 channel。replyToId 若有值則用 reply reference。
   * files 為附件路徑（絕對路徑），若有值以 AttachmentBuilder 上傳。
   */
  send(params: {
    content: string
    replyToId?: string
    files?: string[]
  }): Promise<{ messageId: string }>
  addReaction(messageId: string, emoji: string): Promise<void>
  removeReaction(messageId: string, emoji: string): Promise<void>
  /** 顯示 "typing…" 指示器（Discord 自動 10s 後消失；需要的話每 ~8s 再叫）。 */
  sendTyping?(): Promise<void>
}

/**
 * Reaction 用的情境情境（不硬綁 discord.js Message 實例）。
 */
export interface ReactionTarget {
  channelId: string
  messageId: string
}
