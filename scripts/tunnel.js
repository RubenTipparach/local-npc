// Mirrors the game running on this laptop to a public HTTPS link, view only, so people outside the
// laptop (the Discord table, say) can watch the town in a browser. The Discord bot puts the link in
// its status message and /status.
//
//   npm run tunnel                    use Cloudflare Tunnel or ngrok, whichever is installed
//   npm run tunnel -- --with ngrok    pick one
//   discord.bat --tunnel              start the link together with the bot (play.bat --tunnel too)
//
// Two pieces:
//   1. A mirror on this laptop (http://127.0.0.1:3001 by default, MIRROR_PORT to change it) that
//      passes through only what the town needs to be looked at, and turns away anything that
//      talks to a villager, changes the case or model, or uses the models through /v1. It also
//      hides each villager's system prompt, which would give the killer away.
//   2. A tunnel program (cloudflared or ngrok) that gives the mirror a public https:// address.
//      Only the mirror is ever published, never the game server itself.
//
// The Discord bot doesn't need any of this: it connects out to Discord and needs no public URL.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_URL_FILE = path.join(ROOT, "data", "public-url.json");
const GAME_PORT = Number(process.env.PORT || 3000);
export const MIRROR_PORT = Number(process.env.MIRROR_PORT || GAME_PORT + 1);

const VIEW_ONLY = "This is a view-only link to Bramblewick. Talk to the villagers in the Discord channel.";
const PROMPT_HIDDEN = "(Hidden on the shared link: a villager's instructions would give the case away.)";
const BANNER = `<div id="mirror-note" role="status" style="position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:1000;max-width:calc(100% - 32px);background:#1f2430;color:#f1ead8;font:14px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.35)">👀 You're watching Bramblewick from the host's laptop. This link is view only: talk to the villagers in Discord.</div>`;

// ---- the mirror -----------------------------------------------------------------------------

// A local server that passes the town's read-only requests through to the game server.
export function startMirror({ gameUrl = `http://127.0.0.1:${GAME_PORT}`, port = MIRROR_PORT } = {}) {
  const server = http.createServer((req, res) => handle(gameUrl, req, res).catch((e) => fail(res, e)));
  return new Promise((resolve, reject) => {
    server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`Port ${port} is taken. Set MIRROR_PORT to another port.`) : e));
    server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

async function handle(gameUrl, req, res) {
  const p = new URL(req.url, "http://mirror").pathname;
  const get = req.method === "GET" || req.method === "HEAD";
  // The page itself: HTML, scripts, styles, sprites.
  if (get && !/^\/(api|v1)(\/|$)/.test(p)) return pass(gameUrl, req, res, { banner: p === "/" || p === "/index.html" });
  // What the town reads to draw itself.
  if (get && ["/api/models", "/api/npcs", "/api/case"].includes(p)) return pass(gameUrl, req, res);
  if (get && /^\/api\/npcs\/[a-z0-9-]+$/.test(p)) return pass(gameUrl, req, res, { hidePrompt: true });
  // The page asks for a model when it opens. Fine if it's the one already loaded; the host picks.
  if (req.method === "POST" && p === "/api/models/load") {
    const { id } = await readJson(req);
    const { active } = await (await fetch(`${gameUrl}/api/models`)).json();
    if (active?.model?.id === id) return send(res, 200, { active });
    return send(res, 403, { error: "The host picks the model on this link." });
  }
  return send(res, 403, { error: VIEW_ONLY });
}

async function pass(gameUrl, req, res, { banner = false, hidePrompt = false } = {}) {
  const r = await fetch(gameUrl + req.url, { method: req.method });
  let body = Buffer.from(await r.arrayBuffer());
  if (banner && r.ok) body = Buffer.from(body.toString("utf8").replace("</body>", `${BANNER}</body>`));
  if (hidePrompt && r.ok) {
    const npc = JSON.parse(body.toString("utf8"));
    body = Buffer.from(JSON.stringify({ ...npc, systemPrompt: PROMPT_HIDDEN }));
  }
  res.writeHead(r.status, {
    "Content-Type": r.headers.get("content-type") || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Robots-Tag": "noindex",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

// The game server isn't answering: say so in words, as a page or as the API's usual error shape.
function fail(res, e) {
  if (res.headersSent) return res.end();
  const down = e?.message === "fetch failed";
  send(res, down ? 502 : 500, { error: down ? "Bramblewick is closed right now: the host's laptop isn't serving the game." : e.message });
}

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json", "X-Robots-Tag": "noindex" });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  let s = "";
  for await (const c of req) s += c;
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

// ---- the tunnel -----------------------------------------------------------------------------

const PROVIDERS = {
  cloudflared: {
    name: "Cloudflare Tunnel",
    args: (port) => ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
    url: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    install: "winget install --id Cloudflare.cloudflared   (then open a new terminal)",
  },
  ngrok: {
    name: "ngrok",
    args: (port) => ["http", String(port), "--log", "stdout", "--log-format", "logfmt"],
    url: /url=(https:\/\/[^\s"]+)/,
    install: "winget install --id Ngrok.Ngrok, then: ngrok config add-authtoken <your token from ngrok.com>",
  },
};

const installed = (cmd) => {
  try {
    return spawnSync(cmd, ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch {
    return false;
  }
};

// Starts cloudflared or ngrok pointed at the mirror and waits for its public URL.
export function startTunnel({ port = MIRROR_PORT, via } = {}) {
  const pick = via || Object.keys(PROVIDERS).find(installed);
  if (!pick || !PROVIDERS[pick] || (via && !installed(via))) {
    const list = Object.values(PROVIDERS).map((p) => `  ${p.name}: ${p.install}`).join("\n");
    return Promise.reject(new Error(`${via ? `${via} isn't installed.` : "No tunnel program is installed."} Install one of these:\n${list}`));
  }
  const provider = PROVIDERS[pick];
  const child = spawn(pick, provider.args(port), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${provider.name} didn't hand out a link within 30 s:\n${out.trim().split("\n").slice(-5).join("\n")}`));
    }, 30_000);
    const onData = (d) => {
      out = (out + d).slice(-8000);
      const m = provider.url.exec(out);
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.stdout.resume();
      child.stderr.resume();
      resolve({ url: (m[1] || m[0]).replace(/\/$/, ""), via: provider.name, child, close: () => child.kill() });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${provider.name} stopped (code ${code}):\n${out.trim().split("\n").slice(-5).join("\n")}`));
    });
  });
}

// ---- both together ---------------------------------------------------------------------------

// The mirror plus a tunnel to it. Records the link in data/public-url.json for the Discord bot, and
// forgets it again when closed or when this process exits.
export async function openTunnel({ gameUrl, port = MIRROR_PORT, via, onDrop } = {}) {
  const mirror = await startMirror({ gameUrl, port });
  let tunnel;
  try {
    tunnel = await startTunnel({ port, via });
  } catch (e) {
    await mirror.close();
    throw e;
  }
  fs.mkdirSync(path.dirname(PUBLIC_URL_FILE), { recursive: true });
  fs.writeFileSync(PUBLIC_URL_FILE, JSON.stringify({ url: tunnel.url, via: tunnel.via, mirror: mirror.url, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  const forget = () => fs.rmSync(PUBLIC_URL_FILE, { force: true });
  process.once("exit", forget);
  tunnel.child.once("exit", () => {
    forget();
    onDrop?.();
  });
  return {
    url: tunnel.url,
    via: tunnel.via,
    mirror: mirror.url,
    async close() {
      tunnel.child.removeAllListeners("exit");
      tunnel.close();
      forget();
      await mirror.close();
    },
  };
}

export function describe(link, gameUrl = `http://127.0.0.1:${GAME_PORT}`) {
  return [
    `Mirroring Bramblewick through ${link.via} (view only):`,
    `  ${gameUrl}/  ->  ${link.url}/`,
    "  Talking, cases, accusations, model switching and /v1 stay on this laptop.",
  ].join("\n");
}

// ---- npm run tunnel ------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const via = args.includes("--with") ? args[args.indexOf("--with") + 1] : undefined;
  const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : MIRROR_PORT;
  const gameUrl = `http://127.0.0.1:${GAME_PORT}`;
  try {
    await fetch(`${gameUrl}/api/models`, { signal: AbortSignal.timeout(1500) });
  } catch {
    console.log(`The game isn't running at ${gameUrl} yet. The link works as soon as it is (play.bat or discord.bat).`);
  }
  try {
    const link = await openTunnel({ gameUrl, port, via, onDrop: () => (console.error("\nThe tunnel closed."), process.exit(1)) });
    console.log(`\n${describe(link, gameUrl)}\n\nThe Discord bot shows this link in its status message. Ctrl+C stops it.`);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => link.close().then(() => process.exit(0)));
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
}
