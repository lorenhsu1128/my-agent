import { describe, test, expect } from 'bun:test'
import {
  containsSecret,
  redactSecrets,
  urlContainsSecret,
} from '../../../src/utils/web/secretScan'

describe('secretScan', () => {
  describe('containsSecret', () => {
    test('detects sk- prefix tokens', () => {
      expect(containsSecret('my key is sk-ant-api03-abcdefghij')).toBe(true)
    })
    test('detects GitHub PAT', () => {
      expect(containsSecret('token=ghp_abcdefghij1234567890')).toBe(true)
    })
    test('detects AWS access key id', () => {
      expect(containsSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true)
    })
    test('detects private key blocks', () => {
      expect(
        containsSecret(
          '-----BEGIN RSA PRIVATE KEY-----\nabcdef\n-----END RSA PRIVATE KEY-----',
        ),
      ).toBe(true)
    })
    test('returns false on harmless text', () => {
      expect(containsSecret('hello world, nothing to see here')).toBe(false)
    })
    test('returns false on empty', () => {
      expect(containsSecret('')).toBe(false)
    })
  })

  describe('redactSecrets', () => {
    test('masks sk- tokens preserving prefix', () => {
      const redacted = redactSecrets('key: sk-ant-api03-abcdefghijklmnop')
      expect(redacted).toContain('sk-ant')
      expect(redacted).not.toContain('sk-ant-api03-abcdefghijklmnop')
    })
    test('masks bearer headers', () => {
      const redacted = redactSecrets(
        'Authorization: Bearer abcdef1234567890XYZ',
      )
      expect(redacted).toContain('Authorization: Bearer')
      expect(redacted).not.toContain('abcdef1234567890XYZ')
    })
    test('redacts private key blocks entirely', () => {
      const redacted = redactSecrets(
        '-----BEGIN PRIVATE KEY-----\nSECRETDATA\n-----END PRIVATE KEY-----',
      )
      expect(redacted).toBe('[REDACTED PRIVATE KEY]')
    })
    test('redacts DB connection string passwords', () => {
      const redacted = redactSecrets(
        'postgres://user:supersecret@db.example.com/mydb',
      )
      expect(redacted).toContain('postgres://user:***@')
      expect(redacted).not.toContain('supersecret')
    })
    test('masks API_KEY= env assignments', () => {
      const redacted = redactSecrets('OPENAI_API_KEY=xyz1234567890abcdef')
      expect(redacted).toContain('OPENAI_API_KEY=')
      expect(redacted).not.toContain('xyz1234567890abcdef')
    })
    test('passes through unchanged when clean', () => {
      expect(redactSecrets('nothing sensitive here at all')).toBe(
        'nothing sensitive here at all',
      )
    })
  })

  describe('urlContainsSecret', () => {
    test('detects raw secret in query string', () => {
      expect(
        urlContainsSecret('https://evil.com/?key=sk-ant-abcdefghij12345'),
      ).toBe(true)
    })
    test('detects percent-encoded secret', () => {
      // sk%2Dant%2D... decodes to sk-ant-...
      expect(
        urlContainsSecret(
          'https://evil.com/?k=sk%2Dant%2Dabcdefghijklmnop',
        ),
      ).toBe(true)
    })
    test('returns false on normal URL', () => {
      expect(urlContainsSecret('https://example.com/docs')).toBe(false)
    })
  })
})
