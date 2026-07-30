/**
 * ytdlp-tool: Download videos from overseas platforms via yt-dlp.
 * 1800+ platforms: YouTube, Twitter/X, Instagram, TikTok, Facebook, etc.
 *
 * Strategy: yt-dlp direct → yt-dlp + CDP cookies → fail
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getCookiesFile } from "./cdp-client.js";
import { compressIfNeeded } from "./compressor.js";
import { resolveBin } from "./resolve-bin.js";
import type { DownloadedFile, MediaDownloadResult, VideoDownloadParams } from "./types.js";
import { logWarn } from "./utils.js";

const execFileAsync = promisify(execFile);

const YTDLP_TIMEOUT_MS = 300_000;
const YTDLP_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_OUTPUT_DIR = "/mnt/d/Download";

const YTDLP_RETRYABLE_ERRORS = [
  "http error 403", "sign in", "captcha", "unable to", "not found",
  "login required", "private video", "members-only", "age-restricted",
  "geo-restricted", "http error 429", "rate limit", "temporary ban",
  "access denied", "cloudflare", "please wait", "verify you are human",
  "fresh cookies", "cookies",
] as const;

function resolveYtdlpBin(): string {
  const resolved = resolveBin("yt-dlp");
  if (resolved) return resolved;
  throw new Error("yt-dlp not found. Install: pip install yt-dlp");
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").substring(0, 100) || "untitled";
}

function detectFileType(filePath: string): DownloadedFile["type"] {
  const ext = path.extname(filePath).toLowerCase();
  if ([".mp3", ".m4a", ".ogg", ".wav", ".flac", ".aac"].includes(ext)) return "audio";
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext)) return "image";
  return "video";
}

function isYtdlpRetryableError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return YTDLP_RETRYABLE_ERRORS.some((p) => lower.includes(p));
}

async function runYtdlp(params: VideoDownloadParams): Promise<{ success: boolean; files: DownloadedFile[]; stderr: string }> {
  const bin = resolveYtdlpBin();
  const baseDir = params.outputDir?.trim() || DEFAULT_OUTPUT_DIR;
  const dateSubDir = new Date().toISOString().slice(0, 10);
  const folderName = params.title ? sanitizeFolderName(params.title) : "%(title)s";
  const targetDir = path.join(baseDir, dateSubDir, folderName);

  const args: string[] = [
    "--no-warnings", "--no-check-certificates", "--prefer-free-formats",
    "-o", path.join(targetDir, "%(title)s.%(ext)s"),
    "--print", "after_move:filepath",
  ];
  if (params.cookieFilePath) args.splice(1, 0, "--cookies", params.cookieFilePath);
  if (params.format && params.format !== "best") args.push("-f", params.format);
  if (params.extractAudio) args.push("-x", "--audio-format", "mp3");
  args.push(params.url);

  try {
    const result = await execFileAsync(bin, args, { timeout: YTDLP_TIMEOUT_MS, maxBuffer: YTDLP_MAX_BUFFER });
    const files: DownloadedFile[] = [];
    for (const line of (result.stdout?.toString() ?? "").trim().split("\n").filter(Boolean)) {
      const filePath = line.trim();
      if (filePath && fs.existsSync(filePath)) files.push({ path: filePath, type: detectFileType(filePath) });
    }
    return { success: files.length > 0, files, stderr: result.stderr?.toString() ?? "" };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; code?: string };
    if (error.code === "ETIMEDOUT" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error(`yt-dlp process error: ${error.code}`, { cause: err });
    }
    return { success: false, files: [], stderr: error.stderr?.toString() ?? "" };
  }
}

export async function ytdlpDownload(
  params: VideoDownloadParams,
  options?: { browserBaseUrl?: string },
): Promise<MediaDownloadResult> {
  const start = Date.now();

  let result = await runYtdlp(params);
  if (result.success) {
    await compressIfNeeded(result.files);
    return { ok: true, method: "ytdlp", files: result.files, durationMs: Date.now() - start };
  }

  if (isYtdlpRetryableError(result.stderr)) {
    const cookieFilePath = await getCookiesFile(options?.browserBaseUrl, params.url);
    if (cookieFilePath) {
      result = await runYtdlp({ ...params, cookieFilePath });
      try { fs.unlinkSync(cookieFilePath); } catch { /* ignore */ }
      if (result.success) {
        await compressIfNeeded(result.files);
        return { ok: true, method: "ytdlp", files: result.files, durationMs: Date.now() - start };
      }
    }
  }

  logWarn(`[ytdlp] Download failed for ${params.url}: ${result.stderr.slice(0, 300)}`);
  return {
    ok: false, method: "none", files: [],
    error: `yt-dlp failed: ${result.stderr.slice(0, 500)}`,
    durationMs: Date.now() - start,
  };
}
