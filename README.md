# MediaKit

Standalone media download toolkit. Zero framework dependencies.

## Features

- **1800+ platforms** via yt-dlp (YouTube, Twitter/X, Instagram, TikTok, etc.)
- **Chinese platforms** via CDP network interception (Douyin, Xiaohongshu, Bilibili, etc.)
- **Audio extraction** from video via ffmpeg
- **Whisper transcription** via local GPU
- **Video+audio merge** for DASH-separated streams
- **Auto compression** for files over 20MB

## Quick Start

```ts
import { MediaKit } from "media-kit";

const kit = new MediaKit({
  browserBaseUrl: "http://127.0.0.1:9333",
  proxyUrl: "http://127.0.0.1:2080",
});

// Download video
const result = await kit.download({
  url: "https://v.douyin.com/xxx/",
  transcribe: true,
});

if (result.ok) {
  console.log("Files:", result.files);
  console.log("Transcript:", result.text);
}
```

## Requirements

- Node.js 22+
- `yt-dlp` binary
- `ffmpeg` / `ffprobe` binary
- Chrome with `--remote-debugging-port=9333` (for CDP-based extraction)

## API

### `new MediaKit(config?)`

| Option | Default | Description |
|--------|---------|-------------|
| `browserBaseUrl` | `http://127.0.0.1:9333` | Chrome CDP address |
| `proxyUrl` | `""` | HTTP proxy URL |
| `outputDir` | `/mnt/d/Download/original_video` | Default download directory |
| `chromeExecutablePath` | auto | Chrome binary path |
| `chromeExtraArgs` | `[]` | Extra Chrome flags |
| `chromeUserDataDir` | auto | Chrome profile directory |

### `kit.download(options)`

| Option | Default | Description |
|--------|---------|-------------|
| `url` | required | URL to download |
| `outputDir` | config default | Override output directory |
| `title` | auto | Title for file naming |
| `mediaType` | `"auto"` | `"video"` / `"audio"` / `"image"` / `"text"` |
| `extractAudio` | `false` | Extract audio only (mp3) |
| `extractAudioTrack` | `false` | Also extract mp3 from video |
| `transcribe` | `false` | Transcribe audio via Whisper |

## Build

```bash
npm install
npm run build
```
