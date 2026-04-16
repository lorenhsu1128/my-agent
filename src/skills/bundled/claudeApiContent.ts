// Content for the claude-api bundled skill.
// Each .md file is inlined as a string at build time via Bun's text loader.
// Synced from https://github.com/anthropics/skills/tree/main/skills/claude-api

import csharpClaudeApi from './claude-api/csharp/claude-api.md'
import curlExamples from './claude-api/curl/examples.md'
import curlManagedAgents from './claude-api/curl/managed-agents.md'
import goClaudeApi from './claude-api/go/claude-api.md'
import goManagedAgents from './claude-api/go/managed-agents/README.md'
import javaClaudeApi from './claude-api/java/claude-api.md'
import javaManagedAgents from './claude-api/java/managed-agents/README.md'
import phpClaudeApi from './claude-api/php/claude-api.md'
import phpManagedAgents from './claude-api/php/managed-agents/README.md'
import pythonClaudeApiBatches from './claude-api/python/claude-api/batches.md'
import pythonClaudeApiFilesApi from './claude-api/python/claude-api/files-api.md'
import pythonClaudeApiReadme from './claude-api/python/claude-api/README.md'
import pythonClaudeApiStreaming from './claude-api/python/claude-api/streaming.md'
import pythonClaudeApiToolUse from './claude-api/python/claude-api/tool-use.md'
import pythonManagedAgents from './claude-api/python/managed-agents/README.md'
import rubyClaudeApi from './claude-api/ruby/claude-api.md'
import rubyManagedAgents from './claude-api/ruby/managed-agents/README.md'
import skillPrompt from './claude-api/SKILL.md'
import sharedAgentDesign from './claude-api/shared/agent-design.md'
import sharedErrorCodes from './claude-api/shared/error-codes.md'
import sharedLiveSources from './claude-api/shared/live-sources.md'
import sharedManagedAgentsApiRef from './claude-api/shared/managed-agents-api-reference.md'
import sharedManagedAgentsClientPatterns from './claude-api/shared/managed-agents-client-patterns.md'
import sharedManagedAgentsCore from './claude-api/shared/managed-agents-core.md'
import sharedManagedAgentsEnvs from './claude-api/shared/managed-agents-environments.md'
import sharedManagedAgentsEvents from './claude-api/shared/managed-agents-events.md'
import sharedManagedAgentsOnboarding from './claude-api/shared/managed-agents-onboarding.md'
import sharedManagedAgentsOverview from './claude-api/shared/managed-agents-overview.md'
import sharedManagedAgentsTools from './claude-api/shared/managed-agents-tools.md'
import sharedModels from './claude-api/shared/models.md'
import sharedPromptCaching from './claude-api/shared/prompt-caching.md'
import sharedToolUseConcepts from './claude-api/shared/tool-use-concepts.md'
import typescriptClaudeApiBatches from './claude-api/typescript/claude-api/batches.md'
import typescriptClaudeApiFilesApi from './claude-api/typescript/claude-api/files-api.md'
import typescriptClaudeApiReadme from './claude-api/typescript/claude-api/README.md'
import typescriptClaudeApiStreaming from './claude-api/typescript/claude-api/streaming.md'
import typescriptClaudeApiToolUse from './claude-api/typescript/claude-api/tool-use.md'
import typescriptManagedAgents from './claude-api/typescript/managed-agents/README.md'

// @[MODEL LAUNCH]: Update the model IDs/names below. These are substituted into {{VAR}}
// placeholders in the .md files at runtime before the skill prompt is sent.
// After updating these constants, manually update the two files that still hardcode models:
//   - claude-api/SKILL.md (Current Models pricing table)
//   - claude-api/shared/models.md (full model catalog with legacy versions and alias mappings)
export const SKILL_MODEL_VARS = {
  OPUS_ID: 'claude-opus-4-6',
  OPUS_NAME: 'Claude Opus 4.6',
  SONNET_ID: 'claude-sonnet-4-6',
  SONNET_NAME: 'Claude Sonnet 4.6',
  HAIKU_ID: 'claude-haiku-4-5',
  HAIKU_NAME: 'Claude Haiku 4.5',
  // Previous Sonnet ID — used in "do not append date suffixes" example in SKILL.md.
  PREV_SONNET_ID: 'claude-sonnet-4-5',
} satisfies Record<string, string>

export const SKILL_PROMPT: string = skillPrompt

export const SKILL_FILES: Record<string, string> = {
  // Per-language Claude API docs
  'csharp/claude-api.md': csharpClaudeApi,
  'curl/examples.md': curlExamples,
  'curl/managed-agents.md': curlManagedAgents,
  'go/claude-api.md': goClaudeApi,
  'go/managed-agents/README.md': goManagedAgents,
  'java/claude-api.md': javaClaudeApi,
  'java/managed-agents/README.md': javaManagedAgents,
  'php/claude-api.md': phpClaudeApi,
  'php/managed-agents/README.md': phpManagedAgents,
  'python/claude-api/README.md': pythonClaudeApiReadme,
  'python/claude-api/batches.md': pythonClaudeApiBatches,
  'python/claude-api/files-api.md': pythonClaudeApiFilesApi,
  'python/claude-api/streaming.md': pythonClaudeApiStreaming,
  'python/claude-api/tool-use.md': pythonClaudeApiToolUse,
  'python/managed-agents/README.md': pythonManagedAgents,
  'ruby/claude-api.md': rubyClaudeApi,
  'ruby/managed-agents/README.md': rubyManagedAgents,
  'typescript/claude-api/README.md': typescriptClaudeApiReadme,
  'typescript/claude-api/batches.md': typescriptClaudeApiBatches,
  'typescript/claude-api/files-api.md': typescriptClaudeApiFilesApi,
  'typescript/claude-api/streaming.md': typescriptClaudeApiStreaming,
  'typescript/claude-api/tool-use.md': typescriptClaudeApiToolUse,
  'typescript/managed-agents/README.md': typescriptManagedAgents,
  // Shared docs (language-independent)
  'shared/agent-design.md': sharedAgentDesign,
  'shared/error-codes.md': sharedErrorCodes,
  'shared/live-sources.md': sharedLiveSources,
  'shared/managed-agents-api-reference.md': sharedManagedAgentsApiRef,
  'shared/managed-agents-client-patterns.md': sharedManagedAgentsClientPatterns,
  'shared/managed-agents-core.md': sharedManagedAgentsCore,
  'shared/managed-agents-environments.md': sharedManagedAgentsEnvs,
  'shared/managed-agents-events.md': sharedManagedAgentsEvents,
  'shared/managed-agents-onboarding.md': sharedManagedAgentsOnboarding,
  'shared/managed-agents-overview.md': sharedManagedAgentsOverview,
  'shared/managed-agents-tools.md': sharedManagedAgentsTools,
  'shared/models.md': sharedModels,
  'shared/prompt-caching.md': sharedPromptCaching,
  'shared/tool-use-concepts.md': sharedToolUseConcepts,
}
