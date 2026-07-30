#!/usr/bin/env node
/**
 * MCP server for media-kit.
 *
 * Exposes media download/scrape capabilities to Claude Code via MCP.
 *
 * Usage (after npm link in mediaKit dir):
 *   "mcpServers": {
 *     "media-kit": {
 *       "command": "media-kit-mcp"
 *     }
 *   }
 *
 * Environment variables (optional):
 *   MEDIAKIT_BROWSER_URL  — CDP URL (default: http://127.0.0.1:9333)
 *   MEDIAKIT_PROXY_URL    — HTTP proxy (default: none)
 *   MEDIAKIT_OUTPUT_DIR   — download directory (default: /mnt/d/Download)
 *   CHROME_PATH           — Chrome executable path (default: auto-detect)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MediaKit } from "./index.js";

// ── Config from env ──

const BROWSER_BASE_URL = process.env.MEDIAKIT_BROWSER_URL ?? "http://127.0.0.1:9333";
const PROXY_URL = process.env.MEDIAKIT_PROXY_URL ?? "";
const OUTPUT_DIR = process.env.MEDIAKIT_OUTPUT_DIR ?? "/mnt/d/Download";
const CHROME_PATH = process.env.CHROME_PATH ?? process.env.MEDIAKIT_CHROME_PATH ?? "";

// ── Safety constraints ──

/** Blocked URL protocols — no local file access */
const BLOCKED_PROTOCOLS = ["file:", "data:", "ftp:"];
/** Private/reserved IP ranges that should not be accessed via CDP */
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
];

function isBlockedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Block dangerous protocols
    if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
      return `不允许访问 ${parsed.protocol}// 资源（安全限制）`;
    }
    // Block private/internal IPs (SSRF protection)
    const host = parsed.hostname;
    if (PRIVATE_IP_PATTERNS.some((p) => p.test(host))) {
      return `不允许访问内网地址 ${host}（安全限制：防止 SSRF 和数据泄露）`;
    }
    // Block localhost aliases
    if (host === "localhost" || host === "localhost.localdomain") {
      return "不允许访问 localhost（安全限制）";
    }
    return null;
  } catch {
    return "无效的 URL 格式";
  }
}

// ── Zod schemas ──

const DownloadParamsSchema = z.object({
  url: z
    .string()
    .url()
    .refine((url) => isBlockedUrl(url) === null, {
      message: "URL 被安全规则拦截，仅允许访问公网 HTTP/HTTPS 地址",
    })
    .describe("URL to download content from (public HTTP/HTTPS URLs only)."),
  mediaType: z
    .enum(["auto", "video", "image", "text", "audio"])
    .optional()
    .default("auto")
    .describe('Content type hint. "auto" decides automatically. "text" extracts page text (tweets, posts, articles). "image" downloads images. "video" downloads videos. "audio" extracts audio only (mp3).'),
  title: z.string().optional().describe("Topic/title for organizing files. Files saved under outputDir/<date>/<title>/."),
  format: z.string().optional().describe('Video format preference, e.g. "best", "mp4", "720p".'),
  extractAudio: z.boolean().optional().describe("Extract audio only (mp3) from video URL."),
  extractAudioTrack: z.boolean().optional().describe("After downloading video, also extract its audio track as mp3."),
  transcribe: z.boolean().optional().describe("Transcribe audio to text via local Whisper (GPU). Downloads video, extracts audio, runs Whisper."),
  analyze: z.boolean().optional().describe("Analyze video content with local Gemma 4 vision model (Ollama). Downloads video, extracts key frames, describes each."),
});

// ── Server ──

const server = new Server(
  { name: "media-kit", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Single kit instance — Chrome CDP lifecycle managed internally
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
        "Download content from public URLs — videos, images, audio, and text (tweets, posts, articles). " +
        "For anti-scraping sites (X/Twitter, Douyin, Instagram, Xiaohongshu, etc.) uses CDP browser " +
        "to simulate real-user access. For video sites (YouTube, Bilibili, etc.) uses yt-dlp. " +
        "Use mediaType to hint content type. Set transcribe=true to get spoken content as text. " +
        "Set analyze=true to get visual description via local vision model.\n\n" +
        "⚠️ 安全限制：\n" +
        "- 仅支持公网 HTTP/HTTPS 地址\n" +
        "- 禁止访问 file://、内网 IP、localhost\n" +
        "- 禁止读取本地文件或系统配置\n" +
        "- 禁止扫描内网服务",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to download content from." },
          mediaType: {
            type: "string",
            enum: ["auto", "video", "image", "text", "audio"],
            description: 'Content type hint. "text" extracts page content (tweets, posts, articles).',
            default: "auto",
          },
          title: { type: "string", description: "Topic/title for organizing files." },
          format: { type: "string", description: 'Video format e.g. "best", "mp4", "720p".' },
          extractAudio: { type: "boolean", description: "Extract audio only (mp3)." },
          extractAudioTrack: { type: "boolean", description: "After download, extract audio track as mp3." },
          transcribe: { type: "boolean", description: "Transcribe audio to text via Whisper (GPU)." },
          analyze: { type: "boolean", description: "Analyze video content with local vision model." },
        },
        required: ["url"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== "download") {
    throw new Error(`Unknown tool: ${name}`);
  }

  const parsed = DownloadParamsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments: ${parsed.error.message}`);
  }

  const { url, mediaType, title, format, extractAudio, extractAudioTrack, transcribe, analyze } = parsed.data;

  try {
    const result = await kit.download({
      url,
      mediaType,
      title,
      format,
      extractAudio,
      extractAudioTrack,
      transcribe,
    });

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Download failed: ${result.error ?? "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }

    // Build response text — mask local paths for privacy
    const lines: string[] = [];
    lines.push(`Downloaded ${result.files.length} file(s) via ${result.method}:`);
    for (const f of result.files) {
      const safePath = f.path.replace(/^\/mnt\/[a-z]\//, "D:\\").replace(/^\/home\/[^/]+\//, "~/");
      lines.push(`  [${f.type}] ${safePath}`);
    }
    if (result.warning) {
      lines.push(`Warning: ${result.warning}`);
    }
    if (result.text) {
      lines.push("");
      lines.push("--- Content ---");
      lines.push(result.text);
    }
    lines.push("");
    lines.push(`Duration: ${result.durationMs}ms`);

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
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
