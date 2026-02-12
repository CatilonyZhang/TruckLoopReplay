// Replay folder config for desktop mode.
// If REPLAY_FOLDER is empty, app falls back to DEFAULT_REPLAY_FOLDER.
export const REPLAY_FOLDER = '/Volumes/E/TRUNK_LOOP/dayun_spiral_exports'
export const DEFAULT_REPLAY_FOLDER = '/Volumes/E/TRUNK_LOOP/dayun_spiral_exports'

export function resolveReplayFolder(): string {
  const preferred = REPLAY_FOLDER.trim()
  if (preferred.length > 0) return preferred
  return DEFAULT_REPLAY_FOLDER
}
