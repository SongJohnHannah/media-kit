/**
 * Shared type definitions for the media download toolkit.
 */

/** A single downloaded file */
export interface DownloadedFile {
  path: string;
  type: "video" | "audio" | "image" | "text";
}

/** Unified result returned by all download tools */
export interface MediaDownloadResult {
  ok: boolean;
  method: "ytdlp" | "videodl" | "cdp" | "none";
  files: DownloadedFile[];
  error?: string;
  /** Non-fatal warning (e.g. login redirect detected but download succeeded). */
  warning?: string;
  text?: string;
  durationMs: number;
}

/** Content extracted from a CDP page scrape */
export interface CdpPageContent {
  title: string;
  url: string;
  text: string;
  images: Array<{ src: string; alt: string; width: number; height: number }>;
  videos: Array<{ src: string; type: string }>;
  blocked?: boolean;
  urls?: string[];
}

/** Parameters shared by video download tools */
export interface VideoDownloadParams {
  url: string;
  outputDir: string;
  title?: string;
  format?: string;
  extractAudio?: boolean;
  cookieFilePath?: string;
}

/** Configuration for the media download toolkit */
export interface MediaKitConfig {
  /** CDP browser base URL (e.g. "http://127.0.0.1:9333") */
  browserBaseUrl?: string;
  /** HTTP proxy URL (e.g. "http://127.0.0.1:2080") */
  proxyUrl?: string;
  /** Default output directory */
  outputDir?: string;
  /** Chrome executable path override */
  chromeExecutablePath?: string;
  /** Extra args passed to Chrome */
  chromeExtraArgs?: string[];
  /** User data directory for Chrome profile persistence */
  chromeUserDataDir?: string;
}
