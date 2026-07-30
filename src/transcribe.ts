/**
 * transcribe: Call local Whisper (audio2text.py) to transcribe audio to text.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { logWarn } from "./utils.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_PATH = path.join(path.dirname(__filename), "scripts", "audio2text.py");

function findPython3(): string | null {
  const candidates = ["python3", "/usr/bin/python3"];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { continue; }
  }
  return null;
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  rawText?: string;
  lang?: string;
  transcriptPath?: string;
  error?: string;
  durationMs: number;
}

export async function transcribeAudio(
  audioPath: string,
  options?: { polish?: boolean; outputDir?: string },
): Promise<TranscribeResult> {
  const start = Date.now();
  const python3 = findPython3();
  if (!python3) {
    return { ok: false, error: "python3 not found", durationMs: Date.now() - start };
  }

  if (!fs.existsSync(audioPath)) {
    return { ok: false, error: `audio file not found: ${audioPath}`, durationMs: Date.now() - start };
  }

  const args: string[] = [SCRIPT_PATH, audioPath, "--json"];
  if (options?.polish) args.push("--polish");
  if (options?.outputDir) args.push("--output-dir", options.outputDir);

  try {
    const { stdout, stderr } = await execFileAsync(python3, args, {
      timeout: 600_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stderr) {
      // Log progress messages from Python (they go to stderr)
      const lines = stderr.trim().split("\n").filter((l) => l.trim());
      for (const line of lines.slice(-3)) {
        logWarn(`[transcribe] ${line}`);
      }
    }

    const result = JSON.parse(stdout.trim()) as {
      ok: boolean;
      text?: string;
      raw_text?: string;
      lang?: string;
      segments_count?: number;
      transcript_path?: string;
      error?: string;
    };

    return {
      ok: result.ok,
      text: result.text,
      rawText: result.raw_text,
      lang: result.lang,
      transcriptPath: result.transcript_path,
      error: result.error,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    const msg = error.stderr?.slice(-500) || error.message || String(err);
    logWarn(`[transcribe] failed: ${msg}`);
    return { ok: false, error: msg, durationMs: Date.now() - start };
  }
}
