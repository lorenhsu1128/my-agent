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

  1. action="navigate", url=<start URL>  (optionally pass wait_for to wait for key global or selector)
  2. action="snapshot"  →  returns an accessibility tree with "@eN" refs plus a summary
  3. action="click" / "type" / "scroll"  →  use refs from the latest snapshot
  4. action="snapshot" again whenever the page changes (new refs)
  5. action="close" when done (optional — idle timeout is 5 minutes)

Sessions persist across calls — cookies, auth, and current URL survive.
Refs (e.g. @e5) are invalidated when the page navigates. Always re-snapshot after any action that might change the DOM.

Every mutating action returns a \`settle\` field reporting whether the page reached network-idle / DOM-quiet within ~2s. If settle.waited is false, the page is still actively loading — re-snapshot after another short wait or add an explicit wait_for on the next call.

## Actions

- navigate(url, wait_for?)               Go to URL
- snapshot()                             Accessibility tree + ref map + summary{interactive_count, form_count, has_dialog, has_shadow}
- click(ref, wait_for?)                  Click @eN
- type(ref, text, wait_for?)             Fill an input
- scroll(direction, wait_for?)           "up" or "down", ~500px
- back(wait_for?)                        Browser back button
- press(key, wait_for?)                  e.g. "Enter", "Tab", "Escape"
- console(clear?)                        Read page console logs
- evaluate(expression)                   Run JS in page context (requires allow rule)
- screenshot(full_page?)                 Capture page as PNG (returns base64)
- vision(question, return_coordinates?)  Screenshot + ask a vision model; when return_coordinates=true the model returns {targets:[{label,x,y,confidence}]} in viewport pixels, ready to feed click_at
- get_images()                           List <img> elements on the page
- click_at(x, y, button?, click_count?, wait_for?)    Mouse click at viewport coordinates (no ref needed) — use for canvas, maps, and vision-located targets
- mouse_move(x, y)                       Move cursor (triggers hover menus / tooltips)
- mouse_drag(from_x, from_y, to_x, to_y, steps?, wait_for?)  Press, move in N steps, release (pan maps, sliders, custom drag UX)
- wheel(x, y, delta_x, delta_y, wait_for?)           Wheel event at point (canvas zoom, trackpad-style scroll inside a widget)
- close()                                Tear down the session

## wait_for (any mutating action)

Pass an optional wait_for object to make the action block until a specific condition is met (applied AFTER the implicit 2s settle). Shape:

  { selector?: "<CSS>", state?: "visible"|"hidden"|"attached",
    function?: "<JS expression>",
    url_matches?: "<regex>",
    timeout_ms?: <number, default 10000> }

Examples:
  { selector: "[role='dialog']" }                  — wait for a modal
  { function: "() => !!window.google?.maps" }      — wait for Maps JS API
  { url_matches: "^https://github\\\\.com/.+/issues" } — wait for SPA route change

## Handling JavaScript-heavy sites (Google Maps, Gmail, Notion, ...)

Playbook, in order:

1. **Snapshot first**. Even SPAs usually expose toolbars, search boxes, and list items with ARIA roles — the snapshot's summary{} tells you if anything interactive came back.

2. **If snapshot missed the target**: the element may be inside a canvas, a custom web component, or rendered later. Do NOT retry snapshot blindly — pick one of:
   - \`screenshot\` → \`vision(return_coordinates=true, question="where is the zoom-in button?")\` → \`click_at(x, y)\` for elements rendered into canvas/WebGL
   - \`wait_for: { function: "<condition>" }\` on the next mutating action, to give the page time to render
   - Keyboard navigation: \`press("Tab")\` until focused, then \`press("Enter")\`

3. **Prefer site JS APIs over UI clicks** when available. Many complex sites expose global objects that let you bypass the UI entirely. **Always discover first, do not guess globals** — what a site exposes varies between pages and versions:
   \`\`\`
   evaluate("JSON.stringify(Object.keys(window).filter(k => !k.startsWith('_') && typeof window[k]==='object' && window[k]!==null).slice(0,40))")
   \`\`\`
   Then inspect promising keys (e.g. \`APP_OPTIONS\`, \`APP_INITIALIZATION_STATE\`, \`__NEXT_DATA__\`, \`__APP_STATE__\`, \`WIZ_global_data\`, \`pageProps\`). These often contain routing state, IDs, and initial data that let you skip entire UI flows.
   - **google.com/maps** specifically: no \`window.google.maps\` on the maps.google.com page itself (that global exists only on third-party sites embedding the Maps JS API). Inspect \`window.APP_INITIALIZATION_STATE\` instead.
   - **Gmail / Workspace**: message IDs live in DOM \`data-message-id\` / \`data-legacy-thread-id\` attributes.
   - **Next.js / Nuxt**: \`window.__NEXT_DATA__\` / \`window.__NUXT__\` has the full initial prop tree.
   - Note: some SPAs re-initialise globals during navigation — if a value disappears, re-snapshot or re-evaluate rather than caching.

4. **Cookie / consent overlays**. The first snapshot after navigate often shows \`has_dialog: true\`. Dismiss the dialog BEFORE attempting the real task — its z-index will intercept your clicks.

5. **Virtual ARIA nodes**. If click/type returns VirtualNodeError, the tool already tried CSS and bounding-box fallbacks. Next best is:
   - \`screenshot\` + \`vision(return_coordinates=true)\` + \`click_at\`
   - OR \`evaluate\` with a precise selector

6. **Canvas-only interactions** (dragging a map, drawing on a whiteboard):
   - Pan: \`mouse_drag(from_x, from_y, to_x, to_y)\` — drag direction is opposite to desired view movement
   - Zoom: \`wheel(x, y, delta_x=0, delta_y=-100)\` to zoom in at (x,y)
   - Keyboard: many canvas apps accept \`+\` / \`-\` / arrow keys via \`press\`

## Coordinate system

All (x, y) coordinates are **CSS pixels relative to the viewport top-left** (default viewport 1280×800). This matches \`vision(return_coordinates=true)\` output and \`page.mouse.*\` input. For full_page screenshots, the image height exceeds the viewport — scroll first if you want to click something below the fold, because click_at operates on the current viewport only.

## Fallbacks when a ref resolves to a virtual ARIA node (SPAs sometimes do this)

If click/type returns a "VirtualNodeError", the tool already tried ARIA + CSS + bounding-box fallbacks. Next step: use \`screenshot\` + \`vision(return_coordinates=true)\` + \`click_at\`, or \`evaluate\` with a more specific selector, or keyboard navigation (\`press\`).

## Security

URLs embedding API keys are blocked; website blocklist is honored; private/internal addresses (SSRF) are refused; results are scanned and any detected secrets redacted before returning.`
