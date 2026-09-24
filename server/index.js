// local-npc server: serves the game and one API over every local model.
//
//   Game API                      OpenAI-compatible API (any tool can point here)
//   GET  /api/models              GET  /v1/models
//   POST /api/models/load {id}    POST /v1/chat/completions  ("model" picks and hot-swaps the GGUF)
//   POST /api/models/unload
//   GET  /api/npcs
//   GET  /api/npcs/:id            (agent.md plus the full system prompt the model receives)
//   POST /api/talk                (server-sent events: status, token, done, error)
//   POST /api/options             ({options: [3 strings]})
//   GET  /api/case                (director mode: the current mystery, without the answer)
//   POST /api/case {difficulty, model}   generate a new mystery
//   POST /api/case/accuse {suspect}      name the killer; returns the full solution
//   POST /api/case/end                   back to the normal town

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";
import { listModels, getModel } from "./registry.js";
import * as llama from "./llama.js";
import { listNpcs, loadNpc } from "./npcs.js";
import { systemPrompt, optionsMessages, OPTIONS_SCHEMA, OPENER, trimHistory } from "./prompt.js";
import * as director from "./director.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = path.join(ROOT, "public");
const REPLY_TOKENS = 220;
const STOP = ["\nPlayer:", "\nUser:", "\nYou:", "\n(", "<|"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const routes = {
  "GET /api/models": () => ({ models: listModels().map(publicModel), active: llama.status() }),
  "POST /api/models/load": async (req) => {
    const { id } = await readJson(req);
    await llama.ensure(id);
    return { active: llama.status() };
  },
  "POST /api/models/unload": async () => {
    await llama.stop();
    return { active: llama.status() };
  },
  "GET /api/npcs": () => listNpcs().map(({ body, raw, ...meta }) => meta),
  "POST /api/options": options,
  "POST /api/talk": talk,
  "GET /v1/models": () => ({
    object: "list",
    data: listModels()
      .filter((m) => m.present)
      .map((m) => ({ id: m.id, object: "model", owned_by: "local", name: m.name })),
  }),
  "POST /v1/chat/completions": openaiProxy,
  "GET /api/case": () => ({ case: director.publicView() }),
  "POST /api/case": async (req) => {
    const { difficulty, model } = await readJson(req);
    await director.newCase({ difficulty, model });
    return { case: director.publicView() };
  },
  "POST /api/case/accuse": async (req) => director.accuse((await readJson(req)).suspect),
  "POST /api/case/end": () => {
    director.endCase();
    return { case: null };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    let handler = routes[`${req.method} ${url.pathname}`];
    const npcMatch = url.pathname.match(/^\/api\/npcs\/([a-z0-9-]+)$/);
    if (!handler && req.method === "GET" && npcMatch) {
      handler = () => {
        const npc = loadNpc(npcMatch[1]);
        return { ...npc, systemPrompt: systemPrompt(npc, { brief: director.briefFor(npc.id) }) };
      };
    }
    if (handler) {
      const out = await handler(req, res, url);
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
      return;
    }
    if (req.method === "GET") return serveStatic(url.pathname, res);
    sendJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

// ---- dialogue ------------------------------------------------------------------------------

async function talk(req, res) {
  const { model: modelId, npc: npcId, history = [], timeOfDay } = await readJson(req);
  const npc = loadNpc(npcId);
  const model = getModel(modelId);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    if (llama.currentModel()?.id !== model.id) send("status", { state: "loading", model: model.name });
    await llama.ensure(model.id);
    if (abort.signal.aborted) return;
    send("status", { state: "generating", model: model.name });

    const sys = systemPrompt(npc, { timeOfDay, brief: director.briefFor(npc.id) });
    const messages = [{ role: "system", content: sys }, ...trimHistory(sanitize(history), sys, model.ctx, REPLY_TOKENS + 64)];
    const started = Date.now();
    const upstream = await fetch(`${llama.upstream()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abort.signal,
      body: JSON.stringify({
        messages,
        stream: true,
        max_tokens: REPLY_TOKENS,
        temperature: 0.8,
        top_p: 0.95,
        stop: STOP,
        chat_template_kwargs: model.chatTemplateKwargs,
        timings_per_token: false,
      }),
    });
    if (!upstream.ok) throw new Error(`llama-server ${upstream.status}: ${await upstream.text()}`);

    let firstTokenMs = null;
    let timings = null;
    for await (const evt of sseEvents(upstream.body)) {
      if (evt === "[DONE]") break;
      const chunk = JSON.parse(evt);
      if (chunk.timings) timings = chunk.timings;
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        firstTokenMs ??= Date.now() - started;
        send("token", { t: text });
      }
    }
    send("done", {
      model: { id: model.id, name: model.name },
      firstTokenMs,
      tokensPerSecond: timings?.predicted_per_second ?? null,
      promptTokens: timings?.prompt_n ?? null,
      tokens: timings?.predicted_n ?? null,
    });
  } catch (e) {
    if (!abort.signal.aborted) send("error", { error: e.message });
  } finally {
    res.end();
  }
}

async function options(req) {
  const { model: modelId, npc: npcId, history = [] } = await readJson(req);
  const npc = loadNpc(npcId);
  const model = getModel(modelId);
  await llama.ensure(model.id);

  const r = await fetch(`${llama.upstream()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: optionsMessages(npc, sanitize(history), mysteryContext()),
      max_tokens: 160,
      temperature: 0.9,
      response_format: { type: "json_schema", json_schema: { name: "options", schema: OPTIONS_SCHEMA } },
      chat_template_kwargs: model.chatTemplateKwargs,
    }),
  });
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || "";
  return { options: parseOptions(text) };
}

function mysteryContext() {
  const c = director.publicView();
  return c && !c.accused ? { victim: c.victim.name, scene: c.scene } : null;
}

function parseOptions(text) {
  let list = [];
  try {
    list = JSON.parse(text).options || [];
  } catch {
    list = [...text.matchAll(/"([^"]{3,80})"/g)].map((m) => m[1]).filter((s) => s !== "options");
  }
  list = list.map((s) => String(s).trim()).filter(Boolean);
  const fallback = ["Tell me about yourself.", "Anything strange going on in town?", "I should get going. Bye!"];
  return [...new Set([...list, ...fallback])].slice(0, 3);
}

// The client marks the silent "player walks up" turn with {opener: true}; the wording lives here.
function sanitize(history) {
  return history
    .map((m) => (m.opener ? { role: "user", content: OPENER } : m))
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

// ---- OpenAI-compatible passthrough ---------------------------------------------------------

async function openaiProxy(req, res) {
  const body = await readJson(req);
  const model = getModel(body.model);
  await llama.ensure(model.id);
  if (model.chatTemplateKwargs && !body.chat_template_kwargs) body.chat_template_kwargs = model.chatTemplateKwargs;

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const upstream = await fetch(`${llama.upstream()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: abort.signal,
  });
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (e) {
    if (!abort.signal.aborted) throw e;
  }
  res.end();
}

// ---- helpers -------------------------------------------------------------------------------

function publicModel({ args, path: _p, ...m }) {
  return m;
}

async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
}

async function readJson(req) {
  let s = "";
  for await (const c of req) s += c;
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    throw Object.assign(new Error("Request body is not valid JSON"), { status: 400 });
  }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function serveStatic(pathname, res) {
  const file = path.resolve(PUBLIC, "." + decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

server.listen(PORT, HOST, () => {
  console.log(`local-npc running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`OpenAI-compatible API at http://${HOST}:${PORT}/v1`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await llama.stop();
    process.exit(0);
  });
}
process.on("exit", llama.killNow);
