import {
  DEFAULT_POLL_CONFIG,
  type PollIntervalConfig,
} from './pollConfigDefaults.js'

// .min(100) on the seek-work intervals restores the old Math.max(..., 100)
// defense-in-depth floor against fat-fingered GrowthBook values. Unlike a
// clamp, Zod rejects the whole object on violation — a config with one bad
// field falls back to DEFAULT_POLL_CONFIG entirely rather than being
// partially trusted.
//
// The at_capacity intervals use a 0-or-≥100 refinement: 0 means "disabled"
// (heartbeat-only mode), ≥100 is the fat-finger floor. Values 1–99 are
// rejected so unit confusion (ops thinks seconds, enters 10) doesn't poll
// every 10ms against the VerifyEnvironmentSecretAuth DB path.
//
// The object-level refines require at least one at-capacity liveness
// mechanism enabled: heartbeat OR the relevant poll interval. Without this,
// the hb=0, atCapMs=0 drift config (ops disables heartbeat without
// restoring at_capacity) falls through every throttle site with no sleep —
// tight-looping /poll at HTTP-round-trip speed.
/**
 * Fetch the bridge poll interval config from GrowthBook with a 5-minute
 * refresh window. Validates the served JSON against the schema; falls back
 * to defaults if the flag is absent, malformed, or partially-specified.
 *
 * Shared by bridgeMain.ts (standalone) and replBridge.ts (REPL) so ops
 * can tune both poll rates fleet-wide with a single config push.
 */
export function getPollIntervalConfig(): PollIntervalConfig {
  return DEFAULT_POLL_CONFIG
}
