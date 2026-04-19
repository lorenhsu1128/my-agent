export const WEB_CRAWL_TOOL_NAME = 'WebCrawl'

export const DESCRIPTION = `Crawl a website starting from a URL, following links breadth-first up to \`max_depth\` levels or \`max_pages\` pages, whichever comes first.

Returns extracted text content from every page visited (title, URL, cleaned body text). Respects robots.txt. Stays within the same origin by default.

Use WebCrawl when:
- You need content from multiple related pages (a docs site, a blog archive, a listing page + its item pages)
- A single WebFetch call is not enough because links must be followed

Use WebFetch instead when a single URL's content is sufficient.

Parameters:
- \`url\` (required): Starting URL
- \`max_depth\` (default 2): How many link hops from the start
- \`max_pages\` (default 10): Hard cap on pages fetched
- \`same_origin\` (default true): If true, only follow links on the same origin as the start URL
- \`instructions\` (optional): Guidance forwarded in results so downstream summarisation can focus

Outputs may be automatically redacted if secrets (API keys, tokens) are detected on a page.`
