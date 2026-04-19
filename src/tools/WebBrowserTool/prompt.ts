export const WEB_BROWSER_TOOL_NAME = 'WebBrowser'

export const DESCRIPTION = `Drive a real browser (headless Chromium). Use for interactive workflows that WebFetch / WebCrawl cannot do: logging in, clicking through dynamic UIs, filling forms, waiting for JS-rendered content.

Sessions persist across calls — cookies, auth, and current URL survive between tool uses. An idle timer closes the browser after 5 minutes of inactivity. You can also end a session explicitly with action="close".

Workflow:
  1. action="navigate", url=<start URL>
  2. action="snapshot"  →  returns an accessibility tree with "@eN" refs
  3. action="click" / "type" / "scroll"  →  use refs from the latest snapshot
  4. action="snapshot" again whenever the page changes (new refs)
  5. action="close" when done

Refs (e.g. @e5) are invalidated when the page navigates. Always re-snapshot after any action that might change the DOM.

Actions:
- navigate(url)                  Go to URL
- snapshot()                     Accessibility tree + ref map
- click(ref)                     Click @eN
- type(ref, text)                Fill an input
- scroll(direction)              "up" or "down", ~500px
- back()                         Browser back button
- press(key)                     e.g. "Enter", "Tab", "Escape"
- console(clear?)                Read page console logs
- evaluate(expression)           Run JS in page context (requires allow rule)
- close()                        Tear down the session

Security: URLs embedding API keys are blocked; website blocklist is honored; private/internal addresses (SSRF) are refused; results are scanned and any detected secrets redacted before returning.`
