// Downloads the llama.cpp runtime and GGUF models. Resumable: partial files are kept as *.part.
//
//   node scripts/download.js runtime          llama.cpp CUDA build -> ./runtime/llama.cpp
//   node scripts/download.js models           every model in config/models.json -> ./models
//   node scripts/download.js models qwen3-8b  only the listed model ids
//   node scripts/download.js all              runtime, then all models

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MODELS_DIR = path.join(ROOT, "models");
export const RUNTIME_DIR = path.join(ROOT, "runtime", "llama.cpp");
export const LLAMA_SERVER = path.join(RUNTIME_DIR, process.platform === "win32" ? "llama-server.exe" : "llama-server");
const LOCK = path.join(MODELS_DIR, ".download.lock");
const CUDA = process.env.LLAMA_CUDA || "13.4";

export const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "models.json"), "utf8"));

// PID of a model download that is still running, or null. Two downloaders on the same
// *.partN files would corrupt them, so only one may run at a time.
export function activeDownload() {
  try {
    const pid = Number(fs.readFileSync(LOCK, "utf8"));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const SEGMENTS = Number(process.env.DOWNLOAD_CONNECTIONS || 8);

// Splits the file into byte ranges fetched in parallel (single connections to Hugging Face are slow).
// Each range is its own *.partN file, so an interrupted download resumes where each range stopped.
async function download(url, dest, label) {
  if (fs.existsSync(dest)) {
    console.log(`[skip] ${label} already present`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!head.ok) throw new Error(`${label}: HTTP ${head.status}`);
  const total = Number(head.headers.get("content-length") || 0);
  const ranged = head.headers.get("accept-ranges") === "bytes" && total > 64e6;
  const n = ranged ? SEGMENTS : 1;
  const size = Math.ceil(total / n);
  const parts = Array.from({ length: n }, (_, i) => ({
    file: `${dest}.part${i}`,
    start: i * size,
    end: Math.min(total, (i + 1) * size) - 1,
  }));

  const progress = { done: parts.reduce((s, p) => s + fileSize(p.file), 0) };
  const startedAt = Date.now();
  const startedWith = progress.done;
  const timer = setInterval(() => {
    const mbps = (progress.done - startedWith) / 1e6 / ((Date.now() - startedAt) / 1000);
    console.log(`[${label}] ${((progress.done / total) * 100).toFixed(1)}%  ${(progress.done / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)} GB  ${mbps.toFixed(1)} MB/s`);
  }, 5000);

  try {
    await Promise.all(parts.map((p) => fetchSegment(url, p, ranged, progress, label)));
  } finally {
    clearInterval(timer);
  }

  concat(parts.map((p) => p.file), dest + ".part");
  if (fileSize(dest + ".part") !== total) throw new Error(`${label}: size mismatch after download`);
  fs.renameSync(dest + ".part", dest);
  for (const p of parts) fs.rmSync(p.file);
  console.log(`[done] ${label}`);
}

async function fetchSegment(url, p, ranged, progress, label) {
  for (let attempt = 1; ; attempt++) {
    const have = ranged ? fileSize(p.file) : 0;
    if (ranged && p.start + have > p.end) return;
    try {
      const headers = ranged ? { Range: `bytes=${p.start + have}-${p.end}` } : {};
      const res = await fetch(url, { headers, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = fs.createWriteStream(p.file, { flags: ranged ? "a" : "w" });
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        progress.done += chunk.length;
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      if (!ranged) return;
    } catch (e) {
      if (attempt >= 5) throw new Error(`${label}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function concat(files, dest) {
  const out = fs.openSync(dest, "w");
  const buf = Buffer.alloc(16 * 1024 * 1024);
  for (const file of files) {
    const fd = fs.openSync(file, "r");
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) fs.writeSync(out, buf, 0, n);
    fs.closeSync(fd);
  }
  fs.closeSync(out);
}

function fileSize(file) {
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

function unzip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Windows' bundled bsdtar reads zip files; GNU tar (e.g. from Git Bash) does not.
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "unzip";
  const args = process.platform === "win32" ? ["-xf", zip, "-C", dir] : ["-o", zip, "-d", dir];
  const r = spawnSync(tar, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`failed to extract ${zip}`);
}

export async function runtime() {
  if (fs.existsSync(LLAMA_SERVER)) {
    console.log(`[skip] llama.cpp runtime already at ${RUNTIME_DIR}`);
    return;
  }
  if (process.platform !== "win32") {
    throw new Error("Automatic runtime setup is Windows-only. Install llama.cpp and set LLAMA_SERVER to llama-server's path.");
  }
  // "releases/latest" can point at a tag with no binaries, so take the newest build that has the CUDA zip.
  const releases = await (await fetch("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20")).json();
  const want = (tag) => [
    new RegExp(`^llama-${tag}-bin-win-cuda-${CUDA}-x64\\.zip$`),
    new RegExp(`^cudart-llama-bin-win-cuda-${CUDA}-x64\\.zip$`),
  ];
  const rel = releases.find((r) => want(r.tag_name).every((re) => r.assets.some((a) => re.test(a.name))));
  if (!rel) throw new Error(`no recent llama.cpp release has Windows CUDA ${CUDA} binaries`);
  const tmp = path.join(ROOT, "runtime", "_zips");
  for (const re of want(rel.tag_name)) {
    const asset = rel.assets.find((a) => re.test(a.name));
    const zip = path.join(tmp, asset.name);
    await download(asset.browser_download_url, zip, asset.name);
    unzip(zip, RUNTIME_DIR);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, "VERSION"), `${rel.tag_name} cuda-${CUDA}\n`);
  console.log(`[done] llama.cpp ${rel.tag_name} (CUDA ${CUDA}) -> ${RUNTIME_DIR}`);
}

export async function models(ids) {
  const list = registry.models
    .filter((m) => !ids.length || ids.includes(m.id))
    .sort((a, b) => a.sizeGB - b.sizeGB);
  const unknown = ids.filter((id) => !registry.models.some((m) => m.id === id));
  if (unknown.length) throw new Error(`unknown model id(s): ${unknown.join(", ")}`);

  const other = activeDownload();
  if (other && other !== process.pid) throw new Error(`another model download is already running (process ${other}); see logs/download.log`);
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));
  const unlock = () => fs.rmSync(LOCK, { force: true });
  process.once("exit", unlock);

  const failed = [];
  try {
    for (const m of list) {
      const url = `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;
      try {
        await download(url, path.join(MODELS_DIR, m.file), m.id);
      } catch (e) {
        console.error(`[fail] ${m.id}: ${e.message}`);
        failed.push(m.id);
      }
    }
  } finally {
    unlock();
  }
  if (failed.length) {
    console.error(`Failed: ${failed.join(", ")}. Re-run to resume.`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const [cmd = "all", ...rest] = invokedDirectly ? process.argv.slice(2) : ["library"];
if (cmd === "library") {
  // Imported by scripts/install.js; nothing to run.
} else if (cmd === "runtime") await runtime();
else if (cmd === "models") await models(rest);
else if (cmd === "all") {
  try {
    await runtime();
  } catch (e) {
    console.error(`[fail] runtime: ${e.message}`);
    process.exitCode = 1;
  }
  await models([]);
} else {
  console.log("usage: node scripts/download.js [runtime|models [ids...]|all]");
  process.exitCode = 1;
}
