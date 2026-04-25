/**
 * 全域設定 JSONC 模板與 seed / migration 公開 API。
 *
 * 與 src/utils/config.ts 的關係：
 *   - config.ts 仍負責 GlobalConfig 的實際讀寫（saveGlobalConfig /
 *     getGlobalConfig 等 30+ 呼叫點）
 *   - 本模組只負責「檔案旁的繁中文件化」— 首次 seed 模板、手動補檔
 *   - 未來 M-CONFIG-JSONC-SAVE 會讓 saveGlobalConfig 走 jsoncStore 保留註解
 */
export { GLOBAL_CONFIG_JSONC_TEMPLATE } from './bundledTemplate.js'
export {
  seedGlobalConfigIfMissing,
  forceRewriteGlobalConfigWithDocs,
} from './seed.js'
