/**
 * llama.cpp 設定檔模組 public API
 *
 * 用法：
 *   - bootstrap：await seedLlamaCppConfigIfMissing(); await loadLlamaCppConfigSnapshot()
 *   - TS 執行期：getLlamaCppConfigSnapshot() 同步取凍結快照
 */
export { seedLlamaCppConfigIfMissing } from './seed.js'
export {
  loadLlamaCppConfigSnapshot,
  getLlamaCppConfigSnapshot,
  _resetLlamaCppConfigForTests,
} from './loader.js'
export {
  DEFAULT_LLAMACPP_CONFIG,
  LlamaCppConfigSchema,
  LlamaCppServerSchema,
  type LlamaCppConfig,
  type LlamaCppServerConfig,
} from './schema.js'
export { getLlamaCppConfigPath, LLAMACPP_CONFIG_FILENAME } from './paths.js'
