# MediaKit

Standalone media download toolkit + MCP server for Claude Code.

CDP 浏览器 + yt-dlp 双引擎，支持 1800+ 平台视频/音频/图片/文字下载。通过 MCP 协议暴露给 Claude Code，作为 web_fetch 被拦截时的兜底方案。

## Features

- **1800+ platforms** via yt-dlp (YouTube, Twitter/X, Instagram, TikTok, etc.)
- **Chinese platforms** via CDP browser (Douyin, Xiaohongshu, Bilibili, etc.)
- **Anti-blocking** — CDP real browser bypasses most anti-scraping measures
- **Audio extraction** from video via ffmpeg
- **Whisper transcription** via local GPU
- **Video frame analysis** via Ollama/Gemma 4 vision model
- **MCP server** — exposes 4 tools to Claude Code

## MCP Server

4 tools exposed to Claude Code:

| Tool | Purpose | When to use |
|------|---------|-------------|
| `download` | Download videos/audio/images | Last resort — use when web_fetch gets blocked |
| `read` | Extract text from webpages | Last resort — when web_fetch returns 403/blank/captcha |
| `browse` | Open URL in Chrome browser | When you need to see/interact with a page manually |
| `screenshot` | Capture webpage screenshot | To preview page layout or save a snapshot |

All tools work via Chrome CDP (real browser), so they bypass anti-scraping protections.

## Quick Start

### 1. Install

```bash
cd ~/www/mediaKit
npm install
npm run build        # build dist/
npm link             # register media-kit-mcp command globally
```

### 2. Configure MCP (for Claude Code)

In `~/.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "media-kit": {
      "command": "media-kit-mcp"
    }
  }
}
```

### 3. Use in Claude

```
你: 这个 X 帖子被拦截了，用 read 工具看看
→ Claude 自动调 mediaKit read 通过 CDP 浏览器读取

你: 下载这个抖音视频
→ Claude 自动调 mediaKit download
```

## Library Usage

```ts
import { MediaKit } from "media-kit";

const kit = new MediaKit({
  browserBaseUrl: "http://127.0.0.1:9333",
});

// Download video + transcribe
const result = await kit.download({
  url: "https://v.douyin.com/xxx/",
  transcribe: true,
});
if (result.ok) {
  console.log("Files:", result.files);
  console.log("Transcript:", result.text);
}

// Read webpage text
const text = await kit.download({
  url: "https://x.com/user/status/xxx",
  mediaType: "text",
});
```

## Config

### Constructor options

| Option | Default | Description |
|--------|---------|-------------|
| `browserBaseUrl` | `http://127.0.0.1:9333` | Chrome CDP address |
| `proxyUrl` | `""` | HTTP proxy URL |
| `outputDir` | `/mnt/d/Download` | Default download directory |
| `chromeExecutablePath` | auto-detected | Chrome/Edge/Brave binary |
| `chromeExtraArgs` | `[]` | Extra Chrome flags |
| `chromeUserDataDir` | `~/.media-kit/browser/user-data` | Chrome profile directory |

### Environment variables (MCP server)

| Variable | Default | Description |
|----------|---------|-------------|
| `MEDIAKIT_BROWSER_URL` | `http://127.0.0.1:9333` | CDP URL |
| `MEDIAKIT_PROXY_URL` | none | HTTP proxy |
| `MEDIAKIT_OUTPUT_DIR` | `/mnt/d/Download` | Download directory |
| `CHROME_PATH` | auto-detect | Chrome executable path |

### download() options

| Option | Default | Description |
|--------|---------|-------------|
| `url` | required | URL to download |
| `mediaType` | `"auto"` | `"video"` / `"audio"` / `"image"` / `"text"` |
| `title` | auto | Title for file naming |
| `format` | auto | Video format: `"best"`, `"mp4"`, `"720p"` |
| `extractAudio` | `false` | Extract audio only (mp3) |
| `extractAudioTrack` | `false` | Also extract mp3 from video |
| `transcribe` | `false` | Transcribe audio via Whisper |
| `analyze` | `false` | Analyze video frames via Ollama vision model |

## Browser Management

- **Preference**: Windows Chrome (for WSL2 login sessions) → Linux Chrome (headless)
- **Cold start**: ~15s (retry×3 → launch Chrome → ready)
- **Reuse**: ~8ms (CDP check only, no polling)
- **Lifetime**: Chrome stays running until manually killed

Supported browsers: Chrome, Chromium, Edge, Brave (auto-detected).

## Safety

- Blocks `file://` / `data://` / `ftp://` protocols
- Blocks private IP ranges (SSRF protection)
- Blocks localhost access
- Only public HTTP/HTTPS URLs allowed
- Local file paths masked in output

## Requirements

- Node.js 22+
- `yt-dlp` binary (for video downloads)
- `ffmpeg` / `ffprobe` binary (for audio extraction)
- Chrome / Edge / Chromium / Brave (for CDP browser mode)
- (Optional) Ollama with vision model for `analyze`
- (Optional) Whisper for `transcribe`

## License

MIT
