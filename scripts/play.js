// Starts the game server and opens it in the browser. Ctrl+C stops everything.
//
//   node scripts/play.js             start and open the browser
//   node scripts/play.js --cli       play in this terminal instead (text mode; /quit to exit)
//   node scripts/play.js --no-open   start without opening a browser

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 3000);
const URL = `http://127.0.0.1:${PORT}`;
const LLAMA_SERVER = process.env.LLAMA_SERVER || path.join(ROOT, "runtime", "llama.cpp", process.platform === "win32" ? "llama-server.exe" : "llama-server");
const MODELS_DIR = path.join(ROOT, "models");
const CLI = process.argv.slice(2).some((a) => a === "--cli" || a === "cli");

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

async function isRunning() {
  try {
    const r = await fetch(`${URL}/api/models`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  if (process.argv.includes("--no-open")) return;
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", URL]] : process.platform === "darwin" ? ["open", [URL]] : ["xdg-open", [URL]];
  spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) fail(`Node ${process.versions.node} is too old. Install Node 20+ from https://nodejs.org`);
  if (!fs.existsSync(LLAMA_SERVER)) fail("llama.cpp isn't installed yet. Run install.bat first (or: npm run setup).");
  const models = fs.existsSync(MODELS_DIR) ? fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith(".gguf")) : [];
  if (!models.length) fail("No models downloaded yet. Run install.bat first, or wait for the running download to finish one model.");

  let server = null;
  if (await isRunning()) {
    if (!CLI) {
      console.log(`The game is already running at ${URL}. Opening it.`);
      openBrowser();
      return;
    }
  } else {
    console.log(`Starting Bramblewick with ${models.length} model(s) available…`);
    server = startServer();
    if (!(await waitForServer())) {
      server.kill();
      fail(`The server didn't start. Is something else using port ${PORT}? Set PORT to use another one.`);
    }
  }

  if (CLI) {
    const { runCli } = await import("./cli.js");
    try {
      await runCli(URL);
    } catch (e) {
      console.error(`\n${e.message}`);
    }
    if (server) await shutdown(server);
    process.exit(0);
  }

  console.log(`\nPlay at ${URL}   (Ctrl+C to stop)\n`);
  openBrowser();
}

// Browser mode shows the server's output here. Text mode sends it to logs/server.log so it
// doesn't interleave with the conversation.
function startServer() {
  let stdio = "inherit";
  if (CLI) {
    fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
    const log = fs.openSync(path.join(ROOT, "logs", "server.log"), "a");
    stdio = ["ignore", log, log];
  }
  const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, stdio });
  server.on("exit", (code) => {
    if (CLI && !shuttingDown) console.error(`\nThe game server stopped unexpectedly (code ${code}). See logs/server.log.`);
    process.exit(code ?? 0);
  });
  // Browser mode: Ctrl+C reaches the server too (same console); it unloads the model and exits, then we follow.
  process.on("SIGINT", () => {});
  return server;
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    if (await isRunning()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Unload the model first so llama-server exits cleanly; killing the Node server alone on Windows
// would leave its child running.
let shuttingDown = false;
async function shutdown(server) {
  shuttingDown = true;
  try {
    await fetch(`${URL}/api/models/unload`, { method: "POST", signal: AbortSignal.timeout(20_000) });
  } catch {
    // Server already gone; nothing left to unload.
  }
  server.kill();
}

main();
