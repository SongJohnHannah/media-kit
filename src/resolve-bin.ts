/**
 * Standalone binary resolver — finds executables in trusted system paths.
 * No external dependencies; drops into any Node.js project.
 */

import fs from "node:fs";
import path from "node:path";

const UNIX_TRUSTED = [
  "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin",
  "/run/current-system/sw/bin",
];

const WIN_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];

function isExecutable(filePath: string): boolean {
  try {
    if (process.platform === "win32") {
      fs.accessSync(filePath, fs.constants.R_OK);
    } else {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

const cache = new Map<string, string | null>();

/**
 * Resolve a binary name (e.g. "yt-dlp", "ffmpeg") to an absolute path.
 * Searches trusted system directories first, then common package-manager paths.
 * Returns `null` if not found.
 */
export function resolveBin(name: string, extraDirs?: string[]): string | null {
  const key = name + (extraDirs ? ":" + extraDirs.join(",") : "");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const dirs = [...UNIX_TRUSTED, ...(extraDirs ?? [])];
  const home = process.env.HOME || "/root";
  dirs.push(path.join(home, ".local/bin"), path.join(home, "bin"));

  for (const dir of dirs) {
    if (process.platform === "win32") {
      for (const ext of WIN_EXTENSIONS) {
        const candidate = path.join(dir, name + ext);
        if (isExecutable(candidate)) {
          cache.set(key, candidate);
          return candidate;
        }
      }
    } else {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) {
        cache.set(key, candidate);
        return candidate;
      }
    }
  }

  cache.set(key, null);
  return null;
}
