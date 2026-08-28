import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const port = Number(process.env.PORT ?? 5176);
const apiUrl = `http://127.0.0.1:${port}/api/status`;
const timeoutMs = 30_000;
const retryMs = 200;

let server;
let client;
let shuttingDown = false;

function startNpmScript(name) {
  return spawn(npmCommand, ["run", name], {
    stdio: "inherit",
    env: process.env,
  });
}

function stopChild(child, signal) {
  if (child && !child.killed) child.kill(signal);
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild(client, signal);
  stopChild(server, signal);
  setTimeout(() => process.exit(0), 1_000).unref();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApi() {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`API server exited before becoming ready (exit code ${server.exitCode}).`);
    }

    try {
      const response = await fetch(apiUrl);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await wait(retryMs);
  }

  throw new Error(`Timed out waiting for API readiness at ${apiUrl}${lastError ? `: ${lastError}` : ""}`);
}

async function main() {
  server = startNpmScript("server");

  server.once("error", (error) => {
    console.error("[dev] Failed to start API server:", error);
    process.exit(1);
  });

  server.once("exit", (code, signal) => {
    if (!shuttingDown && !client) {
      console.error(`[dev] API server exited before readiness (${signal ?? `code ${code ?? 1}`}).`);
      process.exit(code ?? 1);
    }
  });

  try {
    await waitForApi();
  } catch (error) {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    shutdown("SIGTERM");
    process.exitCode = 1;
    return;
  }

  console.log(`[dev] API is ready at ${apiUrl}; starting Vite.`);
  client = startNpmScript("dev:client");

  client.once("error", (error) => {
    console.error("[dev] Failed to start Vite:", error);
    shutdown("SIGTERM");
    process.exitCode = 1;
  });

  client.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] Vite exited (${signal ?? `code ${code ?? 0}`}); stopping API server.`);
      shutdown("SIGTERM");
      process.exitCode = code ?? 0;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

main();
