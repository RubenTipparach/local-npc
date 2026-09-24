// Model registry: config/models.json plus any other .gguf dropped into ./models.
// Re-read on every call so edits and finished downloads show up without a restart.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

export const MODELS_DIR = path.join(ROOT, "models");
const CONFIG = path.join(ROOT, "config", "models.json");

export function listModels() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const defaults = cfg.defaults || {};
  const files = fs.existsSync(MODELS_DIR) ? fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith(".gguf")) : [];

  const models = cfg.models.map((m) => ({
    ...m,
    ctx: m.ctx ?? defaults.ctx ?? 4096,
    args: [...(defaults.args || []), ...(m.args || [])],
    present: files.includes(m.file),
  }));

  // Unlisted GGUFs still work with default settings.
  for (const file of files) {
    if (models.some((m) => m.file === file)) continue;
    models.push({
      id: file.replace(/\.gguf$/i, "").toLowerCase(),
      name: file.replace(/\.gguf$/i, ""),
      file,
      sizeGB: +(fs.statSync(path.join(MODELS_DIR, file)).size / 1e9).toFixed(2),
      ctx: defaults.ctx ?? 4096,
      args: [...(defaults.args || [])],
      present: true,
      notes: "Found in ./models; not in config/models.json.",
    });
  }
  return models;
}

export function getModel(id) {
  const m = listModels().find((x) => x.id === id);
  if (!m) throw Object.assign(new Error(`Unknown model "${id}"`), { status: 404 });
  if (!m.present) throw Object.assign(new Error(`${m.name} is not downloaded yet (${m.file})`), { status: 409 });
  return { ...m, path: path.join(MODELS_DIR, m.file) };
}
