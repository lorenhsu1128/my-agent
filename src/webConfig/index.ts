/**
 * M-WEB：Web UI 設定模組 public API。
 *
 * 用法：
 *   - bootstrap：await seedWebConfigIfMissing(); await loadWebConfigSnapshot()
 *   - 執行期：getWebConfigSnapshot() 同步取凍結快照
 *   - 變更：updateWebConfigField('port', 9091) 寫盤 + in-place mutate
 */
export {
  WebConfigSchema,
  DEFAULT_WEB_CONFIG,
  type WebConfig,
} from './schema.js'
export { getWebConfigPath, WEB_CONFIG_FILENAME } from './paths.js'
export {
  loadWebConfigSnapshot,
  getWebConfigSnapshot,
  isWebEnabled,
  updateWebConfigField,
  _resetWebConfigForTests,
} from './loader.js'
export { seedWebConfigIfMissing } from './seed.js'
