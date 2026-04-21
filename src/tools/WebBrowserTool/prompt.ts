export const WEB_BROWSER_TOOL_NAME = 'WebBrowser'

export const DESCRIPTION = `Drive a real headless Chromium browser. THIS IS THE CORRECT TOOL for fetching or interacting with any modern website that relies on JavaScript rendering.

## When you MUST use WebBrowser (not Bash curl / not WebFetch)

If the target is any of the following, WebBrowser is the ONLY tool that works:
- Google Maps, Gmail, Google Docs, YouTube, any Google product beyond static pages
- Twitter / X, Facebook, Instagram, LinkedIn, Reddit
- Any Single-Page Application (React / Vue / Angular / Next.js / Svelte)
- Any site where the visible content is loaded AFTER the initial HTML (the curl output will be a near-empty skeleton)
- Any flow requiring login, clicking, typing into forms, waiting for async content, or reading dynamic state

Do NOT use \`Bash\` with \`curl\` / \`wget\` for any of the above. curl cannot execute JavaScript; on these sites it returns a stub HTML that contains no useful data. Retrying curl with different URLs will keep failing. If the user asks to "check traffic on Google Maps", "look up something on Twitter", "read a tweet", "search on a modern site", etc. — go straight to WebBrowser.

Use \`WebFetch\` (not this tool) ONLY for static documentation pages, API docs, RFC text, plain-text README mirrors, and similar pages where the meaningful content is already in the initial HTML.

## Workflow

  1. action="navigate", url=<start URL>
  2. action="snapshot"  →  returns an accessibility tree with "@eN" refs
  3. action="click" / "type" / "scroll"  →  use refs from the latest snapshot
  4. action="snapshot" again whenever the page changes (new refs)
  5. action="close" when done (optional — idle timeout is 5 minutes)

Sessions persist across calls — cookies, auth, and current URL survive.
Refs (e.g. @e5) are invalidated when the page navigates. Always re-snapshot after any action that might change the DOM.

## Actions

- navigate(url)                  Go to URL
- snapshot()                     Accessibility tree + ref map
- click(ref)                     Click @eN
- type(ref, text)                Fill an input
- scroll(direction)              "up" or "down", ~500px
- back()                         Browser back button
- press(key)                     e.g. "Enter", "Tab", "Escape"
- console(clear?)                Read page console logs
- evaluate(expression)           Run JS in page context (requires allow rule)
- screenshot(full_page?)         Capture page as PNG (returns base64)
- vision(question)               Screenshot + ask a vision model about it
- get_images()                   List <img> elements on the page
- close()                        Tear down the session

## Fallbacks when a ref resolves to a virtual ARIA node (SPAs sometimes do this)

If click/type returns a "VirtualNodeError", the tool already tried CSS fallbacks internally. Next step: call \`evaluate\` with JS that finds the element by a more specific selector and clicks it, OR use keyboard navigation (\`press\` Tab / Enter) to reach it.

## Security

URLs embedding API keys are blocked; website blocklist is honored; private/internal addresses (SSRF) are refused; results are scanned and any detected secrets redacted before returning.`
