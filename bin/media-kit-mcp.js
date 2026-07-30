#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = resolve(__dirname, "../src/mcp-server.ts");

const proc = spawn("npx", ["tsx", serverScript], {
  stdio: "inherit",
  env: { ...process.env },
});

proc.on("exit", (code) => process.exit(code ?? 1));
proc.on("error", (err) => {
  console.error("Failed to start media-kit MCP server:", err.message);
  process.exit(1);
});
