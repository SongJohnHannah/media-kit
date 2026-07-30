/**
 * ffmpeg video compression — compresses videos > 20MB.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveBin } from "./resolve-bin.js";
import { logWarn } from "./utils.js";
import type { DownloadedFile } from "./types.js";

const execFileAsync = promisify(execFile);

const COMPRESS_THRESHOLD_BYTES = 20 * 1024 * 1024;
const COMPRESS_TARGET_BYTES = 19 * 1024 * 1024;

export async function compressIfNeeded(files: DownloadedFile[]): Promise<void> {
  const ffmpegBin = resolveBin("ffmpeg");
  if (!ffmpegBin) {
    logWarn("[compressor] ffmpeg not found; skipping compression");
    return;
  }

  for (const file of files) {
    if (file.type !== "video") continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.path);
    } catch {
      continue;
    }
    if (stat.size <= COMPRESS_THRESHOLD_BYTES) continue;

    const parsed = path.parse(file.path);
    const outputPath = path.join(parsed.dir, `${parsed.name}_compressed${parsed.ext}`);
    if (fs.existsSync(outputPath)) continue;

    let durationSec = 0;
    try {
      const { stdout } = await execFileAsync(
        ffmpegBin,
        ["-i", file.path, "-hide_banner", "-show_entries", "format=duration", "-of", "csv=p=0"],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      durationSec = parseFloat(stdout.trim()) || 0;
    } catch {
      /* ffprobe may print to stderr but still output duration */
    }
    if (durationSec <= 0) continue;

    const audioBps = 128_000;
    const targetVideoBps = Math.floor((COMPRESS_TARGET_BYTES * 0.95 * 8) / durationSec - audioBps);
    if (targetVideoBps <= 0) continue;

    try {
      await execFileAsync(
        ffmpegBin,
        [
          "-i", file.path,
          "-c:v", "libx264",
          "-b:v", String(targetVideoBps),
          "-maxrate", String(targetVideoBps),
          "-bufsize", String(targetVideoBps * 2),
          "-preset", "fast",
          "-crf", "28",
          "-c:a", "aac",
          "-b:a", "128k",
          "-y", outputPath,
        ],
        { timeout: 600_000, maxBuffer: 10 * 1024 * 1024 },
      );

      const compressedStat = fs.statSync(outputPath);
      if (compressedStat.size < stat.size) {
        file.path = outputPath;
      } else {
        fs.unlinkSync(outputPath);
      }
    } catch (err) {
      logWarn(`[compressor] ffmpeg compression failed: ${String(err)}`);
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
  }
}
