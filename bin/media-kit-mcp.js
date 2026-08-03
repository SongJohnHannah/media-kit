#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = resolve(__dirname, "../src/mcp-server.ts");

// Resolve tsx CLI from the local node_modules (works on Windows, where
// spawning the `npx` .cmd shim via spawn() fails with ENOENT).
const require = createRequire(import.meta.url);
let tsxCli;
try {
  tsxCli = require.resolve("tsx/cli");
} catch {
  tsxCli = require.resolve("tsx/dist/cli.mjs");
}

const proc = spawn(process.execPath, [tsxCli, serverScript], {
  stdio: "inherit",
  env: { ...process.env },
});

proc.on("exit", (code) => process.exit(code ?? 1));
proc.on("error", (err) => {
  console.error("Failed to start media-kit MCP server:", err.message);
  process.exit(1);
});
