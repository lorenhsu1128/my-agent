/**
 * Bridge safety.ts 單元測試 — SQL 過濾 + auto LIMIT
 */
import { describe, test, expect } from 'bun:test'

// 直接 import bridge 原始碼（bun 可以跑 TS）
import { validateSQL, ensureLimit } from '../../../src/tools/InformixQueryTool/bridge/src/safety.js'

describe('validateSQL', () => {
  describe('允許的 SELECT 語句', () => {
    test('簡單 SELECT', () => {
      const r = validateSQL('SELECT * FROM customers')
      expect(r.ok).toBe(true)
    })

    test('帶 WHERE 的 SELECT', () => {
      const r = validateSQL("SELECT name, age FROM users WHERE age > 18")
      expect(r.ok).toBe(true)
    })

    test('帶 JOIN 的 SELECT', () => {
      const r = validateSQL(`
        SELECT a.name, b.total
        FROM customers a
        LEFT OUTER JOIN orders b ON a.id = b.customer_id
      `)
      expect(r.ok).toBe(true)
    })

    test('WITH CTE', () => {
      const r = validateSQL(`
        WITH recent AS (
          SELECT * FROM orders WHERE order_date > '2024-01-01'
        )
        SELECT * FROM recent
      `)
      expect(r.ok).toBe(true)
    })

    test('帶聚合的 SELECT', () => {
      const r = validateSQL('SELECT COUNT(*), SUM(amount) FROM orders GROUP BY status')
      expect(r.ok).toBe(true)
    })

    test('允許末尾分號', () => {
      const r = validateSQL('SELECT * FROM customers;')
      expect(r.ok).toBe(true)
    })

    test('SELECT 大小寫不敏感', () => {
      const r = validateSQL('select * from customers')
      expect(r.ok).toBe(true)
    })

    test('帶子查詢的 SELECT', () => {
      const r = validateSQL(`
        SELECT * FROM customers
        WHERE id IN (SELECT customer_id FROM orders WHERE total > 1000)
      `)
      expect(r.ok).toBe(true)
    })
  })

  describe('拒絕的語句', () => {
    test('INSERT', () => {
      const r = validateSQL("INSERT INTO users VALUES (1, 'test')")
      expect(r.ok).toBe(false)
      expect(r.error).toContain('Only SELECT')
    })

    test('UPDATE', () => {
      const r = validateSQL("UPDATE users SET name = 'test' WHERE id = 1")
      expect(r.ok).toBe(false)
    })

    test('DELETE', () => {
      const r = validateSQL('DELETE FROM users WHERE id = 1')
      expect(r.ok).toBe(false)
    })

    test('DROP TABLE', () => {
      const r = validateSQL('DROP TABLE users')
      expect(r.ok).toBe(false)
    })

    test('ALTER TABLE', () => {
      const r = validateSQL('ALTER TABLE users ADD COLUMN age INT')
      expect(r.ok).toBe(false)
    })

    test('TRUNCATE', () => {
      const r = validateSQL('TRUNCATE TABLE users')
      expect(r.ok).toBe(false)
    })

    test('CREATE TABLE', () => {
      const r = validateSQL('CREATE TABLE test (id INT)')
      expect(r.ok).toBe(false)
    })

    test('EXECUTE PROCEDURE', () => {
      const r = validateSQL('EXECUTE PROCEDURE my_proc()')
      expect(r.ok).toBe(false)
    })

    test('GRANT', () => {
      const r = validateSQL('GRANT SELECT ON users TO public')
      expect(r.ok).toBe(false)
    })

    test('多語句（中間分號）', () => {
      const r = validateSQL('SELECT 1; DROP TABLE users')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('Multiple statements')
    })

    test('INTO TEMP', () => {
      const r = validateSQL('SELECT * INTO TEMP tmp_table FROM users')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('INTO TEMP')
    })

    test('INTO EXTERNAL', () => {
      const r = validateSQL("SELECT * INTO EXTERNAL '/tmp/data.csv' FROM users")
      expect(r.ok).toBe(false)
      expect(r.error).toContain('INTO EXTERNAL')
    })

    test('空語句', () => {
      const r = validateSQL('')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('Empty')
    })

    test('純空白', () => {
      const r = validateSQL('   \n\t  ')
      expect(r.ok).toBe(false)
    })
  })

  describe('SQL 註解移除', () => {
    test('單行註解', () => {
      const r = validateSQL('SELECT * FROM users -- this is a comment')
      expect(r.ok).toBe(true)
    })

    test('多行註解', () => {
      const r = validateSQL('SELECT /* comment */ * FROM users')
      expect(r.ok).toBe(true)
    })

    test('註解中的危險關鍵字不影響判斷', () => {
      const r = validateSQL('SELECT * FROM users /* DELETE this later */')
      // DELETE 在註解中被移除後，語句只有 SELECT
      expect(r.ok).toBe(true)
    })
  })

  describe('SELECT 中包含關鍵字子字串的安全情況', () => {
    test('欄位名包含 update 子字串', () => {
      // "last_updated" 包含 "update" 但不是獨立 token
      const r = validateSQL('SELECT last_updated FROM users')
      expect(r.ok).toBe(true)
    })

    test('表名包含 delete 子字串', () => {
      const r = validateSQL('SELECT * FROM deleted_records')
      // "deleted_records" — "DELETE" 作為 word boundary 不應匹配 "deleted"
      // 但 \bDELETE\b 會匹配 "DELETE" 在 "DELETED" 中？不，\b 在 D 和 D 之間
      // 實際上 "DELETED" 包含 "DELETE" + "D"，\bDELETE\b 匹配 "DELETE" 因為 E→D 不是 word boundary
      // 等一下，"DELETED" — D-E-L-E-T-E-D，\bDELETE\b 不匹配因為 E 後面是 D（都是 word char）
      expect(r.ok).toBe(true)
    })
  })
})

describe('ensureLimit', () => {
  test('無 FIRST 子句時自動加', () => {
    const result = ensureLimit('SELECT * FROM users', 100)
    expect(result).toBe('SELECT FIRST 100 * FROM users')
  })

  test('已有 FIRST 子句不重複加', () => {
    const result = ensureLimit('SELECT FIRST 10 * FROM users', 100)
    expect(result).toBe('SELECT FIRST 10 * FROM users')
  })

  test('大小寫不敏感', () => {
    const result = ensureLimit('select * from users', 50)
    // replace 用 /^SELECT/i 匹配，替換為 'SELECT FIRST 50'（大寫）
    expect(result).toBe('SELECT FIRST 50 * from users')
  })

  test('WITH CTE 語句加在主 SELECT 後', () => {
    const sql = 'WITH cte AS (SELECT id FROM t) SELECT * FROM cte'
    const result = ensureLimit(sql, 100)
    expect(result).toContain('FIRST 100')
    // FIRST 應該在主 SELECT 後面，不是 CTE 的 SELECT
    expect(result.indexOf('FIRST')).toBeGreaterThan(sql.indexOf(')'))
  })

  test('limit 值正確反映', () => {
    const result = ensureLimit('SELECT * FROM users', 500)
    expect(result).toBe('SELECT FIRST 500 * FROM users')
  })
})
