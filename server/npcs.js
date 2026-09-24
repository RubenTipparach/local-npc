// Loads villagers from npcs/<id>/agent.md. Each file is a small frontmatter block
// (placement and looks, read by the game) followed by Markdown the model reads as its script.
// Files are re-read on every request, so edits apply on the next line of dialogue.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

const DIR = path.join(ROOT, "npcs");
const TOWN = path.join(DIR, "town.md");

export function listNpcs() {
  return fs
    .readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(DIR, d.name, "agent.md")))
    .map((d) => loadNpc(d.name));
}

export function loadNpc(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw Object.assign(new Error(`Bad NPC id "${id}"`), { status: 400 });
  const file = path.join(DIR, id, "agent.md");
  if (!fs.existsSync(file)) throw Object.assign(new Error(`No agent.md for "${id}"`), { status: 404 });
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const { meta, body } = parseFrontmatter(raw);
  return { id, ...meta, name: meta.name || id, body: body.trim(), raw };
}

export function townLore() {
  return fs.existsSync(TOWN) ? fs.readFileSync(TOWN, "utf8").replace(/\r\n/g, "\n").trim() : "";
}

// Flat "key: value" frontmatter only; values may be numbers, quoted strings or bare strings.
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!kv) continue;
    let v = kv[2];
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}
