/**
 * Standalone logger — drops into any project without framework deps.
 * Replace `logWarn` / `logInfo` with your own logger if desired.
 */

export function logWarn(msg: string): void {
  console.warn(`[media-kit] ${msg}`);
}

export function logInfo(msg: string): void {
  console.log(`[media-kit] ${msg}`);
}
