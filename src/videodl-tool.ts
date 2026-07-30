/**
 * videodl-tool: Download videos from Chinese platforms.
 *
 * Strategy: CDP Network interception → yt-dlp + cookies fallback → yt-dlp without cookies
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { mergeVideoAudio, probeHasAudioTrack } from "./audio-extract.js";
import { cdpExtractAndDownloadVideo, getCookiesFile } from "./cdp-client.js";
import { compressIfNeeded } from "./compressor.js";
import { resolveBin } from "./resolve-bin.js";
import type { DownloadedFile, MediaDownloadResult, VideoDownloadParams } from "./types.js";
import { logWarn } from "./utils.js";

const execFileAsync = promisify(execFile);

const YTDLP_TIMEOUT_MS = 300_000;
const YTDLP_MAX_BUFFER = 10 * 1024 * 1024;

// Domains where yt-dlp's API extractor is broken → CDP instead
const CDP_VIDEO_DOMAINS = [
  "douyin.com", "www.douyin.com", "v.douyin.com",
  "xiaohongshu.com", "www.xiaohongshu.com", "xhslink.com",
] as const;

function needsCdpVideoExtraction(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return CDP_VIDEO_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

const DEFAULT_OUTPUT_DIR = "/mnt/d/Download/original_video";

function sanitizeFolderName(name: string): string {
  return (
    name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").substring(0, 100) || "untitled"
  );
}

function buildTargetDir(params: VideoDownloadParams): string {
  const baseDir = params.outputDir?.trim() || DEFAULT_OUTPUT_DIR;
  const dateSubDir = new Date().toISOString().slice(0, 10);
  return path.join(baseDir, dateSubDir);
}

function detectFileType(filePath: string): DownloadedFile["type"] {
  const ext = path.extname(filePath).toLowerCase();
  if ([".mp3", ".m4a", ".ogg", ".wav", ".flac", ".aac"].includes(ext)) return "audio";
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext)) return "image";
  return "video";
}

function resolveYtdlpBin(): string | null {
  const resolved = resolveBin("yt-dlp");
  if (resolved) return resolved;
  return null;
}

async function runYtdlp(params: VideoDownloadParams): Promise<{ success: boolean; files: DownloadedFile[]; stderr: string }> {
  const ytdlpBin = resolveYtdlpBin();
  if (!ytdlpBin) return { success: false, files: [], stderr: "yt-dlp binary not found" };

  const targetDir = buildTargetDir(params);
  await fs.promises.mkdir(targetDir, { recursive: true });

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
    const result = await execFileAsync(ytdlpBin, args, { timeout: YTDLP_TIMEOUT_MS, maxBuffer: YTDLP_MAX_BUFFER });
    const files: DownloadedFile[] = [];
    for (const line of (result.stdout?.toString() ?? "").trim().split("\n").filter(Boolean)) {
      const filePath = line.trim();
      if (filePath && fs.existsSync(filePath)) files.push({ path: filePath, type: detectFileType(filePath) });
    }
    return { success: files.length > 0, files, stderr: result.stderr?.toString() ?? "" };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    const output = error.stdout?.toString() ?? "";
    const files: DownloadedFile[] = [];
    for (const line of output.trim().split("\n").filter(Boolean)) {
      const filePath = line.trim();
      if (filePath && fs.existsSync(filePath) && filePath.startsWith(targetDir)) {
        files.push({ path: filePath, type: detectFileType(filePath) });
      }
    }
    if (files.length > 0) return { success: true, files, stderr: error.stderr?.toString() ?? "" };
    return { success: false, files: [], stderr: error.stderr?.toString() ?? String(err) };
  }
}

export async function videoDlDownload(
  params: VideoDownloadParams,
  options?: { browserBaseUrl?: string; proxyUrl?: string },
): Promise<MediaDownloadResult> {
  const start = Date.now();

  // Step 1: CDP Network interception (Douyin, XHS, etc.)
  if (options?.browserBaseUrl && needsCdpVideoExtraction(params.url)) {
    const targetDir = buildTargetDir(params);
    const result = await cdpExtractAndDownloadVideo(
      options.browserBaseUrl, params.url, targetDir, params.title || "video", options.proxyUrl,
    );
    if (result.ok && result.filePath) {
      let finalVideoPath = result.filePath;
      let standaloneAudioPath = result.audioFilePath;

      // Merge if we captured both video and audio streams
      if (standaloneAudioPath) {
        const mergedPath = path.join(
          path.dirname(finalVideoPath),
          `${path.basename(finalVideoPath, path.extname(finalVideoPath))}_merged${path.extname(finalVideoPath)}`,
        );
        const merged = await mergeVideoAudio(finalVideoPath, standaloneAudioPath, mergedPath);
        if (merged) {
          finalVideoPath = merged;
          standaloneAudioPath = undefined; // already deleted by mergeVideoAudio
        } else {
          try { fs.unlinkSync(standaloneAudioPath); } catch { /* ignore */ }
          standaloneAudioPath = undefined;
        }
      } else {
        // No audio captured — check if video has any audio track
        const hasAudio = await probeHasAudioTrack(finalVideoPath);
        if (!hasAudio) {
          logWarn(`[videodl] Video has no audio track: ${finalVideoPath}`);
        }
      }

      const files: DownloadedFile[] = [{ path: finalVideoPath, type: "video" }];
      if (standaloneAudioPath) {
        files.push({ path: standaloneAudioPath, type: "audio" });
      }
      await compressIfNeeded(files);
      return { ok: true, method: "videodl", files, durationMs: Date.now() - start, warning: result.warning };
    }
    logWarn(`[videodl] CDP video extraction failed: ${result.error}`);
  }

  // Step 2: yt-dlp + CDP cookies
  const cookieFilePath = await getCookiesFile(options?.browserBaseUrl, params.url);
  if (cookieFilePath) {
    const result = await runYtdlp({ ...params, cookieFilePath });
    try { fs.unlinkSync(cookieFilePath); } catch { /* ignore */ }
    if (result.success) {
      await compressIfNeeded(result.files);
      return { ok: true, method: "videodl", files: result.files, durationMs: Date.now() - start };
    }
  }

  // Step 3: yt-dlp without cookies
  const result = await runYtdlp(params);
  if (result.success) {
    await compressIfNeeded(result.files);
    return { ok: true, method: "videodl", files: result.files, durationMs: Date.now() - start };
  }

  logWarn(`[videodl] All methods failed for ${params.url}: ${result.stderr.slice(0, 300)}`);
  return {
    ok: false, method: "none", files: [],
    error: `CDP and yt-dlp both failed: ${result.stderr.slice(0, 500)}`,
    durationMs: Date.now() - start,
  };
}
