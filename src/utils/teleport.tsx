// my-agent: M-DECOUPLE-2 Phase 2B — teleport 本地化
//
// 雲端 teleport（claude.ai Sessions API）整段移除：fetchSession 結果不再消費、
// pollRemoteSessionEvents / archiveRemoteSession / teleportToRemote /
// teleportFromSessionsAPI / teleportResumeCodeSession 全部 stub 化。
//
// 保留：
//   - 類型 export（TeleportResult / TeleportProgressStep / RepoValidationResult / PollRemoteSessionResponse）
//   - 純本地 git 操作 helper：validateGitState / checkOutTeleportedSessionBranch /
//     processMessagesForTeleportResume / validateSessionRepository（讀 SessionResource type）
//   - 函式 signature 不變，讓 caller typecheck 不破
//
// teleport/api.ts / environments.ts / environmentSelection.ts / gitBundle.ts 維持原狀
// （types / 共用 oauth header / 本地 git bundle 邏輯仍被其他 caller 引用）。

import chalk from 'chalk';
import { getOriginalCwd } from 'src/bootstrap/state.js';
import { TeleportError, type TeleportLocalErrorType } from '../components/TeleportError.js';
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js';
import type { Root } from '../ink.js';
import type { Message, SystemMessage } from '../types/message.js';
import type { PermissionMode } from '../types/permissions.js';
import { deserializeMessages, type TeleportRemoteResponse } from './conversationRecovery.js';
import { logForDebugging } from './debug.js';
import { detectCurrentRepositoryWithHost, parseGitHubRepository, parseGitRemote } from './detectRepository.js';
import { TeleportOperationError, toError } from './errors.js';
import { execFileNoThrow } from './execFileNoThrow.js';
import { getIsClean, gitExe } from './git.js';
import { logError } from './log.js';
import { createSystemMessage, createUserMessage } from './messages.js';
import { type GitSource, type SessionResource } from './teleport/api.js';

// Avoid unused-import warnings while preserving the parts of the surface area
// that callers depend on. (TeleportError is a React component still rendered
// by handleTeleportPrerequisites stub if a caller invokes it.)
void TeleportError;

export type TeleportResult = {
  messages: Message[];
  branchName: string;
};
export type TeleportProgressStep = 'validating' | 'fetching_logs' | 'fetching_branch' | 'checking_out' | 'done';
export type TeleportProgressCallback = (step: TeleportProgressStep) => void;

type TeleportToRemoteResponse = {
  id: string;
  title: string;
};

const CLOUD_DISABLED_MSG =
  'Cloud teleport (claude.ai Sessions API) has been removed in my-agent. Use local sessions only.';

function createTeleportResumeSystemMessage(branchError: Error | null): SystemMessage {
  if (branchError === null) {
    return createSystemMessage('Session resumed', 'suggestion');
  }
  const formattedError =
    branchError instanceof TeleportOperationError
      ? branchError.formattedMessage
      : branchError.message;
  return createSystemMessage(`Session resumed without branch: ${formattedError}`, 'warning');
}

function createTeleportResumeUserMessage() {
  return createUserMessage({
    content: `This session is being continued from another machine. Application state may have changed. The updated working directory is ${getOriginalCwd()}`,
    isMeta: true,
  });
}

/**
 * Validates that the git working directory is clean (ignoring untracked files).
 * Local-only — kept for callers that pre-flight before any teleport-style flow.
 */
export async function validateGitState(): Promise<void> {
  const isClean = await getIsClean({ ignoreUntracked: true });
  if (!isClean) {
    throw new TeleportOperationError(
      'Git working directory is not clean. Please commit or stash your changes before using --teleport.',
      chalk.red(
        'Error: Git working directory is not clean. Please commit or stash your changes before using --teleport.\n',
      ),
    );
  }
}

async function fetchFromOrigin(branch?: string): Promise<void> {
  const fetchArgs = branch ? ['fetch', 'origin', `${branch}:${branch}`] : ['fetch', 'origin'];
  const { code: fetchCode, stderr: fetchStderr } = await execFileNoThrow(gitExe(), fetchArgs);
  if (fetchCode !== 0) {
    if (branch && fetchStderr.includes('refspec')) {
      logForDebugging(`Specific branch fetch failed, trying to fetch ref: ${branch}`);
      const { code: refFetchCode, stderr: refFetchStderr } = await execFileNoThrow(gitExe(), [
        'fetch',
        'origin',
        branch,
      ]);
      if (refFetchCode !== 0) {
        logError(new Error(`Failed to fetch from remote origin: ${refFetchStderr}`));
      }
    } else {
      logError(new Error(`Failed to fetch from remote origin: ${fetchStderr}`));
    }
  }
}

async function ensureUpstreamIsSet(branchName: string): Promise<void> {
  const { code: upstreamCheckCode } = await execFileNoThrow(gitExe(), [
    'rev-parse',
    '--abbrev-ref',
    `${branchName}@{upstream}`,
  ]);
  if (upstreamCheckCode === 0) {
    logForDebugging(`Branch '${branchName}' already has upstream set`);
    return;
  }
  const { code: remoteCheckCode } = await execFileNoThrow(gitExe(), [
    'rev-parse',
    '--verify',
    `origin/${branchName}`,
  ]);
  if (remoteCheckCode === 0) {
    logForDebugging(`Setting upstream for '${branchName}' to 'origin/${branchName}'`);
    const { code: setUpstreamCode, stderr: setUpstreamStderr } = await execFileNoThrow(gitExe(), [
      'branch',
      '--set-upstream-to',
      `origin/${branchName}`,
      branchName,
    ]);
    if (setUpstreamCode !== 0) {
      logForDebugging(`Failed to set upstream for '${branchName}': ${setUpstreamStderr}`);
    } else {
      logForDebugging(`Successfully set upstream for '${branchName}'`);
    }
  } else {
    logForDebugging(`Remote branch 'origin/${branchName}' does not exist, skipping upstream setup`);
  }
}

async function checkoutBranch(branchName: string): Promise<void> {
  let { code: checkoutCode, stderr: checkoutStderr } = await execFileNoThrow(gitExe(), [
    'checkout',
    branchName,
  ]);
  if (checkoutCode !== 0) {
    logForDebugging(`Local checkout failed, trying to checkout from origin: ${checkoutStderr}`);
    const result = await execFileNoThrow(gitExe(), [
      'checkout',
      '-b',
      branchName,
      '--track',
      `origin/${branchName}`,
    ]);
    checkoutCode = result.code;
    checkoutStderr = result.stderr;
    if (checkoutCode !== 0) {
      logForDebugging(`Remote checkout with -b failed, trying without -b: ${checkoutStderr}`);
      const finalResult = await execFileNoThrow(gitExe(), [
        'checkout',
        '--track',
        `origin/${branchName}`,
      ]);
      checkoutCode = finalResult.code;
      checkoutStderr = finalResult.stderr;
    }
  }
  if (checkoutCode !== 0) {
    throw new TeleportOperationError(
      `Failed to checkout branch '${branchName}': ${checkoutStderr}`,
      chalk.red(`Failed to checkout branch '${branchName}'\n`),
    );
  }
  await ensureUpstreamIsSet(branchName);
}

async function getCurrentBranch(): Promise<string> {
  const { stdout: currentBranch } = await execFileNoThrow(gitExe(), [
    'branch',
    '--show-current',
  ]);
  return currentBranch.trim();
}

/**
 * Processes messages for teleport resume — local-only message deserialize +
 * notice prepend. Still useful for replaying a previously serialized session.
 */
export function processMessagesForTeleportResume(messages: Message[], error: Error | null): Message[] {
  const deserializedMessages = deserializeMessages(messages);
  return [
    ...deserializedMessages,
    createTeleportResumeUserMessage(),
    createTeleportResumeSystemMessage(error),
  ];
}

/**
 * Checks out the specified branch for a teleported session — local git only.
 */
export async function checkOutTeleportedSessionBranch(branch?: string): Promise<{
  branchName: string;
  branchError: Error | null;
}> {
  try {
    const currentBranch = await getCurrentBranch();
    logForDebugging(`Current branch before teleport: '${currentBranch}'`);
    if (branch) {
      logForDebugging(`Switching to branch '${branch}'...`);
      await fetchFromOrigin(branch);
      await checkoutBranch(branch);
      const newBranch = await getCurrentBranch();
      logForDebugging(`Branch after checkout: '${newBranch}'`);
    } else {
      logForDebugging('No branch specified, staying on current branch');
    }
    const branchName = await getCurrentBranch();
    return { branchName, branchError: null };
  } catch (error) {
    const branchName = await getCurrentBranch();
    const branchError = toError(error);
    return { branchName, branchError };
  }
}

export type RepoValidationResult = {
  status: 'match' | 'mismatch' | 'not_in_repo' | 'no_repo_required' | 'error';
  sessionRepo?: string;
  currentRepo?: string | null;
  sessionHost?: string;
  currentHost?: string;
  errorMessage?: string;
};

/**
 * Local repository validation against a SessionResource shape — pure logic,
 * no network. Kept because callers may have a cached SessionResource object
 * even after cloud teleport is gone (e.g. from a serialized handoff).
 */
export async function validateSessionRepository(
  sessionData: SessionResource,
): Promise<RepoValidationResult> {
  const currentParsed = await detectCurrentRepositoryWithHost();
  const currentRepo = currentParsed ? `${currentParsed.owner}/${currentParsed.name}` : null;
  const gitSource = sessionData.session_context.sources.find(
    (source): source is GitSource => source.type === 'git_repository',
  );
  if (!gitSource?.url) {
    return { status: 'no_repo_required' };
  }
  const sessionParsed = parseGitRemote(gitSource.url);
  const sessionRepo = sessionParsed
    ? `${sessionParsed.owner}/${sessionParsed.name}`
    : parseGitHubRepository(gitSource.url);
  if (!sessionRepo) {
    return { status: 'no_repo_required' };
  }
  if (!currentRepo) {
    return {
      status: 'not_in_repo',
      sessionRepo,
      sessionHost: sessionParsed?.host,
      currentRepo: null,
    };
  }
  const stripPort = (host: string): string => host.replace(/:\d+$/, '');
  const repoMatch = currentRepo.toLowerCase() === sessionRepo.toLowerCase();
  const hostMatch =
    !currentParsed ||
    !sessionParsed ||
    stripPort(currentParsed.host.toLowerCase()) === stripPort(sessionParsed.host.toLowerCase());
  if (repoMatch && hostMatch) {
    return { status: 'match', sessionRepo, currentRepo };
  }
  return {
    status: 'mismatch',
    sessionRepo,
    currentRepo,
    sessionHost: sessionParsed?.host,
    currentHost: currentParsed?.host,
  };
}

// ─── Cloud-only stubs (signatures preserved, bodies removed) ────────────────

export async function teleportResumeCodeSession(
  _sessionId: string,
  _onProgress?: TeleportProgressCallback,
): Promise<TeleportRemoteResponse> {
  throw new TeleportOperationError(CLOUD_DISABLED_MSG, chalk.red(`Error: ${CLOUD_DISABLED_MSG}\n`));
}

export async function teleportToRemoteWithErrorHandling(
  _root: Root,
  _description: string | null,
  _signal: AbortSignal,
  _branchName?: string,
): Promise<TeleportToRemoteResponse | null> {
  void _root;
  logForDebugging(`[teleport] ${CLOUD_DISABLED_MSG}`);
  return null;
}

export async function teleportFromSessionsAPI(
  _sessionId: string,
  _orgUUID: string,
  _accessToken: string,
  _onProgress?: TeleportProgressCallback,
  _sessionData?: SessionResource,
): Promise<TeleportRemoteResponse> {
  throw new Error(CLOUD_DISABLED_MSG);
}

export type PollRemoteSessionResponse = {
  newEvents: SDKMessage[];
  lastEventId: string | null;
  branch?: string;
  sessionStatus?: 'idle' | 'running' | 'requires_action' | 'archived';
};

export async function pollRemoteSessionEvents(
  _sessionId: string,
  _afterId: string | null = null,
  _opts?: { skipMetadata?: boolean },
): Promise<PollRemoteSessionResponse> {
  throw new Error(CLOUD_DISABLED_MSG);
}

export async function teleportToRemote(_options: {
  initialMessage: string | null;
  branchName?: string;
  title?: string;
  description?: string;
  model?: string;
  permissionMode?: PermissionMode;
  ultraplan?: boolean;
  signal: AbortSignal;
  useDefaultEnvironment?: boolean;
  environmentId?: string;
  environmentVariables?: Record<string, string>;
  useBundle?: boolean;
  onBundleFail?: (message: string) => void;
  skipBundle?: boolean;
  reuseOutcomeBranch?: string;
  githubPr?: { owner: string; repo: string; number: number };
}): Promise<TeleportToRemoteResponse | null> {
  logForDebugging(`[teleportToRemote] ${CLOUD_DISABLED_MSG}`);
  return null;
}

export async function archiveRemoteSession(_sessionId: string): Promise<void> {
  // No-op: cloud sessions don't exist.
}

// Suppress unused-warning for TeleportLocalErrorType (still re-used by some
// callers via the components/TeleportError module — type-only export keeper).
export type { TeleportLocalErrorType };
