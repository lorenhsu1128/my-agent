import React from 'react'
import { Box, Text } from '../../ink.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from '../../utils/permissions/permissions.js'
import {
  back,
  click,
  closeBrowser,
  consoleLogs,
  evaluate,
  getImages,
  navigate,
  press,
  screenshot,
  scroll,
  snapshot,
  type_,
  vision,
} from './actions.js'
import { DESCRIPTION, WEB_BROWSER_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('navigate'),
      url: z.string().url().describe('URL to navigate to'),
    }),
    z.strictObject({
      action: z.literal('snapshot'),
    }),
    z.strictObject({
      action: z.literal('click'),
      ref: z.string().describe('Element ref from the latest snapshot, e.g. "@e5"'),
    }),
    z.strictObject({
      action: z.literal('type'),
      ref: z.string(),
      text: z.string().describe('Text to fill into the input'),
    }),
    z.strictObject({
      action: z.literal('scroll'),
      direction: z.enum(['up', 'down']),
    }),
    z.strictObject({
      action: z.literal('back'),
    }),
    z.strictObject({
      action: z.literal('press'),
      key: z.string().describe('Key to press, e.g. "Enter", "Tab"'),
    }),
    z.strictObject({
      action: z.literal('console'),
      clear: z.boolean().optional(),
    }),
    z.strictObject({
      action: z.literal('evaluate'),
      expression: z.string().describe('JavaScript expression to run in page context'),
    }),
    z.strictObject({
      action: z.literal('close'),
    }),
    z.strictObject({
      action: z.literal('screenshot'),
      full_page: z.boolean().default(false),
    }),
    z.strictObject({
      action: z.literal('vision'),
      question: z
        .string()
        .describe('Question about the current page for the vision model'),
    }),
    z.strictObject({
      action: z.literal('get_images'),
    }),
  ]),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.string(),
    result: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type InputUnion = z.infer<InputSchema>

function ruleContent(input: unknown): string {
  const i = input as { action?: string; url?: string }
  if (i && i.action === 'navigate' && typeof i.url === 'string') {
    try {
      return `domain:${new URL(i.url).hostname}`
    } catch {
      /* fallthrough */
    }
  }
  if (i && i.action === 'evaluate') return 'action:evaluate'
  return `action:${i?.action ?? 'unknown'}`
}

async function dispatch(input: InputUnion): Promise<unknown> {
  switch (input.action) {
    case 'navigate':
      return navigate(input.url)
    case 'snapshot':
      return snapshot()
    case 'click':
      return click(input.ref)
    case 'type':
      return type_(input.ref, input.text)
    case 'scroll':
      return scroll(input.direction)
    case 'back':
      return back()
    case 'press':
      return press(input.key)
    case 'console':
      return consoleLogs(input.clear)
    case 'evaluate':
      return evaluate(input.expression)
    case 'close':
      return closeBrowser()
    case 'screenshot':
      return screenshot(input.full_page)
    case 'vision':
      return vision(input.question)
    case 'get_images':
      return getImages()
  }
}

export const WebBrowserTool = buildTool({
  name: WEB_BROWSER_TOOL_NAME,
  searchHint: 'drive a real browser: navigate, click, type, snapshot',
  maxResultSizeChars: 150_000,
  shouldDefer: true,
  async description(input) {
    const i = input as { action?: string; url?: string }
    if (i?.action === 'navigate' && i.url) {
      try {
        return `Claude wants to open ${new URL(i.url).hostname} in a browser`
      } catch {
        /* noop */
      }
    }
    return `Claude wants to use the browser (${i?.action ?? 'unknown'})`
  },
  userFacingName() {
    return 'Browser'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false // single shared session
  },
  isReadOnly(input) {
    const action = (input as { action?: string })?.action
    return (
      action === 'snapshot' ||
      action === 'console' ||
      action === 'screenshot' ||
      action === 'vision' ||
      action === 'get_images'
    )
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const permissionContext = context.getAppState().toolPermissionContext
    const rc = ruleContent(input)

    // Hard deny for `evaluate` unless an explicit allow rule exists
    const isEvaluate = (input as { action?: string }).action === 'evaluate'

    const denyRule = getRuleByContentsForTool(
      permissionContext,
      WebBrowserTool,
      'deny',
    ).get(rc)
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `${WebBrowserTool.name} denied: ${rc}.`,
        decisionReason: { type: 'rule', rule: denyRule },
      }
    }

    const allowRule = getRuleByContentsForTool(
      permissionContext,
      WebBrowserTool,
      'allow',
    ).get(rc)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule: allowRule },
      }
    }

    // evaluate requires explicit allow; never defaults to ask-and-allow
    if (isEvaluate) {
      return {
        behavior: 'ask',
        message: `${WebBrowserTool.name} evaluate requires an explicit allow rule — JavaScript will run in the page context.`,
        suggestions: buildSuggestions(rc),
      }
    }

    return {
      behavior: 'ask',
      message: `Claude requested permissions to use ${WebBrowserTool.name}, but you haven't granted it yet.`,
      suggestions: buildSuggestions(rc),
    }
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage(input) {
    const i = input as { action?: string; url?: string; ref?: string }
    const detail =
      i?.action === 'navigate'
        ? i.url
        : i?.action && i.ref
          ? `${i.action} ${i.ref}`
          : (i?.action ?? '')
    return `Browser ${detail}`
  },
  renderToolUseProgressMessage() {
    // Puppeteer 首次啟動 Chromium 可能 5-30 秒（navigate 還有 30s page load
    // timeout）— 給使用者一個活動指示，避免誤以為 hang。
    return React.createElement(
      Box,
      null,
      React.createElement(
        Text,
        { dimColor: true },
        'Browsing… (first launch can take 10-30s)',
      ),
    )
  },
  renderToolResultMessage(content) {
    const c = content as Output
    return React.createElement(
      Box,
      null,
      React.createElement(Text, null, `Browser.${c.action} ok`),
    )
  },
  async call(input) {
    // 診斷 log：daemon 以 stdio:ignore 起，puppeteer / chromium 錯誤會被吞。
    // 寫 ~/.my-agent/web-browser.log，hang 時可以 tail 看 phase 卡哪。
    const logLine = (msg: string): void => {
      try {
        const homedir = require('os').homedir() as string
        const path = require('path') as typeof import('path')
        const fs = require('fs') as typeof import('fs')
        const logPath = path.join(homedir, '.my-agent', 'web-browser.log')
        fs.appendFileSync(
          logPath,
          `${new Date().toISOString()} ${msg}\n`,
          'utf8',
        )
      } catch {
        /* ignore log failures */
      }
    }
    const t0 = Date.now()
    logLine(`call start action=${input.action}`)
    try {
      const result = await dispatch(input)
      const text =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      logLine(
        `call ok action=${input.action} ${Date.now() - t0}ms bytes=${text.length}`,
      )
      return {
        data: { action: input.action, result: text },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error && err.stack ? err.stack : ''
      logLine(
        `call ERR action=${input.action} ${Date.now() - t0}ms msg=${msg}\nstack=${stack}`,
      )
      throw err
    }
  },
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function buildSuggestions(rc: string): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      destination: 'localSettings',
      rules: [{ toolName: WEB_BROWSER_TOOL_NAME, ruleContent: rc }],
      behavior: 'allow',
    },
  ]
}
