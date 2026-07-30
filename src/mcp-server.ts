#!/usr/bin/env node
/**
 * MCP server for media-kit.
 *
 * Exposes browser automation tools to Claude Code via MCP:
 *   - download  → videos/images/audio from any site
 *   - read      → extract text content from any webpage
 *   - browse    → open a URL in Chrome (user can see it)
 *   - screenshot → capture a webpage screenshot
 *
 * Usage:
 *   "mcpServers": {
 *     "media-kit": {
 *       "command": "media-kit-mcp"
 *     }
 *   }
 *
 * Environment variables:
 *   MEDIAKIT_BROWSER_URL   — CDP URL (default: http://127.0.0.1:9333)
 *   MEDIAKIT_PROXY_URL     — HTTP proxy
 *   MEDIAKIT_OUTPUT_DIR    — download directory (default: /mnt/d/Download)
 *   CHROME_PATH            — Chrome executable path (auto-detect if unset)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MediaKit, ensureChromeRunning, cdpOpenTab, cdpFetch, isCdpReady } from "./index.js";
import { cdpScreenshot } from "./cdp-screenshot.js";

// ── Config from env ──

const BROWSER_BASE_URL = process.env.MEDIAKIT_BROWSER_URL ?? "http://127.0.0.1:9333";
const PROXY_URL = process.env.MEDIAKIT_PROXY_URL ?? "";
const OUTPUT_DIR = process.env.MEDIAKIT_OUTPUT_DIR ?? "/mnt/d/Download";
const CHROME_PATH = process.env.CHROME_PATH ?? process.env.MEDIAKIT_CHROME_PATH ?? "";

// ── Safety ──

const BLOCKED_PROTOCOLS = ["file:", "data:", "ftp:"];
const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^0\./, /^169\.254\./, /^::1$/, /^fc00:/, /^fe80:/,
];

function validateUrl(url: string): string | null {
  try {
    const p = new URL(url);
    if (BLOCKED_PROTOCOLS.includes(p.protocol)) return "不允许访问 file:// 等本地资源";
    const h = p.hostname;
    if (PRIVATE_IP_PATTERNS.some((r) => r.test(h)) || h === "localhost" || h === "localhost.localdomain")
      return `不允许访问内网地址 ${h}`;
    return null;
  } catch {
    return "无效 URL";
  }
}

// ── Shared schemas ──

const UrlParam = z.string().url().refine((u) => validateUrl(u) === null, { message: "URL 被安全规则拦截" });

const DownloadSchema = z.object({
  url: UrlParam.describe("视频/音频/图片 URL"),
  mediaType: z.enum(["auto", "video", "image", "text", "audio"]).optional().default("auto")
    .describe('内容类型提示。auto=自动, video=视频, image=图片, text=文章/帖子, audio=仅音频'),
  title: z.string().optional().describe("文件标题/主题，用于归类"),
  format: z.string().optional().describe('视频格式，如 "best" "mp4" "720p"'),
  extractAudio: z.boolean().optional().describe("仅提取音频 (mp3)"),
  extractAudioTrack: z.boolean().optional().describe("下载视频后额外提取音轨"),
  transcribe: z.boolean().optional().describe("转录音频为文字 (Whisper GPU)"),
  analyze: z.boolean().optional().describe("分析视频画面内容 (本地视觉模型)"),
});

const ReadSchema = z.object({
  url: UrlParam.describe("要读取内容的网页 URL"),
});

const BrowseSchema = z.object({
  url: UrlParam.describe("要在浏览器中打开的 URL"),
});

const ScreenshotSchema = z.object({
  url: UrlParam.describe("要截图的网页 URL"),
});

// ── Helpers ──

function maskPath(p: string): string {
  return p.replace(/^\/mnt\/[a-z]\//, "D:\\").replace(/^\/home\/[^/]+\//, "~/");
}

async function ensureBrowser(): Promise<boolean> {
  const port = parseInt(new URL(BROWSER_BASE_URL).port || "9333", 10);
  return ensureChromeRunning(port);
}

// ── Server ──

const server = new Server(
  { name: "media-kit", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const kit = new MediaKit({
  browserBaseUrl: BROWSER_BASE_URL,
  proxyUrl: PROXY_URL || undefined,
  outputDir: OUTPUT_DIR,
  chromeExecutablePath: CHROME_PATH || undefined,
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "download",
      description:
        "下载视频/音频/图片/文件。支持抖音、小红书、X/Twitter、YouTube、Bilibili 等 1800+ 平台。" +
        "自动选择 CDP 浏览器或 yt-dlp。可转音频、转文字、分析画面。\n\n" +
        "🚨 使用优先级：最后选择。请先尝试 web_fetch 等内置工具。仅当内置工具被目标网站拦截" +
        "（返回 403/验证码/空内容/反爬提示/JS 渲染空白）时，再使用此工具兜底。" +
        "它通过真实 CDP 浏览器加载，能绕过大多数反爬措施。\n\n" +
        "Triggers: web_fetch被拦 反爬 403 forbidden 验证码 空内容 抓取失败 下载被限制 需要真实浏览器",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "视频/音频/图片 URL" },
          mediaType: { type: "string", enum: ["auto","video","image","text","audio"], default: "auto",
            description: "内容类型: auto=自动 video=视频 image=图片 text=文字 audio=音频" },
          title: { type: "string", description: "文件标题" },
          format: { type: "string", description: '格式如 "best" "mp4" "720p"' },
          extractAudio: { type: "boolean", description: "仅提取音频 mp3" },
          extractAudioTrack: { type: "boolean", description: "下载后额外提取音轨" },
          transcribe: { type: "boolean", description: "转录音频为文字" },
          analyze: { type: "boolean", description: "分析视频画面" },
        },
        required: ["url"],
      },
    },
    {
      name: "read",
      description:
        "读取网页的文字内容。适用于 X/Twitter 帖子、小红书笔记、知乎文章、新闻、博客等。" +
        "自动通过 CDP 浏览器加载页面并提取正文。\n\n" +
        "🚨 使用优先级：最后选择。请先用 web_fetch/WebFetch 等内置工具。仅当内置工具返回" +
        "403/验证码/空白/JS 渲染失败/反爬拦截时，再用此工具兜底。\n\n" +
        "Triggers: web_fetch被拦 反爬 403 空白页面 抓取不了 打不开 需要真实浏览器",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "要读取的网页 URL（X、小红书、知乎、新闻等）" },
        },
        required: ["url"],
      },
    },
    {
      name: "browse",
      description:
        "在 Chrome 浏览器中打开一个网页（你可以在 Windows 屏幕上看到它）。" +
        "用于需要你亲自查看/操作的页面，或需要登录后才能访问的内容。" +
        "浏览器保持打开状态，你可以在 Chrome 中手动操作。\n\n" +
        "Triggers: 打开浏览器 用 Chrome 打开 在浏览器中查看 显示这个页面 帮我打开",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "要在 Chrome 中打开的 URL" },
        },
        required: ["url"],
      },
    },
    {
      name: "screenshot",
      description:
        "对网页进行截图并返回图片路径。适用于查看页面布局、验证内容展示效果、保存快照。" +
        "通过 CDP 浏览器加载页面并截取完整页面截图。\n\n" +
        "Triggers: 截图 截屏 拍照 快照 看看页面长什么样 screenshot capture",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "要截图的网页 URL" },
        },
        required: ["url"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "download": {
        const p = DownloadSchema.parse(args);
        const result = await kit.download({
          url: p.url, mediaType: p.mediaType, title: p.title, format: p.format,
          extractAudio: p.extractAudio, extractAudioTrack: p.extractAudioTrack,
          transcribe: p.transcribe, analyze: p.analyze,
        });
        if (!result.ok) {
          return { content: [{ type: "text", text: `下载失败: ${result.error}` }], isError: true };
        }
        const lines = [`已下载 ${result.files.length} 个文件 (${result.method})`];
        for (const f of result.files) lines.push(`  [${f.type}] ${maskPath(f.path)}`);
        if (result.warning) lines.push(`警告: ${result.warning}`);
        if (result.text) { lines.push(""); lines.push("--- 内容 ---"); lines.push(result.text); }
        lines.push(`耗时: ${result.durationMs}ms`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "read": {
        const p = ReadSchema.parse(args);
        const result = await kit.download({ url: p.url, mediaType: "text" });
        if (!result.ok) {
          return { content: [{ type: "text", text: `读取失败: ${result.error}` }], isError: true };
        }
        const text = result.text || "(页面无文字内容)";
        return {
          content: [
            { type: "text", text: `📄 ${p.url}\n\n${text.slice(0, 5000)}${text.length > 5000 ? "\n\n...(内容过长已截断)" : ""}` },
          ],
        };
      }

      case "browse": {
        const p = BrowseSchema.parse(args);
        await ensureBrowser();
        const tab = await cdpOpenTab(BROWSER_BASE_URL, p.url);
        if (!tab) return { content: [{ type: "text", text: "浏览器打开失败" }], isError: true };
        return { content: [{ type: "text", text: `✅ 已在 Chrome 中打开: ${p.url}\n请切换到 Windows Chrome 查看。` }] };
      }

      case "screenshot": {
        const p = ScreenshotSchema.parse(args);
        await ensureBrowser();
        const filePath = await cdpScreenshot(BROWSER_BASE_URL, p.url, OUTPUT_DIR);
        if (!filePath) return { content: [{ type: "text", text: "截图失败" }], isError: true };
        return {
          content: [
            { type: "text", text: `✅ 截图已保存: ${maskPath(filePath)}` },
            { type: "resource", resource: { text: filePath, uri: `file://${filePath}`, mimeType: "image/png" } },
          ],
        };
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `错误: ${msg}` }], isError: true };
  }
});

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server fatal:", err);
  process.exit(1);
});
