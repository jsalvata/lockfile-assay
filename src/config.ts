import { UsageError } from './errors.js';
import type { Mode } from './outcome.js';

export const CONFIG_PATH = '.lockfile-assay.json';
const MODES = new Set(['off', 'warn', 'enforce']);

export function parseConfig(bytes: Buffer | null): Mode {
  if (bytes === null) return 'off';
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new UsageError(
      `${CONFIG_PATH} in base is not valid JSON (it broke on an earlier merge, not in this PR)`,
    );
  }
  const mode = (parsed as { mode?: unknown })?.mode ?? 'off';
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw new UsageError(`${CONFIG_PATH} in base has unknown mode: ${String(mode)}`);
  }
  return mode as Mode;
}
