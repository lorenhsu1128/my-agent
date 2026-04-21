import React from 'react'
import { Box, Text } from '../../ink.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import { crawl, type CrawlResult } from './crawler.js'
import { DESCRIPTION, WEB_CRAWL_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('Starting URL to crawl'),
    max_depth: z
      .number()
      .int()
      .min(0)
      .max(5)
      .default(2)
      .describe('Max link hops from the start (0 = just the start URL)'),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Hard cap on total pages fetched'),
    same_origin: z
      .boolean()
      .default(true)
      .describe('Only follow links on the same origin as the start URL'),
    instructions: z
      .string()
      .optional()
      .describe(
        'Optional free-text guidance echoed back in the result, so downstream summarisation can focus on what the user cares about.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    startUrl: z.string(),
    pagesCrawled: z.number(),
    durationMs: z.number(),
    result: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

function webCrawlInputToRuleContent(input: { [k: string]: unknown }): string {
  try {
    const parsed = WebCrawlTool.inputSchema.safeParse(input)
    if (!parsed.success) return `input:${String(input)}`
    return `domain:${new URL(parsed.data.url).hostname}`
  } catch {
    return `input:${String(input)}`
  }
}

function formatResult(
  result: CrawlResult,
  instructions: string | undefined,
): string {
  const lines: string[] = []
  lines.push(`# Crawl of ${result.startUrl}`)
  lines.push(
    `Pages: ${result.pagesCrawled}  |  Skipped: ${result.skipped.length}  |  Duration: ${result.durationMs}ms`,
  )
  if (instructions) {
    lines.push(`\nInstructions: ${instructions}`)
  }
  lines.push('')
  for (const p of result.pages) {
    lines.push(`## [depth ${p.depth}] ${p.title}`)
    lines.push(p.url)
    if (p.redacted) lines.push('(Content was redacted — secrets detected.)')
    lines.push('')
    lines.push(p.text)
    lines.push('')
  }
  if (result.skipped.length > 0) {
    lines.push('## Skipped URLs')
    for (const s of result.skipped) {
      lines.push(`- ${s.url} — ${s.reason}`)
    }
  }
  return lines.join('\n')
}

export const WebCrawlTool = buildTool({
  name: WEB_CRAWL_TOOL_NAME,
  searchHint: 'crawl a website following links breadth-first',
  maxResultSizeChars: 200_000,
  shouldDefer: true,
  async description(input) {
    const { url } = input as { url: string }
    try {
      return `Claude wants to crawl ${new URL(url).hostname}`
    } catch {
      return `Claude wants to crawl a website`
    }
  },
  userFacingName() {
    return 'Crawl'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const permissionContext = context.getAppState().toolPermissionContext
    const ruleContent = webCrawlInputToRuleContent(input)

    const denyRule = getRuleByContentsForTool(
      permissionContext,
      WebCrawlTool,
      'deny',
    ).get(ruleContent)
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `${WebCrawlTool.name} denied access to ${ruleContent}.`,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }

    const askRule = getRuleByContentsForTool(
      permissionContext,
      WebCrawlTool,
      'ask',
    ).get(ruleContent)
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to use ${WebCrawlTool.name}, but you haven't granted it yet.`,
        decisionReason: { type: 'rule', rule: askRule },
        suggestions: buildSuggestions(ruleContent),
      }
    }

    const allowRule = getRuleByContentsForTool(
      permissionContext,
      WebCrawlTool,
      'allow',
    ).get(ruleContent)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule: allowRule },
      }
    }

    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${WebCrawlTool.name}, but you haven't granted it yet.`,
      suggestions: buildSuggestions(ruleContent),
    }
  },
  async prompt() {
    return DESCRIPTION
  },
  async validateInput(input) {
    try {
      new URL(input.url)
    } catch {
      return {
        result: false,
        message: `Error: Invalid URL "${input.url}".`,
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    const { url, max_depth, max_pages } = input as {
      url?: string
      max_depth?: number
      max_pages?: number
    }
    return `WebCrawl ${url ?? ''} (depth≤${max_depth ?? 2}, ≤${max_pages ?? 10} pages)`
  },
  renderToolResultMessage(content) {
    const c = content as Output
    return React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(
        Text,
        null,
        `Crawled ${c.pagesCrawled} pages from ${c.startUrl} in ${c.durationMs}ms`,
      ),
    )
  },
  async call(input, { abortController }) {
    const result = await crawl({
      url: input.url,
      maxDepth: input.max_depth,
      maxPages: input.max_pages,
      sameOrigin: input.same_origin,
      signal: abortController.signal,
    })

    const text = formatResult(result, input.instructions)

    const output: Output = {
      startUrl: result.startUrl,
      pagesCrawled: result.pagesCrawled,
      durationMs: result.durationMs,
      result: text,
    }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function buildSuggestions(ruleContent: string): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      destination: 'localSettings',
      rules: [{ toolName: WEB_CRAWL_TOOL_NAME, ruleContent }],
      behavior: 'allow',
    },
  ]
}
