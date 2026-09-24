// Runs one llama-server child process at a time and swaps it when a different model is requested.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./paths.js";
import { getModel, listModels, MODELS_DIR } from "./registry.js";

const EXE = process.env.LLAMA_SERVER || path.join(ROOT, "runtime", "llama.cpp", process.platform === "win32" ? "llama-server.exe" : "llama-server");
const BASE_PORT = Number(process.env.LLAMA_PORT || 8081);
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const LOG = path.join(ROOT, "logs", "llama-server.log");

const state = { model: null, status: "idle", error: null, proc: null, loadedAt: null, port: BASE_PORT };
let launches = 0;

// GPU self-test: a short llama-bench run with a 512-token prompt. Some driver/GPU combinations
// crash ("illegal memory access"), hang, or return garbage once batches get large, so if the test
// fails every model runs on the CPU instead. The result is remembered for a week per llama.cpp
// build (data/device.json; delete it to re-test now). LLAMA_DEVICE=gpu|cpu skips the test.
const DEVICE_CACHE = path.join(ROOT, "data", "device.json");
const BENCH_TIMEOUT_MS = 20_000; // a healthy GPU finishes in a few seconds
let device = null;
export const deviceInfo = () => device;

function runtimeVersion() {
  try {
    return fs.readFileSync(path.join(path.dirname(EXE), "VERSION"), "utf8").trim();
  } catch {
    return "unknown";
  }
}

function cachedDevice() {
  try {
    const c = JSON.parse(fs.readFileSync(DEVICE_CACHE, "utf8"));
    const fresh = Date.now() - c.testedAt < 7 * 24 * 3600 * 1000;
    return c.version === runtimeVersion() && fresh ? { mode: c.mode, reason: `${c.reason} (cached; delete data/device.json to re-test)` } : null;
  } catch {
    return null;
  }
}

export async function checkGpu(smallestModelPath) {
  const forced = process.env.LLAMA_DEVICE;
  if (forced === "gpu" || forced === "cpu") return (device = { mode: forced, reason: "set by LLAMA_DEVICE" });
  const cached = cachedDevice();
  if (cached) return (device = cached);
  if (!smallestModelPath) return null;
  const bench = EXE.replace(/llama-server(\.exe)?$/, (_, ext) => `llama-bench${ext || ""}`);
  const out = await new Promise((resolve) => {
    const p = spawn(bench, ["-m", smallestModelPath, "-p", "512", "-n", "16", "-r", "1"], { windowsHide: true });
    let text = "";
    let timedOut = false;
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (text += d));
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, BENCH_TIMEOUT_MS);
    p.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, text, timedOut });
    });
    p.on("error", (e) => resolve({ code: -1, text: e.message }));
  });
  const ok = out.code === 0 && /pp512/.test(out.text) && /tg16/.test(out.text);
  const why = out.timedOut ? `hung for ${BENCH_TIMEOUT_MS / 1000} s` : lastErrorLine(out.text);
  device = ok ? { mode: "gpu", reason: "GPU self-test passed" } : { mode: "cpu", reason: `GPU self-test failed (${why}); running on CPU` };
  fs.mkdirSync(path.dirname(DEVICE_CACHE), { recursive: true });
  fs.writeFileSync(DEVICE_CACHE, JSON.stringify({ ...device, version: runtimeVersion(), testedAt: Date.now() }, null, 2));
  return device;
}

// Each launch gets its own port, so a slow-to-die previous server can never answer for the new one.
export const upstream = () => `http://127.0.0.1:${state.port}`;
let queue = Promise.resolve();

export function status() {
  const { model, status, error, loadedAt } = state;
  return { model: model && { id: model.id, name: model.name, ctx: model.ctx }, status, error, loadedAt, device };
}

export function currentModel() {
  return state.status === "ready" ? state.model : null;
}

// Serialized so two requests for different models can't interleave a swap.
export function ensure(id) {
  const run = queue.then(() => load(id));
  queue = run.catch(() => {});
  return run;
}

async function load(id) {
  if (state.model?.id === id && state.status === "ready" && state.proc) return state.model;
  const model = getModel(id);
  if (!fs.existsSync(EXE)) {
    throw Object.assign(new Error(`llama-server not found at ${EXE}. Run "npm run setup:runtime" or set LLAMA_SERVER.`), { status: 500 });
  }

  await stop();
  Object.assign(state, { model, status: "loading", error: null, port: BASE_PORT + (launches++ % 20) });
  if (!device) {
    const smallest = listModels().filter((m) => m.present).sort((a, b) => a.sizeGB - b.sizeGB)[0];
    await checkGpu(path.join(MODELS_DIR, smallest.file));
    console.log(`[device] ${device.mode.toUpperCase()}: ${device.reason}`);
  }

  const args = [
    "-m", model.path,
    "--host", "127.0.0.1",
    "--port", String(state.port),
    "-c", String(model.ctx),
    "-np", "1",
    "--jinja",
    ...(device?.mode === "cpu" ? ["-dev", "none"] : []),
    ...model.args,
  ];
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const log = fs.createWriteStream(LOG, { flags: "a" });
  log.write(`\n===== ${new Date().toISOString()} ${model.id}\n${EXE} ${args.join(" ")}\n`);

  const proc = spawn(EXE, args, { windowsHide: true });
  state.proc = proc;
  let tail = "";
  const onData = (d) => {
    log.write(d);
    tail = (tail + d).slice(-4000);
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  const exited = new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
  exited.then((code) => {
    log.end(`\n===== exited ${code}\n`);
    if (state.proc === proc) {
      const crashed = state.status !== "stopping";
      Object.assign(state, { proc: null, status: crashed ? "error" : "idle", error: crashed ? `llama-server exited (${code})` : null });
    }
  });

  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const code = await Promise.race([exited, sleep(400).then(() => undefined)]);
    if (code !== undefined) {
      const err = new Error(`llama-server exited while loading ${model.name}: ${lastErrorLine(tail)}`);
      Object.assign(state, { status: "error", error: err.message });
      throw err;
    }
    try {
      const r = await fetch(`${upstream()}/health`);
      if (r.ok) {
        Object.assign(state, { status: "ready", loadedAt: Date.now() });
        return model;
      }
    } catch {
      // Not listening yet.
    }
  }
  await stop();
  Object.assign(state, { status: "error", error: `Timed out loading ${model.name}` });
  throw new Error(state.error);
}

export async function stop() {
  const proc = state.proc;
  if (!proc) return;
  state.status = "stopping";
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill();
  await Promise.race([exited, sleep(15000)]);
  Object.assign(state, { proc: null, status: "idle", model: null, loadedAt: null });
}

// Synchronous last resort on process exit; Windows does not kill children with their parent.
export function killNow() {
  state.proc?.kill();
}

function lastErrorLine(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.reverse().find((l) => /error|fail|out of memory/i.test(l)) || lines[0] || "no output";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
