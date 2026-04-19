import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { openBrowser } from '../../utils/browser.js';
import { logError } from '../../utils/log.js';

// /login command removed in m-deanthro stage 3-c. The /upgrade command used
// to launch the Anthropic OAuth login flow after opening the upgrade page;
// now it just opens the page and advises the user to re-authenticate via
// their provider's own mechanism.
export async function call(
  _onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode | null> {
  try {
    const url = 'https://claude.ai/upgrade/max';
    await openBrowser(url);
    setTimeout(
      _onDone,
      0,
      `Opened ${url}. After upgrading, re-authenticate via your provider (e.g. set ANTHROPIC_API_KEY).`,
    );
  } catch (error) {
    logError(error as Error);
    setTimeout(
      _onDone,
      0,
      `Failed to open browser. Please visit https://claude.ai/upgrade/max to upgrade.`,
    );
  }
  return null;
}
