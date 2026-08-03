/**
 * Chrome DevTools Protocol client — standalone, no framework dependencies.
 *
 * Handles:
 * - Chrome auto-start + profile cleanup
 * - CDP HTTP endpoints (bypass proxy for localhost)
 * - Tab open/close + orphan cleanup
 * - Cookie extraction + Netscape cookie file generation
 * - JS evaluation (Runtime.evaluate)
 * - Video CDN URL interception + download through proxy
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { MediaKitConfig } from "./types.js";
import { logWarn } from "./utils.js";

const execFileAsync = promisify(execFile);

const COOKIE_CACHE_TTL_MS = 30 * 60 * 1000;
const CHROME_READY_POLL_MS = 1000;
const CHROME_READY_TIMEOUT_MS = 15_000;

// ── Chrome process management ──

function findChromeExe(config?: MediaKitConfig): string | null {
  // 1. Config explicit path (highest priority)
  if (config?.chromeExecutablePath) {
    try {
      fs.accessSync(config.chromeExecutablePath, fs.constants.X_OK);
      return config.chromeExecutablePath;
    } catch {
      /* fall through */
    }
  }
  // 2. Environment variable
  const envPath = process.env.CHROME_PATH?.trim();
  if (envPath) {
    try {
      fs.accessSync(envPath, fs.constants.X_OK);
      return envPath;
    } catch {
      /* configured path not accessible, fall through */
    }
  }
  // 3. Known locations (Windows Chrome first for WSL2 login sessions)
  const candidates = [
    // Windows (native)
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    // Windows (WSL2)
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    // Linux
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      continue;
    }
  }
  return null;
}

function isWindowsChromePath(chromePath: string): boolean {
  return chromePath.startsWith("/mnt/") || /^[A-Za-z]:[\\/]/.test(chromePath);
}

function resolveChromeUserDataDir(config?: MediaKitConfig): string {
  if (config?.chromeUserDataDir) {
    fs.mkdirSync(config.chromeUserDataDir, { recursive: true });
    return config.chromeUserDataDir;
  }
  // WSL2: prefer Windows-side user-data-dir (Windows Chrome needs a Win path)
  if (isWsl()) {
    const winUser = findWslWindowsUser();
    if (winUser) {
      const winDir = `/mnt/c/Users/${winUser}/.media-kit/browser/user-data`;
      fs.mkdirSync(winDir, { recursive: true });
      return winDir;
    }
  }
  // Linux fallback: ~/.media-kit/browser/user-data
  const base = process.env.HOME || "/root";
  const dir = path.join(base, ".media-kit", "browser", "user-data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isWsl(): boolean {
  try {
    return fs.readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function findWslWindowsUser(): string | null {
  try {
    const users = fs.readdirSync("/mnt/c/Users");
    for (const u of users) {
      if (["Public", "Default", "Default User", "All Users", "desktop.ini"].includes(u)) continue;
      if (u.startsWith("defaultuser")) continue;
      if (fs.existsSync(`/mnt/c/Users/${u}/NTUSER.DAT`)) return u;
    }
  } catch { /* not accessible */ }
  return null;
}

function cleanChromeProfile(userDataDir: string) {
  for (const name of ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try { fs.unlinkSync(path.join(userDataDir, name)); } catch { /* not present */ }
  }

  const prefsPath = path.join(userDataDir, "Default", "Preferences");
  try {
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8")) as Record<string, unknown>;
      prefs.exit_type = "Normal";
      prefs.exited_cleanly = true;
      if (typeof prefs.profile === "object" && prefs.profile !== null) {
        (prefs.profile as Record<string, unknown>).exit_type = "Normal";
        (prefs.profile as Record<string, unknown>).exited_cleanly = true;
      }
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch { /* best-effort */ }

  const localStatePath = path.join(userDataDir, "Local State");
  try {
    if (fs.existsSync(localStatePath)) {
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf-8")) as Record<string, unknown>;
      const profile = localState.profile as Record<string, unknown> | undefined;
      if (typeof profile === "object" && profile !== null) {
        if (profile.exit_type === "Crashed" || profile.exit_type === "SessionExited") {
          profile.exit_type = "Normal";
          fs.writeFileSync(localStatePath, JSON.stringify(localState));
        }
      }
    }
  } catch { /* best-effort */ }
}

/** Check if Chrome CDP is already listening on the given port */
export async function isCdpReady(cdpPort: number): Promise<boolean> {
  try {
    const res = await cdpFetch(`http://127.0.0.1:${cdpPort}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Kill Chrome processes launched with a specific user-data-dir (WSL2 or Linux) */
async function killChromeByUserDataDir(userDataDir: string): Promise<void> {
  try {
    if (process.platform === "linux" && fs.existsSync("/proc/version")) {
      const version = fs.readFileSync("/proc/version", "utf-8");
      if (version.toLowerCase().includes("microsoft")) {
        // WSL2: find Chrome PIDs that match our user-data-dir, then taskkill those only
        try {
          const { stdout } = await execFileAsync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${userDataDir.replace(/\//g, "\\\\")}*' } | Select-Object -ExpandProperty ProcessId`,
            ],
            { timeout: 10000 },
          );
          const pids = stdout
            .split(/\r?\n/)
            .map((l) => parseInt(l.trim(), 10))
            .filter((p) => !isNaN(p) && p > 0);
          for (const pid of pids) {
            try {
              await execFileAsync("/mnt/c/Windows/System32/taskkill.exe", ["/F", "/PID", String(pid)], { timeout: 5000 });
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        return;
      }
    }
    // Linux: pkill with --full to match user-data-dir in the command line
    const dirBasename = path.basename(userDataDir);
    try { await execFileAsync("pkill", ["-9", "-f", `chrome.*${dirBasename}`]); } catch { /* no match */ }
    try { await execFileAsync("pkill", ["-9", "-f", `chromium.*${dirBasename}`]); } catch { /* no match */ }
  } catch { /* ignore */ }
}

/**
 * Ensure Chrome is running with CDP enabled.
 * - If CDP port is alive → reuse (don't kill, keep cookies/sessions)
 * - If CDP port is temporarily unresponsive → retry up to 3 times with backoff
 * - If truly dead → restart Chrome for this profile only (preserve disk cookies)
 */
export async function ensureChromeRunning(cdpPort: number, config?: MediaKitConfig): Promise<boolean> {
  if (await isCdpReady(cdpPort)) return true;

  // Retry CDP check a few times before killing — Chrome may be briefly unresponsive
  for (let attempt = 1; attempt <= 3; attempt++) {
    logWarn(`[cdp-client] CDP not responding on port ${cdpPort}; retry ${attempt}/3 in ${attempt * 2}s`);
    await new Promise((r) => setTimeout(r, attempt * 2000));
    if (await isCdpReady(cdpPort)) return true;
  }

  logWarn("[cdp-client] CDP still not responding; restarting Chrome for this profile only");
  const userDataDir = resolveChromeUserDataDir(config);
  await killChromeByUserDataDir(userDataDir);
  await new Promise((r) => setTimeout(r, 3000));

  const chromeExe = findChromeExe(config);
  if (!chromeExe) {
    logWarn("[cdp-client] ⚠️ 没有找到可用的浏览器 (Chrome/Edge/Brave/Chromium)。请安装 Chrome 或设置 CHROME_PATH 环境变量指定浏览器路径");
    return false;
  }

  cleanChromeProfile(userDataDir);

  let chromeUserDataDir = userDataDir;
  if (userDataDir.startsWith("/mnt/")) {
    const driveLetter = userDataDir.charAt(5).toUpperCase();
    chromeUserDataDir = userDataDir.slice(6).replace(/\//g, "\\");
    chromeUserDataDir = `${driveLetter}:${chromeUserDataDir}`;
  }

  const isWindowsExe = isWindowsChromePath(chromeExe);
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeUserDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
    "--disable-dev-shm-usage",
    "--disable-infobars",
    "--disable-automation",
    "--no-startup-window",
    ...(config?.chromeExtraArgs ?? []),
  ];
  if (isWindowsExe) {
    // Windows Chrome from WSL2: bind on all interfaces so WSL2 can reach it
    args.unshift("--remote-debugging-address=0.0.0.0");
  } else {
    // Linux Chrome in WSL2/Docker: run headless (no display needed)
    args.push("--headless=new");
  }
  // Only set proxy when explicitly configured; no hardcoded fallback
  if (config?.proxyUrl) {
    args.push(`--proxy-server=${config.proxyUrl}`);
  }

  spawn(chromeExe, args, { stdio: "ignore", detached: true }).unref();

  // Wait for CDP to become ready
  const deadline = Date.now() + CHROME_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CHROME_READY_POLL_MS));
    if (await isCdpReady(cdpPort)) {
      // Open a persistent keeper tab so Chrome stays alive when working tabs close
      try { await cdpFetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`); } catch { /* ignore */ }
      return true;
    }
  }

  logWarn(`[cdp-client] Chrome CDP did not become ready on port ${cdpPort} within ${CHROME_READY_TIMEOUT_MS}ms`);
  return false;
}

// ── CDP HTTP helpers (bypass proxy for localhost) ──

/** fetch() that bypasses HTTP_PROXY for localhost CDP calls */
export function cdpFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    return fetch(url, init);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: (init?.method as string) || "GET",
        headers: init?.headers as Record<string, string> | undefined,
        agent: new http.Agent(),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve(new Response(body, { status: res.statusCode ?? 200, headers: res.headers as HeadersInit }));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Open a new CDP browser tab */
export async function cdpOpenTab(
  browserBaseUrl: string,
  targetUrl: string,
): Promise<{ tabId: string; wsUrl: string } | null> {
  const res = await cdpFetch(`${browserBaseUrl}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  if (!res.ok) return null;
  const tabInfo = (await res.json()) as { id?: string; webSocketDebuggerUrl?: string };
  const tabId = tabInfo.id ?? "";
  const wsUrl = tabInfo.webSocketDebuggerUrl ?? "";
  return tabId && wsUrl ? { tabId, wsUrl } : null;
}

/** Close a CDP browser tab */
export async function cdpCloseTab(browserBaseUrl: string, tabId: string): Promise<void> {
  try {
    await cdpFetch(`${browserBaseUrl}/json/close/${tabId}`);
  } catch { /* ignore */ }
}

/** Close all remaining page/worker tabs (orphaned after closing the main tab) */
export async function closeOrphanedTabs(browserBaseUrl: string): Promise<void> {
  try {
    const res = await cdpFetch(`${browserBaseUrl}/json/list`);
    if (!res.ok) return;
    const tabs = (await res.json()) as Array<{ id: string; type: string }>;
    for (const tab of tabs) {
      // Only close worker/service_worker orphans — never close page tabs
      // (user may have manual tabs open, and closing all pages can kill Chrome)
      if (tab.type === "worker" || tab.type === "service_worker") {
        await cdpCloseTab(browserBaseUrl, tab.id);
      }
    }
  } catch { /* ignore */ }
}

/** Keep Chrome process alive: if no page tabs remain, open about:blank */
async function keepBrowserAlive(browserBaseUrl: string): Promise<void> {
  try {
    const res = await cdpFetch(`${browserBaseUrl}/json/list`);
    if (!res.ok) return;
    const tabs = (await res.json()) as Array<{ type: string }>;
    const hasPage = tabs.some((t) => t.type === "page");
    if (!hasPage) {
      await cdpFetch(`${browserBaseUrl}/json/new?about:blank`, { method: "PUT" });
    }
  } catch { /* ignore */ }
}

// ── Cookie management ──

interface CachedCookies {
  cookies: string;
  domain: string;
  expiresAt: number;
}

const cookieCache = new Map<string, CachedCookies>();

const COOKIE_CACHE_FILE = path.join(os.tmpdir(), "openclaw-cdp-cookie-cache.json");

function loadCookieCacheFromDisk(): void {
  try {
    if (fs.existsSync(COOKIE_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(COOKIE_CACHE_FILE, "utf-8")) as Array<CachedCookies>;
      const now = Date.now();
      for (const entry of data) {
        if (entry.expiresAt > now) {
          cookieCache.set(entry.domain, entry);
        }
      }
    }
  } catch { /* ignore */ }
}

function saveCookieCacheToDisk(): void {
  try {
    const entries = Array.from(cookieCache.values()).filter((e) => e.expiresAt > Date.now());
    fs.writeFileSync(COOKIE_CACHE_FILE, JSON.stringify(entries));
  } catch { /* ignore */ }
}

loadCookieCacheFromDisk();

/** Get cookies for a URL via CDP (with 30min cache) */
export async function cdpGetCookies(browserBaseUrl: string, url: string): Promise<string> {
  const domain = new URL(url).hostname;
  if (!domain) return "";

  const cached = cookieCache.get(domain);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.cookies;
  }

  let tabId = "";
  let wsUrl = "";
  try {
    const tab = await cdpOpenTab(browserBaseUrl, url);
    if (!tab) {
      logWarn("[cdp-client] CDP cookie tab open failed");
      return "";
    }
    tabId = tab.tabId;
    wsUrl = tab.wsUrl;
  } catch (err) {
    logWarn(`[cdp-client] CDP cookie tab error: ${String(err)}`);
    return "";
  }

  await new Promise((resolve) => setTimeout(resolve, 4000));

  const cookies = await new Promise<string>((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve(""); }, 10_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Network.getCookies", params: { urls: [url] } }));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as {
        id?: number;
        result?: { cookies?: Array<{ name: string; value: string; domain: string; path: string }> };
      };
      if (msg.id === 1 && msg.result?.cookies) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result.cookies.map((c) => `${c.name}=${c.value}`).join("; "));
      }
    });

    ws.addEventListener("error", () => { clearTimeout(timer); resolve(""); });
  });

  await cdpCloseTab(browserBaseUrl, tabId);
  await closeOrphanedTabs(browserBaseUrl);
  await keepBrowserAlive(browserBaseUrl);

  if (cookies) {
    cookieCache.set(domain, { cookies, domain, expiresAt: Date.now() + COOKIE_CACHE_TTL_MS });
    saveCookieCacheToDisk();
  }

  return cookies;
}

/** Write cookie header string to a Netscape cookie file for yt-dlp */
export async function writeCookiesToFile(cookies: string, domain: string): Promise<string | null> {
  if (!cookies) return null;
  const tmpDir = os.tmpdir();
  const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, "_");
  const cookiePath = path.join(tmpDir, `ytdlp-cookies-${safeDomain}.txt`);
  const lines = [
    "# Netscape HTTP Cookie File",
    "# This is a generated file!  Do not edit.",
    "",
  ];
  const cookieDomain = domain.startsWith(".") ? domain : `.${domain}`;
  for (const pair of cookies.split("; ")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const name = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    lines.push(`${cookieDomain}\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
  }
  try {
    await fs.promises.writeFile(cookiePath, lines.join("\n") + "\n", "utf-8");
    return cookiePath;
  } catch {
    return null;
  }
}

/** Get cookies and write to file — convenience wrapper */
export async function getCookiesFile(
  browserBaseUrl: string | undefined,
  url: string,
): Promise<string | undefined> {
  if (!browserBaseUrl) return undefined;
  try {
    const domain = new URL(url).hostname;
    const cookieHeader = await cdpGetCookies(browserBaseUrl, url);
    if (cookieHeader && domain) {
      return (await writeCookiesToFile(cookieHeader, domain)) ?? undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

// ── JS Evaluation ──

/** Evaluate a JS expression in a CDP tab */
export async function cdpEvaluate(wsUrl: string, expression: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => { ws.close(); reject(new Error("CDP evaluate timeout")); }, timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as {
        id?: number;
        result?: { result?: { value?: string } };
      };
      if (msg.id === id) {
        clearTimeout(timer);
        ws.close();
        resolve(msg.result?.result?.value ?? "");
      }
    });

    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket error")); });
  });
}

// ── Video CDN interception + download ──

function isVideoUrl(reqUrl: string): boolean {
  return (
    (reqUrl.includes("douyinvod") || reqUrl.includes("video/tos") ||
     (reqUrl.includes("sns-video") && reqUrl.includes(".mp4")) ||
     reqUrl.includes("/stream/")) &&
    !reqUrl.includes(".js") && !reqUrl.includes(".css") && !reqUrl.includes(".json")
  );
}

function isAudioUrl(reqUrl: string): boolean {
  if (reqUrl.includes(".js") || reqUrl.includes(".css") || reqUrl.includes(".json")) return false;
  if (reqUrl.includes("byteaudio")) return true;
  if (reqUrl.includes("/audio/") && (reqUrl.includes(".m4a") || reqUrl.includes(".aac"))) return true;
  if (reqUrl.includes("douyinvod") && reqUrl.includes("/audio/")) return true;
  return false;
}

/** Open a URL in CDP, intercept Network requests to capture video+audio CDN URLs, then download */
export async function cdpExtractAndDownloadVideo(
  browserBaseUrl: string,
  url: string,
  outputDir: string,
  filename: string,
  proxyUrl?: string,
): Promise<{ ok: boolean; filePath?: string; audioFilePath?: string; error?: string; warning?: string }> {
  let tabId = "";
  let wsUrl = "";

  try {
    const tab = await cdpOpenTab(browserBaseUrl, url);
    if (!tab) return { ok: false, error: "CDP open tab failed" };
    tabId = tab.tabId;
    wsUrl = tab.wsUrl;
  } catch (err) {
    return { ok: false, error: `CDP open tab error: ${String(err)}` };
  }

  const videoUrls: string[] = [];
  const audioUrls: string[] = [];
  let pageTitle = "";
  let loginRedirect: string | null = null;

  const result = await new Promise<{ videoUrls: string[]; audioUrls: string[]; title: string; loginRedirect?: string }>((resolve) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const timer = setTimeout(() => {
      ws.close();
      resolve({ videoUrls, audioUrls, title: pageTitle, loginRedirect: loginRedirect ?? undefined });
    }, 25_000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: ++msgId, method: "Network.enable" }));
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)) as {
        id?: number;
        method?: string;
        params?: { request?: { url: string }; result?: { result?: { value?: string } } };
      };

      if (msg.method === "Network.requestWillBeSent") {
        const reqUrl = msg.params?.request?.url || "";
        if (isVideoUrl(reqUrl) && !videoUrls.some((u) => u.split("?")[0] === reqUrl.split("?")[0])) {
          videoUrls.push(reqUrl);
        }
        if (isAudioUrl(reqUrl) && !audioUrls.some((u) => u.split("?")[0] === reqUrl.split("?")[0])) {
          audioUrls.push(reqUrl);
        }
      }

      // Detect login redirects
      if (msg.method === "Network.requestWillBeSent" && msg.params?.request?.url) {
        const navUrl = msg.params.request.url as string;
        if (navUrl !== url && (navUrl.includes("/login") || navUrl.includes("/signin") || navUrl.includes("/auth"))) {
          loginRedirect = navUrl;
          logWarn(`[cdp-client] Page redirected to login: ${navUrl.slice(0, 100)}`);
        }
      }

      // After Network.enable, wait then extract title
      if (msg.id === 1) {
        setTimeout(() => {
          ws.send(JSON.stringify({
            id: ++msgId,
            method: "Runtime.evaluate",
            params: {
              expression: `
                (function() {
                  var title = '';
                  document.querySelectorAll('[data-e2e=video-desc], h1, .title, meta[property="og:title"]').forEach(function(el) {
                    var t = el.getAttribute('content') || el.textContent || '';
                    t = t.trim();
                    if (t.length > title.length) title = t;
                  });
                  return title || document.title || '';
                })()
              `,
              returnByValue: true,
            },
          }));
        }, 10_000);
      }

      if (msg.id === 2) {
        pageTitle = (msg.params as unknown as { result?: { result?: { value?: string } } })?.result?.result?.value || "";
      }

      // After title, check performance entries for missed video+audio URLs
      if (msg.id === 2) {
        setTimeout(() => {
          ws.send(JSON.stringify({
            id: ++msgId,
            method: "Runtime.evaluate",
            params: {
              expression: `
                (function() {
                  var result = { video: [], audio: [] };
                  if (performance.getEntriesByType) {
                    performance.getEntriesByType('resource').forEach(function(e) {
                      if (e.name.includes('douyinvod') || e.name.includes('video/tos')) result.video.push(e.name);
                      if (e.name.includes('byteaudio') || (e.name.includes('/audio/') && (e.name.includes('.m4a') || e.name.includes('.aac')))) result.audio.push(e.name);
                    });
                  }
                  return JSON.stringify(result);
                })()
              `,
              returnByValue: true,
            },
          }));
        }, 1000);
      }

      if (msg.id === 3) {
        try {
          const perfResult = JSON.parse(
            (msg.params as unknown as { result?: { result?: { value?: string } } })?.result?.result?.value || '{"video":[],"audio":[]}',
          ) as { video: string[]; audio: string[] };
          for (const u of perfResult.video) {
            if (!videoUrls.some((v) => v.split("?")[0] === u.split("?")[0])) {
              videoUrls.push(u);
            }
          }
          for (const u of perfResult.audio) {
            if (!audioUrls.some((v) => v.split("?")[0] === u.split("?")[0])) {
              audioUrls.push(u);
            }
          }
        } catch { /* ignore */ }
        clearTimeout(timer);
        ws.close();
        resolve({ videoUrls, audioUrls, title: pageTitle, loginRedirect: loginRedirect ?? undefined });
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ videoUrls, audioUrls, title: pageTitle, loginRedirect: loginRedirect ?? undefined });
    });
  });

  await cdpCloseTab(browserBaseUrl, tabId);
  await closeOrphanedTabs(browserBaseUrl);
  await keepBrowserAlive(browserBaseUrl);

  if (result.videoUrls.length === 0) {
    const loginHint = result.loginRedirect
      ? ` Page redirected to login (${result.loginRedirect.slice(0, 80)}). Browser is kept open — please log in via Chrome and retry.`
      : "";
    return { ok: false, error: `No video CDN URLs captured from page.${loginHint}` };
  }

  const videoUrl = result.videoUrls[0];
  const safeTitle = (result.title || filename || "video")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .substring(0, 80);
  const filePath = path.join(outputDir, `${safeTitle}.mp4`);

  await fs.promises.mkdir(outputDir, { recursive: true });

  const downloaded = await downloadThroughProxy(videoUrl, filePath, proxyUrl, url);
  if (!downloaded) {
    return { ok: false, error: "Video download failed" };
  }

  let audioFilePath: string | undefined;
  if (result.audioUrls.length > 0) {
    const audioUrl = result.audioUrls[0];
    const audioExt = audioUrl.includes(".m4a") ? ".m4a" : audioUrl.includes(".aac") ? ".aac" : ".m4a";
    const audioPath = path.join(outputDir, `${safeTitle}_audio${audioExt}`);
    const audioDownloaded = await downloadThroughProxy(audioUrl, audioPath, proxyUrl, url);
    if (audioDownloaded) {
      audioFilePath = audioPath;
    }
  }

  return {
    ok: true,
    filePath,
    audioFilePath,
    warning: result.loginRedirect
      ? `Page was redirected to login (${result.loginRedirect.slice(0, 80)}). Download succeeded using existing session cookies.`
      : undefined,
  };
}

// ── File download through HTTP proxy ──

async function downloadThroughProxy(
  fileUrl: string,
  destPath: string,
  proxyUrl?: string,
  referer?: string,
): Promise<boolean> {
  try {
    if (proxyUrl) {
      const proxyParsed = new URL(proxyUrl);
      const fileParsed = new URL(fileUrl);
      const body = await new Promise<Buffer>((resolve, reject) => {
        const req = http.request(
          {
            hostname: proxyParsed.hostname,
            port: proxyParsed.port,
            path: fileUrl,
            method: "GET",
            headers: {
              Host: fileParsed.hostname,
              "User-Agent": "Mozilla/5.0",
              Referer: referer || "",
            },
          },
          (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              downloadFileDirect(res.headers.location, destPath, referer).then(() => resolve(Buffer.alloc(0))).catch(reject);
              return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          },
        );
        req.on("error", reject);
        req.setTimeout(120_000, () => { req.destroy(); reject(new Error("download timeout")); });
        req.end();
      });
      if (body.length > 1000) {
        await fs.promises.writeFile(destPath, body);
        return true;
      }
      // Redirect handler may have already written the file
      try {
        const stat = await fs.promises.stat(destPath);
        if (stat.size > 1000) return true;
      } catch { /* not written yet */ }
    }

    return downloadFileDirect(fileUrl, destPath, referer);
  } catch {
    return false;
  }
}

async function downloadFileDirect(url: string, destPath: string, referer?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0" };
    if (referer) headers.Referer = referer;
    const resp = await fetch(url, { redirect: "follow", headers });
    if (!resp.ok) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1000) return false;
    await fs.promises.writeFile(destPath, buf);
    return true;
  } catch {
    return false;
  }
}
