/**
 * media-kit: Standalone media download toolkit.
 *
 * Zero framework dependencies — drop into any Node.js/TypeScript project.
 *
 * Usage:
 *   import { MediaKit } from "./media-kit";
 *   const kit = new MediaKit({ browserBaseUrl: "http://127.0.0.1:9333", proxyUrl: "http://127.0.0.1:2080" });
 *   const result = await kit.download({ url: "https://v.douyin.com/xxx/", title: "my-video" });
 *   if (result.ok) console.log("Downloaded:", result.files);
 *
 * Routing:
 *   - Chinese video platforms (Douyin, XHS, Bilibili...) → CDP Network interception → yt-dlp fallback
 *   - Overseas video platforms (YouTube, X, Instagram...) → yt-dlp → CDP fallback
 *   - Text/image on any site → CDP browser scrape
 *   - Audio extraction → ffmpeg extracts mp3 from video
 */

import fs from "node:fs";
import path from "node:path";
import { extractAudioFromVideo, probeHasAudioTrack } from "./audio-extract.js";
import { transcribeAudio } from "./transcribe.js";
import { ensureChromeRunning } from "./cdp-client.js";
import { cdpScrape } from "./cdp-scrape-tool.js";
import { isChineseVideoDomain, isCdpFirstDomain } from "./domain-utils.js";
import type { MediaDownloadResult, MediaKitConfig, VideoDownloadParams } from "./types.js";
import { logWarn } from "./utils.js";
import { videoDlDownload } from "./videodl-tool.js";
import { ytdlpDownload } from "./ytdlp-tool.js";

const DEFAULT_OUTPUT_DIR = "/mnt/d/Download/original_video";

export interface DownloadOptions {
  /** URL to download from */
  url: string;
  /** Output directory (default: /mnt/d/Download) */
  outputDir?: string;
  /** Folder title for organizing files */
  title?: string;
  /** Video format preference (e.g. "best", "mp4", "720p") */
  format?: string;
  /** Extract audio only (mp3) via yt-dlp */
  extractAudio?: boolean;
  /** Content type hint */
  mediaType?: "auto" | "video" | "image" | "text" | "audio";
  /** Extract audio from downloaded video and include as mp3 */
  extractAudioTrack?: boolean;
  /** Transcribe audio to text via local Whisper (GPU) */
  transcribe?: boolean;
}

export class MediaKit {
  private config: Required<Pick<MediaKitConfig, "browserBaseUrl" | "proxyUrl" | "outputDir">> & MediaKitConfig;

  constructor(config: MediaKitConfig = {}) {
    this.config = {
      browserBaseUrl: config.browserBaseUrl ?? "http://127.0.0.1:9333",
      proxyUrl: config.proxyUrl ?? "",
      outputDir: config.outputDir ?? DEFAULT_OUTPUT_DIR,
      chromeExecutablePath: config.chromeExecutablePath,
      chromeExtraArgs: config.chromeExtraArgs,
      chromeUserDataDir: config.chromeUserDataDir,
    };
  }

  /** Download content from a URL */
  async download(options: DownloadOptions): Promise<MediaDownloadResult> {
    const { url, title, format, extractAudio, extractAudioTrack, transcribe } = options;
    const outputDir = options.outputDir?.trim() || this.config.outputDir;
    const mediaType = options.mediaType ?? "auto";

    const start = Date.now();
    await fs.promises.mkdir(outputDir, { recursive: true });

    // Resolve browserBaseUrl: ensure Chrome CDP is running
    let browserBaseUrl = this.config.browserBaseUrl;
    if (browserBaseUrl) {
      const cdpPort = parseInt(new URL(browserBaseUrl).port || "9333", 10);
      const ready = await ensureChromeRunning(cdpPort, this.config);
      if (!ready) {
        browserBaseUrl = undefined as unknown as string;
        logWarn("[media-kit] Chrome CDP not available; browser fallback disabled");
      }
    }

    // mediaType=audio: extract audio directly via yt-dlp
    const isAudioRequest = mediaType === "audio" || extractAudio;
    const isTextRequest = mediaType === "text";
    const isImageOnly = mediaType === "image";
    const isVideoOnly = mediaType === "video";
    const wantsVideo = !isTextRequest && !isImageOnly && !isAudioRequest;

    const params: VideoDownloadParams = {
      url,
      outputDir,
      title,
      format,
      extractAudio: isAudioRequest,
    };
    const proxyUrl = this.config.proxyUrl || undefined;

    // Route A: Audio extraction (yt-dlp -x)
    if (isAudioRequest) {
      const ytdlpResult = await ytdlpDownload(params, { browserBaseUrl });
      if (ytdlpResult.ok) return ytdlpResult;
      return {
        ok: false, method: "none", files: [],
        error: `Audio extraction failed for ${url}: ${ytdlpResult.error}`,
        durationMs: Date.now() - start,
      };
    }

    // Route B: Chinese video platforms → videodl (CDP + yt-dlp)
    if (wantsVideo && isChineseVideoDomain(url)) {
      const result = await videoDlDownload(params, { browserBaseUrl, proxyUrl });
      if (result.ok) await this.postProcess(result, { extractAudioTrack, transcribe });
      return result;
    }

    // Route C: CDP-first domains (X, Instagram) → yt-dlp first, CDP fallback
    if (wantsVideo && isCdpFirstDomain(url)) {
      const ytdlpResult = await ytdlpDownload(params, { browserBaseUrl });
      if (ytdlpResult.ok) {
        await this.postProcess(ytdlpResult, { extractAudioTrack, transcribe });
        return ytdlpResult;
      }

      if (browserBaseUrl) {
        const cdpResult = await cdpScrape({ url, outputDir, browserBaseUrl, downloadImages: true, downloadVideos: true, downloadText: true });
        if (cdpResult.ok) return cdpResult;
      }

      return {
        ok: false, method: "none", files: [],
        error: `yt-dlp 和浏览器 CDP 都无法处理 ${url}。可能是页面需要登录，请先在 Chrome 中登录`,
        durationMs: Date.now() - start,
      };
    }

    // Route D: Text/image on any site → CDP scrape
    if (browserBaseUrl) {
      const cdpResult = await cdpScrape({
        url, outputDir, browserBaseUrl,
        downloadImages: !isTextRequest,
        downloadVideos: false,
        downloadText: !isVideoOnly,
      });
      if (cdpResult.ok) return cdpResult;
    }

    // Route E: Video on unknown/overseas sites → yt-dlp
    if (wantsVideo) {
      const ytdlpResult = await ytdlpDownload(params, { browserBaseUrl });
      if (ytdlpResult.ok) {
        await this.postProcess(ytdlpResult, { extractAudioTrack, transcribe });
        return ytdlpResult;
      }

      if (browserBaseUrl) {
        const cdpResult = await cdpScrape({ url, outputDir, browserBaseUrl, downloadImages: true, downloadVideos: true, downloadText: true });
        if (cdpResult.ok) return cdpResult;
      }

      return {
        ok: false, method: "none", files: [],
        error: `Download failed for ${url}: yt-dlp and CDP both returned no content`,
        durationMs: Date.now() - start,
      };
    }

    // Route F: CDP unavailable for text/image
    return {
      ok: false, method: "none", files: [],
      error: `浏览器 CDP 不可用，无法从 ${url} 提取内容。请确保 Chrome/Edge/Brave 已安装，或查看日志确认原因`,
      durationMs: Date.now() - start,
    };
  }

  /** Post-process: extract audio track and/or transcribe */
  private async postProcess(
    result: MediaDownloadResult,
    opts: { extractAudioTrack?: boolean; transcribe?: boolean },
  ): Promise<void> {
    if (!opts.extractAudioTrack && !opts.transcribe) return;

    // Find existing audio file (may already be present from CDP capture+merge)
    let audioFile = result.files.find((f) => f.type === "audio");
    if (!audioFile) {
      const videoFile = result.files.find((f) => f.type === "video");
      if (videoFile) {
        const hasAudio = await probeHasAudioTrack(videoFile.path);
        if (!hasAudio) {
          logWarn(`[media-kit] Video has no audio track, skipping audio extraction: ${videoFile.path}`);
          return;
        }
        const mp3Path = await extractAudioFromVideo(videoFile.path);
        if (mp3Path) {
          audioFile = { path: mp3Path, type: "audio" };
          result.files.push(audioFile);
        }
      }
    }

    // Transcribe audio to text
    if (opts.transcribe && audioFile) {
      const tr = await transcribeAudio(audioFile.path, {
        outputDir: path.dirname(audioFile.path),
      });
      if (tr.ok && tr.text) {
        result.text = tr.text;
        if (tr.transcriptPath) {
          result.files.push({ path: tr.transcriptPath, type: "text" });
        }
      }
    }
  }
}

// Re-export everything for direct use
export {
  extractAudioFromVideo,
} from "./audio-extract.js";

export {
  ensureChromeRunning,
  isCdpReady,
  cdpOpenTab,
  cdpCloseTab,
  cdpFetch,
  cdpGetCookies,
  cdpEvaluate,
  getCookiesFile,
  writeCookiesToFile,
  closeOrphanedTabs,
  cdpExtractAndDownloadVideo,
} from "./cdp-client.js";

export { videoDlDownload } from "./videodl-tool.js";
export { ytdlpDownload } from "./ytdlp-tool.js";
export { cdpScrape, cdpScrapePage } from "./cdp-scrape-tool.js";
export { compressIfNeeded } from "./compressor.js";
export { cdpScreenshot } from "./cdp-screenshot.js";
export { isChineseVideoDomain, isCdpFirstDomain, extractDomain } from "./domain-utils.js";
export { resolveBin } from "./resolve-bin.js";
export { transcribeAudio } from "./transcribe.js";

export type {
  MediaKitConfig,
  MediaDownloadResult,
  DownloadedFile,
  VideoDownloadParams,
  CdpPageContent,
} from "./types.js";
