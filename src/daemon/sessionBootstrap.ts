/**
 * M-DAEMON-4a：Daemon session bootstrap。
 *
 * `ask()`（src/QueryEngine.ts）需要一整組 ambient：tools、commands、
 * mcpClients、agents、AppState、readFileCache、canUseTool…。
 * 原本這些由 main.tsx 的 headless 分支 + print.ts 串出來（約 ~2000 行跨檔），
 * 跟 stdin/stdout streaming 糾纏。
 *
 * 本模組抽出能在 daemon 程序內獨立 bootstrap 出同等 context 的函式：
 *   - `bootstrapDaemonContext(opts)` 回一個 `DaemonSessionContext`
 *   - Daemon 每個 WS session lifetime 共享一個 context；turn 時 broker
 *     用 context 組 `ask()` 的參數、執行、串流結果
 *
 * 本 commit（M-DAEMON-4a）覆蓋：
 *   - tools：透過 `getTools` + 動態 MCP tools 合流（buildTools() 每 turn 呼叫）
 *   - commands：`getCommands(cwd)` 並套 headless 過濾規則（prompt + supportsNonInteractive）
 *   - MCP clients：`getMcpToolsCommandsAndResources` 連線並寫入 AppState.mcp
 *   - agents：先空陣列（agents 定義載入 M-DAEMON-4b 時補，走 refreshActivePlugins
 *     或 parseAgentsFromJson 視是否要支援 SDK --agents 而定）
 *   - AppState：`getDefaultAppState()` + `toolPermissionContext` + `mcp.*`
 *   - readFileCache：FileStateCache instance
 *
 * 不覆蓋（後續子任務）：
 *   - plugin hot reload / skillChangeDetector（M-DAEMON-4b/c 增量）
 *   - bridge handle / proactive tick / idle timeout（M-DAEMON-7+）
 *   - --continue / --resume session materialize（M-DAEMON-8 整合測試階段）
 */
import type { Command } from '../types/command.js'
import type { AppState } from '../state/AppStateStore.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { ToolPermissionContext } from '../Tool.js'
import type { Tools } from '../Tool.js'
import type { PermissionMode } from '../types/permissions.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import { createStore } from '../state/store.js'
import { getTools, assembleToolPool } from '../tools.js'
import { mergeAndFilterTools } from '../utils/toolPool.js'
import { getCommands } from '../commands.js'
import { initializeToolPermissionContext } from '../utils/permissions/permissionSetup.js'
import { getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
import { settingsChangeDetector } from '../utils/settings/changeDetector.js'
import { applySettingsChange } from '../utils/settings/applySettingsChange.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  type FileStateCache,
} from '../utils/fileStateCache.js'
import uniqBy from 'lodash-es/uniqBy.js'

export interface DaemonBootstrapOptions {
  cwd: string
  permissionMode?: PermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
  baseTools?: string[]
  addDirs?: string[]
  allowDangerouslySkipPermissions?: boolean
  /** M-DAEMON 階段；若 true 跳過 MCP 連線（單元測試用）。 */
  skipMcp?: boolean
}

export interface DaemonSessionContext {
  readonly cwd: string
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  /** Headless 過濾後（prompt + local supportsNonInteractive）的 command 集合。 */
  readonly commands: Command[]
  /** MCP 連線（已完成連線）。 */
  readonly mcpClients: MCPServerConnection[]
  /** Agent 定義（M-DAEMON-4a 先空陣列）。 */
  readonly agents: AgentDefinition[]
  getReadFileCache(): FileStateCache
  setReadFileCache(cache: FileStateCache): void
  /**
   * 組 `ask()` 當下所需的 Tools：靜態 tools + AppState.mcp.tools。
   * 每個 turn 呼叫（因為 MCP tools 可能 mid-session 變動）。
   */
  buildTools(): Tools
  /** 關閉 daemon 時呼叫（目前無 resource；預留 MCP disconnect 入口）。 */
  dispose(): Promise<void>
}

export async function bootstrapDaemonContext(
  opts: DaemonBootstrapOptions,
): Promise<DaemonSessionContext> {
  const mode: PermissionMode = opts.permissionMode ?? 'default'
  const { toolPermissionContext } = await initializeToolPermissionContext({
    allowedToolsCli: opts.allowedTools ?? [],
    disallowedToolsCli: opts.disallowedTools ?? [],
    baseToolsCli: opts.baseTools,
    permissionMode: mode,
    allowDangerouslySkipPermissions:
      opts.allowDangerouslySkipPermissions ?? false,
    addDirs: opts.addDirs ?? [],
  })

  const defaultState = getDefaultAppState()
  const initial: AppState = {
    ...defaultState,
    toolPermissionContext,
    mcp: {
      ...defaultState.mcp,
      clients: [],
      tools: [],
      commands: [],
    },
  }
  const store = createStore(initial, onChangeAppState)
  const getAppState = (): AppState => store.getState()
  const setAppState = (f: (prev: AppState) => AppState): void =>
    store.setState(f)

  // Commands（headless-safe 過濾）。
  const allCommands = await getCommands(opts.cwd)
  const commands = allCommands.filter(
    c =>
      (c.type === 'prompt' && !c.disableNonInteractive) ||
      (c.type === 'local' && c.supportsNonInteractive),
  )

  // MCP 連線：除非 `skipMcp`，否則逐一 push 進 AppState。
  if (!opts.skipMcp) {
    await getMcpToolsCommandsAndResources(({ client, tools, commands }) => {
      setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: prev.mcp.clients.some(c => c.name === client.name)
            ? prev.mcp.clients.map(c => (c.name === client.name ? client : c))
            : [...prev.mcp.clients, client],
          tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
          commands: uniqBy([...prev.mcp.commands, ...commands], 'name'),
        },
      }))
    })
  }

  // M-DAEMON-PERMS-A：訂閱 settings 變化，persistent permission 規則
  // （user settings / project settings 的 alwaysAllow/alwaysDeny/additionalDirs
  // 等）變動時即時套進 daemon 的 AppState。沒這段 daemon 會凍結在啟動當下
  // 的 settings snapshot，TUI 新增「Always allow Bash(git:*)」後 daemon 仍
  // 會反覆詢問。
  const settingsUnsub = settingsChangeDetector.subscribe(source => {
    applySettingsChange(source, setAppState)
  })

  // ReadFileCache（per-session instance，turn 間持久）。
  let readFileCache = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )
  const getReadFileCache = (): FileStateCache => readFileCache
  const setReadFileCache = (c: FileStateCache): void => {
    readFileCache = c
  }

  // buildTools 每 turn 呼叫；動態 MCP tools via AppState。
  const buildTools = (): Tools => {
    const state = getAppState()
    const baseTools = getTools(state.toolPermissionContext)
    const assembled = assembleToolPool(
      state.toolPermissionContext,
      state.mcp.tools,
    )
    return uniqBy(
      mergeAndFilterTools(
        [...baseTools, ...state.mcp.tools],
        assembled,
        state.toolPermissionContext.mode,
      ),
      'name',
    )
  }

  // Dispose：unsub settings watcher；MCP client close 由 process 結束自然清掉。
  const dispose = async (): Promise<void> => {
    try {
      settingsUnsub?.()
    } catch {
      // ignore
    }
  }

  return {
    cwd: opts.cwd,
    getAppState,
    setAppState,
    commands,
    get mcpClients() {
      return getAppState().mcp.clients as MCPServerConnection[]
    },
    agents: [],
    getReadFileCache,
    setReadFileCache,
    buildTools,
    dispose,
  }
}
