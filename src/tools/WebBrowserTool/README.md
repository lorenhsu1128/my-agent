# WebBrowserTool

Drives a real browser (headless Chromium via puppeteer-core) so the agent
can do things WebFetch / WebCrawl can't: logging in, clicking through
dynamic UIs, filling forms, waiting for JS-rendered content, taking
screenshots.

## Quick reference

All calls take `action` as the discriminator, plus the action-specific
fields below.

| Action | Fields | Description |
|--------|--------|-------------|
| `navigate` | `url` | Go to a URL. SSRF / blocklist / secret-exfil checked client-side. |
| `snapshot` | — | Aria accessibility tree with `[ref=eN]` markers. Refs invalidate on any navigation. |
| `click` | `ref` | Click element identified by `@eN` from the latest snapshot. |
| `type` | `ref`, `text` | Focus, clear, and type into an input. |
| `scroll` | `direction: 'up' \| 'down'` | Scroll ~500px. |
| `back` | — | Browser back button. |
| `press` | `key` | Keyboard key (`Enter`, `Tab`, `Escape`…). |
| `console` | `clear?` | Read accumulated `console.*` messages from the page. |
| `evaluate` | `expression` | Run JS in the page context. **Requires explicit allow rule** in `.claude/settings.json`. |
| `screenshot` | `full_page?` | PNG bytes (returned as base64). |
| `vision` | `question` | Screenshot + ask a vision model about it. |
| `get_images` | — | Enumerate `<img>` elements with `src`/`alt`/dimensions. |
| `close` | — | Tear down the session immediately. |

## Session model

- **Persistent**: one Page + Provider is reused across tool calls, so
  cookies and auth survive multi-step flows (login → navigate → click).
- **Idle timeout**: 5 minutes of inactivity triggers auto-close.
- **Process-exit hook**: SIGINT / SIGTERM / normal exit tears down cleanly.
- **Ref invalidation**: every mainFrame navigation bumps a generation
  counter. Stale refs throw `StaleRefError`; call `snapshot` again.

## Backends

Selected at runtime — no feature flags. Priority:

1. `BROWSER_PROVIDER=local|browserbase|browser-use` — explicit override.
2. Auto-detect:
   - `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` → Browserbase cloud
   - `BROWSER_USE_API_KEY` → Browser Use cloud
3. Fallback: local headless Chromium (requires one-time `bunx playwright install chromium` — we reuse that binary).

### Environment variables

| Var | Purpose |
|-----|---------|
| `BROWSER_PROVIDER` | Force a specific backend |
| `BROWSERBASE_API_KEY` | Browserbase auth |
| `BROWSERBASE_PROJECT_ID` | Browserbase project scope |
| `BROWSERBASE_ADVANCED_STEALTH` | `1` to enable Scale-plan stealth |
| `BROWSER_USE_API_KEY` | Browser Use auth |
| `BROWSER_USE_API_BASE` | Override default `https://api.browser-use.com` |
| `ANTHROPIC_API_KEY` | Vision action backend (falls back to clear error if unset) |
| `MY_AGENT_VISION_MODEL` | Override default vision model |

## Security

Applied uniformly regardless of provider:

- **URL protocol check**: only `http(s)`.
- **Secret exfiltration**: URLs containing things that look like API keys
  / tokens (including percent-encoded form) are rejected before navigate.
- **SSRF**: DNS-level block of private / link-local / CGNAT / cloud
  metadata addresses before navigate.
- **Website blocklist**: `~/.my-agent/website-blocklist.yaml` with
  fnmatch wildcards and 30 s cache.
- **Secret redaction**: every text return (snapshot tree, console logs,
  evaluate result, vision description) passes through `redactSecrets`.
- **`evaluate` gating**: arbitrary JS execution requires an explicit
  allow rule — defaults to ask every time.
- **Vision prompt injection defence**: the vision prompt tells the model
  to ignore instructions that appear inside the screenshot itself.

## WebCrawl interop

`WebCrawlTool` (this tool's stateless sibling) also supports Firecrawl
as an alternate fetcher. Set `WEBCRAWL_BACKEND=firecrawl` + `FIRECRAWL_API_KEY`
to route each BFS node through Firecrawl (JS rendering, anti-bot). The
local axios+cheerio path remains the default.

## Known limits

- **Provider capability gaps**: cloud providers may not support all
  actions. Each provider implements `supports(cap)`; unsupported calls
  return a clear error pointing the caller to a different backend.
- **Ref-based actions need a fresh snapshot**: after any page state
  change, call `snapshot` again before `click` / `type`. Stale refs
  throw `StaleRefError`.
- **Vision needs `ANTHROPIC_API_KEY`**: local llama.cpp models don't
  currently have a vision path.
