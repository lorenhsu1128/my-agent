import React from 'react'
import { Box, Text } from '../../ink.js'

interface QueryResultProps {
  action: string
  result: string
}

/**
 * InformixQuery 結果渲染元件
 */
export function InformixQueryResult({ action, result }: QueryResultProps): React.ReactElement {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>

    if (action === 'query' && parsed.ok) {
      const columns = parsed.columns as string[]
      const rows = parsed.rows as unknown[][]
      const rowCount = parsed.rowCount as number
      const elapsed = parsed.elapsed as number

      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(
          Text,
          { color: 'green' },
          `✓ ${rowCount} rows (${elapsed}ms)`,
        ),
        columns &&
          React.createElement(
            Text,
            { dimColor: true },
            `Columns: ${columns.join(', ')}`,
          ),
        rows &&
          rows.length > 0 &&
          React.createElement(
            Text,
            null,
            formatTable(columns, rows.slice(0, 5)),
          ),
        rows &&
          rows.length > 5 &&
          React.createElement(
            Text,
            { dimColor: true },
            `... and ${rows.length - 5} more rows`,
          ),
      )
    }

    return React.createElement(
      Box,
      null,
      React.createElement(Text, null, `InformixQuery.${action} ok`),
    )
  } catch {
    return React.createElement(
      Box,
      null,
      React.createElement(Text, null, result.slice(0, 200)),
    )
  }
}

function formatTable(columns: string[], rows: unknown[][]): string {
  if (!columns || columns.length === 0) return ''

  const widths = columns.map((col, i) => {
    const vals = rows.map(row => String(row[i] ?? '').length)
    return Math.max(col.length, ...vals, 4)
  })

  const header = columns.map((col, i) => col.padEnd(widths[i]!)).join(' | ')
  const separator = widths.map(w => '-'.repeat(w)).join('-+-')
  const body = rows
    .map(row =>
      row.map((val, i) => String(val ?? '').padEnd(widths[i]!)).join(' | '),
    )
    .join('\n')

  return `\n${header}\n${separator}\n${body}`
}
