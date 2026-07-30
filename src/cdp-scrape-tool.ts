/**
 * cdp-scrape-tool: Extract text, images, and embedded videos from web pages via CDP.
 * Handles anti-scraping sites (X/Twitter, Douyin, Xiaohongshu, Instagram, Threads).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  cdpCloseTab,
  cdpEvaluate,
  cdpFetch,
  cdpGetCookies,
  cdpOpenTab,
  closeOrphanedTabs,
  writeCookiesToFile,
} from "./cdp-client.js";
import { compressIfNeeded } from "./compressor.js";
import { extractDomain } from "./domain-utils.js";
import { resolveBin } from "./resolve-bin.js";
import type { CdpPageContent, DownloadedFile, MediaDownloadResult } from "./types.js";
import { logWarn } from "./utils.js";

const execFileAsync = promisify(execFile);

const DEFAULT_OUTPUT_DIR = "/mnt/d/Download";

const EXTRACT_PAGE_JS = `(() => {
  const result = { title: document.title || 'untitled', url: location.href, text: '', images: [], videos: [] };

  // Text
  const tweetTexts = document.querySelectorAll('[data-testid="tweetText"]');
  if (tweetTexts.length > 0) {
    result.text = Array.from(tweetTexts).map(el => el.innerText?.trim()).filter(Boolean).join('\\n\\n');
  }
  if (!result.text) {
    const el = document.querySelector('.desc, [class*="desc"], [class*="caption"]');
    if (el?.innerText?.trim()) result.text = el.innerText.trim();
  }
  if (!result.text) {
    const el = document.querySelector('#detail-desc, .note-text, [class*="note-content"]');
    if (el?.innerText?.trim()) result.text = el.innerText.trim();
  }
  if (!result.text) {
    const el = document.querySelector('h1, [class*="caption"], [role="button"] div > span > div > span');
    if (el?.innerText?.trim()) result.text = el.innerText.trim();
  }
  if (!result.text) {
    const article = document.querySelector('article, main, [role="main"]');
    if (article) result.text = article.innerText?.trim() || '';
  }
  if (!result.text) result.text = document.body?.innerText?.slice(0, 10000) || '';

  // Blocked detection
  const bodyLower = document.body?.innerText?.toLowerCase() || '';
  result.blocked = [
    'posts are protected', 'this account is protected', 'log in to see',
    'sign in to view', 'you need to log in', 'create an account to see',
    'page doesn\\'t exist', 'something went wrong',
  ].some(s => bodyLower.includes(s));

  // Images
  const seen = new Set();
  function addImg(src, alt, w, h) {
    if (!src || seen.has(src)) return;
    seen.add(src);
    result.images.push({ src, alt: alt || '', width: w || 0, height: h || 0 });
  }
  document.querySelectorAll('img[src]').forEach(img => {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 50 && h > 50) addImg(img.src || img.getAttribute('data-src') || '', img.alt, w, h);
  });
  document.querySelectorAll('[style*="background-image"]').forEach(el => {
    const m = (el.getAttribute('style') || '').match(/url\\(["']?([^"')]+)["']?\\)/);
    if (m) addImg(m[1], '', 0, 0);
  });
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach(m => addImg(m.content, '', 0, 0));

  // Videos
  document.querySelectorAll('video[src], video source[src]').forEach(el => {
    if (el.src) result.videos.push({ src: el.src, type: el.type || '' });
  });
  document.querySelectorAll('meta[property="og:video"]').forEach(m => {
    if (m.content) result.videos.push({ src: m.content, type: '' });
  });
  document.querySelectorAll('a[href]').forEach(a => {
    if (/\\.(mp4|webm|mov|avi)(\\?|$)/i.test(a.href)) result.videos.push({ src: a.href, type: '' });
  });

  // External URLs
  const extUrls = new Set();
  const skipHosts = ['x.com', 'twitter.com', 'google.com', 't.co', 'pbs.twimg.com', 'abs.twimg.com'];
  document.querySelectorAll('a[href]').forEach(a => {
    try {
      const u = new URL(a.href);
      if (skipHosts.some(s => u.hostname === s || u.hostname.endsWith('.' + s))) return;
      extUrls.add(a.href);
    } catch {}
  });
  result.urls = [...extUrls].slice(0, 30);
  return JSON.stringify(result);
})()`;

function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").substring(0, 100) || "untitled";
}

export interface CdpScrapeParams {
  url: string;
  outputDir: string;
  browserBaseUrl: string;
  downloadImages?: boolean;
  downloadVideos?: boolean;
  downloadText?: boolean;
}

export async function cdpScrapePage(params: CdpScrapeParams): Promise<{
  content: CdpPageContent;
  files: DownloadedFile[];
}> {
  const { url, outputDir, browserBaseUrl, downloadImages = true, downloadVideos = true, downloadText = true } = params;
  const files: DownloadedFile[] = [];

  let tabId = "";
  let wsUrl = "";
  try {
    const tab = await cdpOpenTab(browserBaseUrl, url);
    if (!tab) return { content: { title: "", url, text: "", images: [], videos: [] }, files };
    tabId = tab.tabId;
    wsUrl = tab.wsUrl;
  } catch (err) {
    logWarn(`[cdp-scrape] CDP open tab error: ${String(err)}`);
    return { content: { title: "", url, text: "", images: [], videos: [] }, files };
  }

  // Simulate human browsing
  const humanDelay = () => 2000 + Math.floor(Math.random() * 3000);
  await new Promise((r) => setTimeout(r, humanDelay()));

  // Scroll
  try {
    const steps = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < steps; i++) {
      await cdpEvaluate(wsUrl, `window.scrollTo({ top: Math.floor(document.body.scrollHeight * ${(i + 1) / (steps + 1)}), behavior: 'smooth' })`, 3000);
      await new Promise((r) => setTimeout(r, humanDelay()));
    }
  } catch { /* scroll may fail */ }

  // Extract content
  let extracted: CdpPageContent;
  try {
    const evalResult = await cdpEvaluate(wsUrl, EXTRACT_PAGE_JS, 15_000);
    extracted = JSON.parse(evalResult || "{}") as CdpPageContent;
  } catch (err) {
    logWarn(`[cdp-scrape] CDP evaluate error: ${String(err)}`);
    await cdpCloseTab(browserBaseUrl, tabId);
    return { content: { title: "", url, text: "", images: [], videos: [] }, files };
  }

  // Get cookies for image download
  let cookieHeader = "";
  try {
    const ws = new WebSocket(wsUrl);
    cookieHeader = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => { ws.close(); resolve(""); }, 5000);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ id: 2, method: "Network.getCookies", params: { urls: [url] } }));
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as {
          id?: number; result?: { cookies?: Array<{ name: string; value: string }> };
        };
        if (msg.id === 2 && msg.result?.cookies) {
          clearTimeout(timer); ws.close();
          resolve(msg.result.cookies.map((c) => `${c.name}=${c.value}`).join("; "));
        }
      });
      ws.addEventListener("error", () => { clearTimeout(timer); resolve(""); });
    });
  } catch { /* ignore */ }

  await cdpCloseTab(browserBaseUrl, tabId);
  await closeOrphanedTabs(browserBaseUrl);

  // Build output directory
  const safeTitle = sanitizeFolderName(extracted.title || "untitled");
  const dateSubDir = new Date().toISOString().slice(0, 10);
  const baseDir = outputDir?.trim() || DEFAULT_OUTPUT_DIR;
  const mediaDir = path.join(baseDir, dateSubDir, safeTitle);
  await fs.promises.mkdir(mediaDir, { recursive: true });

  // Save text
  if (downloadText && extracted.text) {
    const textContent = [
      `# ${extracted.title || "Untitled"}`, "",
      `Source: ${extracted.url}`, `Scraped: ${new Date().toISOString()}`, "", "---", "",
      extracted.text,
    ].join("\n");
    const textPath = path.join(mediaDir, "content.md");
    await fs.promises.writeFile(textPath, textContent, "utf-8");
    files.push({ path: textPath, type: "text" });
  }

  // Download images
  if (downloadImages) {
    const imgHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": url,
    };
    if (cookieHeader) imgHeaders["Cookie"] = cookieHeader;

    let imgIdx = 0;
    for (const img of extracted.images) {
      if (!img.src || img.width < 100 || img.height < 100) continue;
      if (img.src.includes("avatar") || img.src.includes("emoji") || img.src.includes("icon")) continue;
      try {
        const imgRes = await fetch(img.src, { headers: imgHeaders });
        if (!imgRes.ok) continue;
        const contentType = imgRes.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/")) continue;
        const ext = contentType.includes("png") ? ".png" : contentType.includes("webp") ? ".webp" : contentType.includes("gif") ? ".gif" : ".jpg";
        const filePath = path.join(mediaDir, `image_${String(++imgIdx).padStart(3, "0")}${ext}`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        if (buffer.length < 5000) continue;
        await fs.promises.writeFile(filePath, buffer);
        files.push({ path: filePath, type: "image" });
      } catch { /* skip */ }
    }
  }

  // Download embedded videos via yt-dlp
  if (downloadVideos && extracted.videos.length > 0) {
    let cookieFilePath: string | undefined;
    if (cookieHeader) {
      const d = extractDomain(url);
      cookieFilePath = (await writeCookiesToFile(cookieHeader, d)) ?? undefined;
    }

    const bin = resolveBin("yt-dlp");
    if (bin) {
      for (const video of extracted.videos) {
        if (!video.src) continue;
        try {
          const videoArgs = ["--no-warnings", "--no-check-certificates", "-o", path.join(mediaDir, "%(title)s.%(ext)s"), "--print", "after_move:filepath"];
          if (cookieFilePath) videoArgs.splice(1, 0, "--cookies", cookieFilePath);
          videoArgs.push(video.src);
          const { stdout } = await execFileAsync(bin, videoArgs, { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
          for (const line of stdout.trim().split("\n").filter(Boolean)) {
            const filePath = line.trim();
            if (filePath && fs.existsSync(filePath)) files.push({ path: filePath, type: "video" });
          }
        } catch { /* skip */ }
      }
    }

    if (cookieFilePath) { try { fs.unlinkSync(cookieFilePath); } catch { /* ignore */ } }
  }

  return { content: extracted, files };
}

/** Convenience wrapper returning MediaDownloadResult */
export async function cdpScrape(params: CdpScrapeParams): Promise<MediaDownloadResult> {
  const start = Date.now();
  const { content, files } = await cdpScrapePage(params);

  if (content.text || files.length > 0) {
    await compressIfNeeded(files);
    const result: MediaDownloadResult = { ok: true, method: "cdp", files, durationMs: Date.now() - start };
    if (content.text) result.text = content.text;
    return result;
  }

  return { ok: false, method: "none", files: [], error: `CDP browser could not extract content from ${params.url}`, durationMs: Date.now() - start };
}
