/**
 * First-party event logging is intentionally disabled in the OSS build.
 *
 * This file preserves the public API used throughout the CLI while ensuring no
 * telemetry providers, exporters, or batching logic are initialized.
 */

export type EventSamplingConfig = {
  [eventName: string]: {
    sample_rate: number
  }
}

export function getEventSamplingConfig(): EventSamplingConfig {
  return {}
}

export function shouldSampleEvent(_eventName: string): number | null {
  return 0
}

export async function shutdown1PEventLogging(): Promise<void> {}

export function is1PEventLoggingEnabled(): boolean {
  return false
}

export function logEventTo1P(
  _eventName: string,
  _metadata: Record<string, number | boolean | undefined> = {},
): void {}

export function initialize1PEventLogging(): void {}

export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {}
