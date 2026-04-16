// Lazy-loaded content for the webapp-testing bundled skill.
// Contains the TypeScript rewrite of with_server.py and Playwright examples.

/**
 * TypeScript rewrite of with_server.py — process orchestration for
 * starting servers, waiting for port readiness, running a client command,
 * and cleaning up. Uses only Node built-ins (child_process, net).
 *
 * Usage:
 *   bun scripts/with-server.ts --server "npm run dev" --port 5173 -- bun test.ts
 *   bun scripts/with-server.ts \
 *     --server "cd backend && python server.py" --port 3000 \
 *     --server "cd frontend && npm run dev" --port 5173 \
 *     -- bun test.ts
 */
export const WITH_SERVER_SCRIPT = `#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'child_process'
import { createConnection } from 'net'

interface ServerConfig {
  cmd: string
  port: number
}

function parseArgs(argv: string[]): { servers: ServerConfig[]; timeout: number; command: string[] } {
  const servers: ServerConfig[] = []
  let timeout = 30
  const cmds: string[] = []
  const ports: number[] = []
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === '--server' && i + 1 < argv.length) {
      cmds.push(argv[++i]!)
    } else if (arg === '--port' && i + 1 < argv.length) {
      ports.push(parseInt(argv[++i]!, 10))
    } else if (arg === '--timeout' && i + 1 < argv.length) {
      timeout = parseInt(argv[++i]!, 10)
    } else if (arg === '--') {
      // Everything after -- is the client command
      return {
        servers: cmds.map((cmd, j) => ({ cmd, port: ports[j]! })),
        timeout,
        command: argv.slice(i + 1),
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log(\\\`Usage: bun scripts/with-server.ts [options] -- <command>

Options:
  --server <cmd>    Server command to start (repeatable)
  --port <number>   Port for each server (must match --server count)
  --timeout <sec>   Timeout per server (default: 30)
  --help            Show this help

Examples:
  bun scripts/with-server.ts --server "npm run dev" --port 5173 -- bun test.ts
  bun scripts/with-server.ts \\\\
    --server "cd backend && python server.py" --port 3000 \\\\
    --server "cd frontend && npm run dev" --port 5173 \\\\
    -- bun automation.ts\\\`)
      process.exit(0)
    }
    i++
  }
  // No -- separator found; treat remaining as command
  return {
    servers: cmds.map((cmd, j) => ({ cmd, port: ports[j]! })),
    timeout,
    command: [],
  }
}

function waitForPort(port: number, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000
  return new Promise((resolve) => {
    function attempt() {
      if (Date.now() > deadline) return resolve(false)
      const sock = createConnection({ host: 'localhost', port })
      sock.on('connect', () => { sock.destroy(); resolve(true) })
      sock.on('error', () => { sock.destroy(); setTimeout(attempt, 500) })
    }
    attempt()
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.servers.length === 0) {
    console.error('Error: No --server specified')
    process.exit(1)
  }
  if (args.command.length === 0) {
    console.error('Error: No command specified (use -- to separate)')
    process.exit(1)
  }
  if (args.servers.some((s) => isNaN(s.port))) {
    console.error('Error: Number of --server and --port must match')
    process.exit(1)
  }

  const procs: ChildProcess[] = []

  try {
    // Start all servers
    for (let i = 0; i < args.servers.length; i++) {
      const { cmd, port } = args.servers[i]!
      console.log(\\\`Starting server \\\${i + 1}/\\\${args.servers.length}: \\\${cmd}\\\`)
      const proc = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      procs.push(proc)

      console.log(\\\`Waiting for port \\\${port}...\\\`)
      const ready = await waitForPort(port, args.timeout)
      if (!ready) {
        throw new Error(\\\`Server failed to start on port \\\${port} within \\\${args.timeout}s\\\`)
      }
      console.log(\\\`Server ready on port \\\${port}\\\`)
    }

    console.log(\\\`\\\\nAll \\\${args.servers.length} server(s) ready\\\`)
    console.log(\\\`Running: \\\${args.command.join(' ')}\\\\n\\\`)

    // Run client command
    const result = spawn(args.command[0]!, args.command.slice(1), {
      stdio: 'inherit',
      shell: true,
    })
    const code = await new Promise<number>((resolve) => {
      result.on('close', (c) => resolve(c ?? 1))
    })
    process.exitCode = code
  } finally {
    // Clean up
    console.log(\\\`\\\\nStopping \\\${procs.length} server(s)...\\\`)
    for (let i = 0; i < procs.length; i++) {
      const proc = procs[i]!
      proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 5000)
        proc.on('close', () => { clearTimeout(timer); resolve() })
      })
      console.log(\\\`Server \\\${i + 1} stopped\\\`)
    }
    console.log('All servers stopped')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
`

export const EXAMPLE_CONSOLE_LOGGING = `from playwright.sync_api import sync_playwright

# Example: Capturing console logs during browser automation

url = 'http://localhost:5173'  # Replace with your URL
console_logs = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})

    def handle_console_message(msg):
        console_logs.append(f"[{msg.type}] {msg.text}")
        print(f"Console: [{msg.type}] {msg.text}")

    page.on("console", handle_console_message)
    page.goto(url)
    page.wait_for_load_state('networkidle')

    page.click('text=Dashboard')
    page.wait_for_timeout(1000)

    browser.close()

print(f"Captured {len(console_logs)} console messages")
`

export const EXAMPLE_ELEMENT_DISCOVERY = `from playwright.sync_api import sync_playwright

# Example: Discovering buttons and other elements on a page

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto('http://localhost:5173')
    page.wait_for_load_state('networkidle')

    buttons = page.locator('button').all()
    print(f"Found {len(buttons)} buttons:")
    for i, button in enumerate(buttons):
        text = button.inner_text() if button.is_visible() else "[hidden]"
        print(f"  [{i}] {text}")

    links = page.locator('a[href]').all()
    print(f"Found {len(links)} links:")
    for link in links[:5]:
        text = link.inner_text().strip()
        href = link.get_attribute('href')
        print(f"  - {text} -> {href}")

    inputs = page.locator('input, textarea, select').all()
    print(f"Found {len(inputs)} input fields:")
    for input_elem in inputs:
        name = input_elem.get_attribute('name') or input_elem.get_attribute('id') or "[unnamed]"
        input_type = input_elem.get_attribute('type') or 'text'
        print(f"  - {name} ({input_type})")

    page.screenshot(path='/tmp/page_discovery.png', full_page=True)
    print("Screenshot saved to /tmp/page_discovery.png")
    browser.close()
`

export const EXAMPLE_STATIC_HTML = `from playwright.sync_api import sync_playwright
import os

# Example: Automating interaction with static HTML files using file:// URLs

html_file_path = os.path.abspath('path/to/your/file.html')
file_url = f'file://{html_file_path}'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1920, 'height': 1080})

    page.goto(file_url)
    page.screenshot(path='/tmp/static_page.png', full_page=True)

    page.click('text=Click Me')
    page.fill('#name', 'John Doe')
    page.fill('#email', 'john@example.com')
    page.click('button[type="submit"]')
    page.wait_for_timeout(500)

    page.screenshot(path='/tmp/after_submit.png', full_page=True)
    browser.close()

print("Static HTML automation completed!")
`
