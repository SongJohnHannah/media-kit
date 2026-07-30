/**
 * audio-extract: Extract audio track from video files using ffmpeg.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveBin } from "./resolve-bin.js";
import { logWarn } from "./utils.js";

const execFileAsync = promisify(execFile);

/**
 * Extract audio from a video file as mp3.
 * Returns the mp3 file path, or null if extraction fails.
 */
export async function extractAudioFromVideo(videoPath: string, outputDir?: string): Promise<string | null> {
  const ffmpeg = resolveBin("ffmpeg");
  if (!ffmpeg) {
    logWarn("[audio-extract] ffmpeg not found; cannot extract audio");
    return null;
  }

  if (!fs.existsSync(videoPath)) {
    logWarn(`[audio-extract] video file not found: ${videoPath}`);
    return null;
  }

  const dir = outputDir || path.dirname(videoPath);
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const mp3Path = path.join(dir, `${baseName}.mp3`);

  if (fs.existsSync(mp3Path)) {
    return mp3Path;
  }

  try {
    await execFileAsync(ffmpeg, [
      "-i", videoPath,
      "-vn",             // no video
      "-acodec", "libmp3lame",
      "-ab", "192k",
      "-ar", "44100",
      "-y",
      mp3Path,
    ], { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });

    if (fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 1000) {
      return mp3Path;
    }
    return null;
  } catch (err) {
    logWarn(`[audio-extract] ffmpeg failed: ${String(err)}`);
    return null;
  }
}

export async function probeHasAudioTrack(filePath: string): Promise<boolean> {
  const ffprobe = resolveBin("ffprobe") || resolveBin("ffmpeg");
  if (!ffprobe) return false;
  const bin = resolveBin("ffprobe") ? "ffprobe" : "ffmpeg";
  try {
    const args = bin === "ffprobe"
      ? ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath]
      : ["-i", filePath, "-hide_banner"];
    const { stdout } = await execFileAsync(bin, args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function mergeVideoAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<string | null> {
  const ffmpeg = resolveBin("ffmpeg");
  if (!ffmpeg) {
    logWarn("[audio-extract] ffmpeg not found; cannot merge video+audio");
    return null;
  }

  try {
    await execFileAsync(ffmpeg, [
      "-i", videoPath,
      "-i", audioPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "128k",
      "-y",
      outputPath,
    ], { timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
      try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
      return outputPath;
    }
    return null;
  } catch (err) {
    logWarn(`[audio-extract] merge failed: ${String(err)}`);
    return null;
  }
}
