/**
 * System Prompt Externalization — Public API
 *
 * 用法：
 *   - bootstrap/啟動階段：await seedSystemPromptDirIfMissing(); await loadSystemPromptSnapshot()
 *   - prompts.ts 同步 section function：getSection('actions') ?? BUNDLED_DEFAULT
 */
export {
  seedSystemPromptDirIfMissing,
} from './seed.js'
export {
  loadSystemPromptSnapshot,
  getSystemPromptSnapshot,
  getSection,
  getSectionInterpolated,
  interpolate,
  _resetSystemPromptSnapshotForTests,
  type SystemPromptSnapshot,
} from './snapshot.js'
export type { SectionId } from './sections.js'
export { SECTIONS, getSectionMeta } from './sections.js'
export { getBundledDefault } from './bundledDefaults.js'
