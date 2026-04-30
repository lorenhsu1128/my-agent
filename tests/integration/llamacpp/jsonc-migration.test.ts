/**
 * llamacpp.json strict JSON → JSONC migration 測試。
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseJsonc,
  _internals as _jsoncInternals,
} from '../../../src/utils/jsoncStore'
import { LLAMACPP_JSONC_TEMPLATE } from '../../../src/llamacppConfig/bundledTemplate'
import { LlamaCppConfigSchema } from '../../../src/llamacppConfig/schema'

void _jsoncInternals

let testDir: string

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `llamacpp-migration-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // Windows lock 容忍
  }
})

describe('llamacpp JSONC template', () => {
  test('模板本身是合法 JSONC', () => {
    const parsed = parseJsonc(LLAMACPP_JSONC_TEMPLATE)
    expect(parsed).toBeDefined()
    expect(parsed).toHaveProperty('baseUrl')
    expect(parsed).toHaveProperty('server')
    expect(parsed).toHaveProperty('vision')
  })

  test('模板通過 Zod schema 驗證', () => {
    const parsed = parseJsonc(LLAMACPP_JSONC_TEMPLATE)
    const result = LlamaCppConfigSchema.safeParse(parsed)
    expect(result.success).toBe(true)
  })

  test('模板含繁中註解', () => {
    expect(LLAMACPP_JSONC_TEMPLATE).toMatch(/\/\/\s+/)
    expect(LLAMACPP_JSONC_TEMPLATE).toContain('本地模型')
    expect(LLAMACPP_JSONC_TEMPLATE).toContain('凍結快照')
  })

  test('模板 client 層預設值與 schema 一致', () => {
    const parsed = parseJsonc(LLAMACPP_JSONC_TEMPLATE) as Record<string, unknown>
    const defaults = LlamaCppConfigSchema.parse({})
    expect(parsed.baseUrl).toBe(defaults.baseUrl)
    expect(parsed.model).toBe(defaults.model)
    expect(parsed.contextSize).toBe(defaults.contextSize)
    expect(parsed.modelAliases).toEqual(defaults.modelAliases)
  })

  test('模板 server 層有所有必要欄位的具體值（Zod .default({}) 不遞迴，模板需顯式列）', () => {
    const parsed = parseJsonc(LLAMACPP_JSONC_TEMPLATE) as Record<string, unknown>
    const server = parsed.server as Record<string, unknown>
    expect(server.host).toBe('127.0.0.1')
    expect(server.port).toBe(8080)
    expect(server.ctxSize).toBe(131072)
    expect(server.gpuLayers).toBe(99)
    expect(server.alias).toBe('qwen3.5-9b')
    expect(Array.isArray(server.extraArgs)).toBe(true)
  })
})

describe('isStrictJson 判斷', () => {
  // 模擬 seed.ts 內部的判斷邏輯
  function isStrictJson(text: string): boolean {
    const stripped = text.replace(/^﻿/, '').trim()
    if (!stripped) return false
    try {
      JSON.parse(stripped)
      return true
    } catch {
      return false
    }
  }

  test('嚴格 JSON 回 true', () => {
    expect(isStrictJson('{"a": 1}')).toBe(true)
  })

  test('含 // 註解 → false（JSONC）', () => {
    expect(isStrictJson('{\n// 註解\n"a": 1\n}')).toBe(false)
  })

  test('含尾部逗號 → false', () => {
    expect(isStrictJson('{"a": 1,}')).toBe(false)
  })

  test('空字串 → false', () => {
    expect(isStrictJson('')).toBe(false)
  })
})
