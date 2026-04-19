import React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { runExtraUsage } from './extra-usage-core.js';

// /login removed in m-deanthro stage 3-c. Formerly /extra-usage fell through
// to the OAuth Login flow on error; now the command just surfaces whatever
// message runExtraUsage returns.
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode | null> {
  const result = await runExtraUsage();
  if (result.type === 'message') {
    onDone(result.value);
  } else {
    onDone(
      'Extra-usage requires re-authentication. Set ANTHROPIC_API_KEY (or your provider equivalent) and retry.',
    );
  }
  return null;
}
