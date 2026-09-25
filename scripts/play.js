// Starts the game server and opens it in the browser. Ctrl+C stops everything.
//
//   node scripts/play.js             start and open the browser
//   node scripts/play.js --cli       play in this terminal instead (text mode; /quit to exit)
//   node scripts/play.js --discord   run the Discord bot (first run walks through setup; Ctrl+C closes the town)
//   node scripts/play.js --no-open   start without opening a browser

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 3000);
const URL = `http://127.0.0.1:${PORT}`;
const LLAMA_SERVER = process.env.LLAMA_SERVER || path.join(ROOT, "runtime", "llama.cpp", process.platform === "win32" ? "llama-server.exe" : "llama-server");
const MODELS_DIR = path.join(ROOT, "models");
const CLI = process.argv.slice(2).some((a) => a === "--cli" || a === "cli");
const DISCORD = process.argv.slice(2).some((a) => a === "--discord" || a === "discord");

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

  if (DISCORD) {
    await prepareDiscord();
    return runDiscord();
  }

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

// Browser mode shows the server's output here. Text mode and the Discord bot send it to
// logs/server.log so it doesn't interleave with the conversation or the bot's log.
function spawnServer() {
  let stdio = "inherit";
  if (CLI || DISCORD) {
    fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
    const log = fs.openSync(path.join(ROOT, "logs", "server.log"), "a");
    stdio = ["ignore", log, log];
  }
  return spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, stdio });
}

function startServer() {
  const server = spawnServer();
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

// ---- Discord bot ----------------------------------------------------------------------------

// The bot needs the discord.js library (the game itself needs nothing) and a bot token. Both are
// sorted out here the first time: the library is installed and the setup walks through the token.
async function prepareDiscord() {
  try {
    await import("discord.js");
  } catch {
    console.log("Installing the Discord library (one time)…");
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit", shell: true });
    if (r.status !== 0) fail("Couldn't install discord.js. Run npm install in this folder, then try again.");
  }
  const { needsSetup, runSetup } = await import("../discord/setup.js");
  if (needsSetup()) {
    try {
      await runSetup({ starting: true });
    } catch (e) {
      fail(e.message);
    }
  }
}

// Keeps the game server running for the bot: starts it (unless one is already running) and
// starts it again if it stops, backing off if it keeps stopping.
const supervisor = {
  child: null,
  crashes: 0,
  get running() {
    return !!this.child;
  },
  start() {
    if (this.child || shuttingDown) return;
    const child = spawnServer();
    const started = Date.now();
    this.child = child;
    child.on("exit", (code) => {
      this.child = null;
      if (shuttingDown) return;
      this.crashes = Date.now() - started > 60_000 ? 1 : this.crashes + 1;
      const wait = Math.min(60, 5 * 2 ** (this.crashes - 1));
      console.error(`The game server stopped (code ${code}); see logs/server.log. Starting it again in ${wait} s…`);
      setTimeout(() => this.start(), wait * 1000);
    });
  },
};

async function runDiscord() {
  if (!(await isRunning())) {
    console.log("Starting the game server…");
    supervisor.start();
    if (!(await waitForServer())) console.error(`The game server didn't start on port ${PORT} yet; the bot will keep trying. See logs/server.log.`);
  }

  const { createBot } = await import("../discord/bot.js");
  const bot = createBot({ base: URL, server: supervisor });
  const stop = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nClosing the town…");
    try {
      await bot.shutdown();
    } catch (e) {
      console.error(e.message);
    }
    const child = supervisor.child;
    if (child) {
      await shutdown(child);
      if (!(await exited(child, 5000))) child.kill("SIGKILL");
    }
    process.exit(code);
  };
  // Ctrl+C, closing the window (SIGHUP on Windows), Ctrl+Break, or a service manager stopping us.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => stop(0));

  console.log("Press Ctrl+C to close the town.");
  try {
    await bot.start();
  } catch (e) {
    console.error(`\n${e.message}`);
    await stop(1); // non-zero, so discord.bat keeps the window open to read this
  }
}

const exited = (child, ms) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    child.once("exit", () => resolve(true));
    setTimeout(() => resolve(false), ms);
  });

main();
