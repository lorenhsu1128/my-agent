/**
 * Whether inference-config commands (/model, /fast, /effort) should execute
 * immediately (during a running query) rather than waiting for the current
 * turn to finish.
 *
 * tengu_immediate_model_command shipped=true → always on.
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return true
}
