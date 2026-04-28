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
  isVisionEnabled,
  resolveEndpoint,
  _resetLlamaCppConfigForTests,
  type ResolvedLlamaCppEndpoint,
} from './loader.js'
export {
  DEFAULT_LLAMACPP_CONFIG,
  LlamaCppConfigSchema,
  LlamaCppServerSchema,
  LlamaCppVisionSchema,
  LlamaCppServerVisionSchema,
  LlamaCppRemoteSchema,
  LlamaCppRoutingSchema,
  RoutingTargetEnum,
  type LlamaCppConfig,
  type LlamaCppServerConfig,
  type LlamaCppVisionConfig,
  type LlamaCppServerVisionConfig,
  type LlamaCppRemoteConfig,
  type LlamaCppRoutingConfig,
  type LlamaCppRoutingTarget,
  type LlamaCppCallSite,
} from './schema.js'
export { getLlamaCppConfigPath, LLAMACPP_CONFIG_FILENAME } from './paths.js'
