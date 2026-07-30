/**
 * CDP screenshot utility — capture a webpage screenshot via Chrome DevTools Protocol.
 */
import fs from "node:fs";
import path from "node:path";
import { cdpOpenTab, cdpFetch, cdpCloseTab } from "./index.js";

/**
 * Capture a full-page screenshot via CDP.
 * Returns the file path of the saved PNG, or null on failure.
 */
export async function cdpScreenshot(
  browserBaseUrl: string,
  url: string,
  outputDir: string,
): Promise<string | null> {
  let tabId = "";

  try {
    const tab = await cdpOpenTab(browserBaseUrl, url);
    if (!tab) return null;
    tabId = tab.tabId;

    // Wait for page to load
    await new Promise((r) => setTimeout(r, 3000));

    // Connect via WebSocket to capture screenshot
    const wsUrl = tab.wsUrl;

    const screenshotBase64 = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 15000);

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ id: 1, method: "Page.enable" }));
      });

      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as {
          id?: number; result?: { data?: string };
        };
        if (msg.id === 1) {
          // Page enabled, now capture screenshot
          ws.send(JSON.stringify({
            id: 2,
            method: "Page.captureScreenshot",
            params: { format: "png", fullPage: true },
          }));
        }
        if (msg.id === 2 && msg.result?.data) {
          clearTimeout(timer);
          ws.close();
          resolve(msg.result.data);
        }
      });

      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws error")); });
    });

    // Save to file
    const timestamp = new Date().toISOString().slice(0, 10);
    const safeDomain = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const dir = path.join(outputDir, timestamp);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${safeDomain}.png`);
    const buffer = Buffer.from(screenshotBase64, "base64");
    fs.writeFileSync(filePath, buffer);

    await cdpCloseTab(browserBaseUrl, tabId);
    return filePath;
  } catch {
    try { await cdpCloseTab(browserBaseUrl, tabId); } catch { /* ignore */ }
    return null;
  }
}
