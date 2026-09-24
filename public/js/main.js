// Game loop: grid movement, wandering villagers, camera, model picker.

import * as api from "./api.js";
import { TILE, W, H, walkable, inspect, renderStatic, drawWater } from "./world.js";
import { drawCharacter } from "./sprites.js";
import { Dialogue } from "./dialogue.js";
import { Mystery } from "./mystery.js";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYS = {
  ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
  ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
};
const PREFERRED = ["qwen3-8b", "llama-3.1-8b", "qwen3-4b-2507", "llama-3.2-3b", "gemma-3-4b", "tinyllama-1.1b"];

const player = entity({ x: 20, y: 17, dir: "up", skin: "#f0c8a4", hair: "#4a3020", shirt: "#d0443a", pants: "#34466b", hat: "cap" });
let allNpcs = [];
let npcs = []; // villagers on the map (everyone except a murder victim)
let map;
let scale = 3;
const held = { dirs: [], shift: false };
let clockMinutes = 9 * 60;
let toast = null;

let models = [];
let selectedId = null;

const currentModel = () => models.find((m) => m.id === selectedId && m.present) || null;

const dialogue = new Dialogue({
  getModel: currentModel,
  getTimeOfDay: () => `${formatClock()} in late autumn, three days before the Harvest Festival`,
  onClose: () => {
    for (const n of npcs) n.talking = false;
  },
});

const mystery = new Mystery({
  getModel: currentModel,
  toast: (text) => showToast(text),
  onChange: (c, changed) => {
    npcs = allNpcs.filter((n) => n.id !== c?.victim.id);
    if (changed) dialogue.resetAll();
  },
});

function entity(o) {
  return { ...o, px: o.x * TILE, py: o.y * TILE, moving: false, fromX: 0, fromY: 0, t: 0, step: 0, stepTimer: 0, dir: o.dir || o.facing || "down" };
}

// ---- movement -------------------------------------------------------------------------------

function occupied(x, y, self) {
  if (player !== self && player.x === x && player.y === y) return true;
  if (player !== self && player.moving && Math.round(player.px / TILE) === x && Math.round(player.py / TILE) === y) return true;
  return npcs.some((n) => n !== self && (n.x === x && n.y === y));
}

function tryMove(e, dir) {
  e.dir = dir;
  const [dx, dy] = DIRS[dir];
  const nx = e.x + dx, ny = e.y + dy;
  if (!walkable(nx, ny) || occupied(nx, ny, e)) return false;
  e.fromX = e.x; e.fromY = e.y;
  e.x = nx; e.y = ny;
  e.moving = true;
  e.t = 0;
  return true;
}

function advance(e, dt, tilesPerSec) {
  if (!e.moving) return;
  e.t = Math.min(1, e.t + dt * tilesPerSec);
  e.px = (e.fromX + (e.x - e.fromX) * e.t) * TILE;
  e.py = (e.fromY + (e.y - e.fromY) * e.t) * TILE;
  e.stepTimer += dt;
  if (e.stepTimer > 0.12) { e.stepTimer = 0; e.step = (e.step + 1) % 4; }
  if (e.t >= 1) { e.moving = false; e.px = e.x * TILE; e.py = e.y * TILE; }
}

function update(dt) {
  clockMinutes += dt; // one game minute per real second
  updatePlayer(dt);
  for (const n of npcs) updateNpc(n, dt);
}

function updatePlayer(dt) {
  const dir = held.dirs.at(-1);
  const busy = dialogue.isOpen || toast || mystery.isOverlayOpen;
  if (!busy && !player.moving && dir && !tryMove(player, dir)) player.step = 0;
  advance(player, dt, held.shift ? 8 : 5);
  if (!player.moving && !held.dirs.length) player.step = 0;
}

// Villagers amble within `wander` tiles of home and stand still while talking.
function updateNpc(n, dt) {
  advance(n, dt, 2.5);
  if (!n.moving) n.step = 0;
  if (n.talking || n.moving || !n.wander) return;
  n.idle -= dt;
  if (n.idle > 0) return;
  n.idle = 2 + Math.random() * 4;
  const dir = Object.keys(DIRS)[Math.floor(Math.random() * 4)];
  const [dx, dy] = DIRS[dir];
  if (Math.abs(n.x + dx - n.homeX) + Math.abs(n.y + dy - n.homeY) <= n.wander) tryMove(n, dir);
  else n.dir = dir;
}

// ---- interaction ----------------------------------------------------------------------------

function facingTile() {
  const [dx, dy] = DIRS[player.dir];
  return [player.x + dx, player.y + dy];
}

function facingNpc() {
  const [fx, fy] = facingTile();
  return npcs.find((n) => n.x === fx && n.y === fy);
}

const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };

function interact() {
  if (player.moving) return;
  const npc = facingNpc();
  if (npc) {
    npc.talking = true;
    npc.dir = OPPOSITE[player.dir];
    held.dirs.length = 0;
    dialogue.open(npc);
    return;
  }
  const [fx, fy] = facingTile();
  const text = mystery.inspect([[fx, fy], [player.x, player.y]]) || inspect(fx, fy);
  if (text) showToast(text);
}

function showToast(text) {
  toast = text;
  $("toast-text").textContent = text;
  $("toast").hidden = false;
}

function hideToast() {
  toast = null;
  $("toast").hidden = true;
}

// ---- rendering ------------------------------------------------------------------------------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  scale = Math.max(2, Math.round(Math.min(canvas.width / (TILE * 17), canvas.height / (TILE * 12))));
}

function render(now) {
  const cw = canvas.width, ch = canvas.height;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#2d5a33";
  ctx.fillRect(0, 0, cw, ch);

  const viewW = cw / scale, viewH = ch / scale;
  const camX = clamp(player.px + TILE / 2 - viewW / 2, 0, Math.max(0, W * TILE - viewW));
  const camY = clamp(player.py + TILE / 2 - viewH / 2, 0, Math.max(0, H * TILE - viewH));
  const offX = W * TILE < viewW ? (viewW - W * TILE) / 2 : -camX;
  const offY = H * TILE < viewH ? (viewH - H * TILE) / 2 : -camY;

  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(Math.round(offX), Math.round(offY));
  ctx.drawImage(map, 0, 0);
  drawWater(ctx, now, {
    x0: Math.floor(camX / TILE), y0: Math.floor(camY / TILE),
    x1: Math.ceil((camX + viewW) / TILE), y1: Math.ceil((camY + viewH) / TILE),
  });

  if (mystery.current) drawCrimeScene(ctx, mystery.current.sceneTile);
  const all = [player, ...npcs].sort((a, b) => a.py - b.py);
  for (const e of all) drawCharacter(ctx, e, Math.round(e.px), Math.round(e.py), e.dir, e.step);
  ctx.restore();

  // Evening light
  const hour = (clockMinutes / 60) % 24;
  const dusk = hour < 17 ? 0 : Math.min(0.35, (hour - 17) * 0.1);
  if (dusk) {
    ctx.fillStyle = `rgba(40,30,90,${dusk})`;
    ctx.fillRect(0, 0, cw, ch);
  }

  // Name tags and the talk prompt, in screen space so text stays crisp.
  const toScreen = (e) => [(e.px + offX + TILE / 2) * scale, (e.py + offY) * scale];
  const target = !dialogue.isOpen && !toast ? facingNpc() : null;
  const dpr = window.devicePixelRatio || 1;
  ctx.textAlign = "center";
  for (const n of npcs) {
    const dist = Math.abs(n.x - player.x) + Math.abs(n.y - player.y);
    if (dist > 3 && n !== target) continue;
    const [sx, sy] = toScreen(n);
    ctx.font = `600 ${12 * dpr}px "Pixelify Sans", system-ui, sans-serif`;
    const label = n === target ? `E  Talk to ${n.name.split(" ")[0]}` : n.name.split(" ")[0];
    const w = ctx.measureText(label).width + 12 * dpr;
    ctx.fillStyle = n === target ? "rgba(255,248,225,.95)" : "rgba(20,24,32,.6)";
    roundRect(ctx, sx - w / 2, sy - 22 * dpr, w, 18 * dpr, 4 * dpr);
    ctx.fillStyle = n === target ? "#2a2230" : "#fff";
    ctx.fillText(label, sx, sy - 9 * dpr);
  }

  $("clock").textContent = formatClock();
}

// Chalk outline and a red X on the tile where the body was found.
function drawCrimeScene(c, [tx, ty]) {
  const x = tx * TILE, y = ty * TILE;
  c.fillStyle = "rgba(0,0,0,.18)";
  c.fillRect(x, y, TILE, TILE);
  c.fillStyle = "#f4f1ea";
  for (const [px, py, w, h] of [[6, 2, 4, 1], [5, 3, 1, 3], [10, 3, 1, 3], [6, 6, 4, 1], [3, 7, 10, 1], [7, 7, 1, 5], [8, 7, 1, 5], [5, 12, 2, 1], [9, 12, 2, 1]]) c.fillRect(x + px, y + py, w, h);
  c.fillStyle = "#d8352a";
  for (let i = 0; i < 5; i++) {
    c.fillRect(x + 11 + i, y + 9 + i, 1, 1);
    c.fillRect(x + 15 - i, y + 9 + i, 1, 1);
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
  c.fill();
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function formatClock() {
  const m = Math.floor(clockMinutes) % (24 * 60);
  const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

// ---- input ----------------------------------------------------------------------------------

addEventListener("keydown", (e) => {
  const typing = (e.target instanceof HTMLInputElement && e.target.type === "text") || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === "Shift") held.shift = true;

  if (typing) {
    if (e.key === "Escape") {
      if (e.target.value) e.target.value = "";
      else e.target.blur();
    }
    return;
  }
  if (toast) {
    if (["KeyE", "Space", "Enter", "Escape"].includes(e.code)) { hideToast(); e.preventDefault(); }
    return;
  }
  if (mystery.isOverlayOpen) {
    if (e.key === "Escape") mystery.closeOverlays();
    return;
  }
  if (dialogue.isOpen) {
    if (e.key === "Escape") dialogue.close();
    else if (["1", "2", "3"].includes(e.key)) dialogue.choose(Number(e.key) - 1);
    else if (e.key === "4" || e.key === "/" || e.code === "KeyT" || e.key === "Enter") { e.preventDefault(); dialogue.focusInput(); }
    return;
  }
  const dir = KEYS[e.code];
  if (dir) {
    e.preventDefault();
    if (!held.dirs.includes(dir)) held.dirs.push(dir);
  } else if (["KeyE", "Space", "Enter"].includes(e.code)) {
    e.preventDefault();
    interact();
  }
});

addEventListener("keyup", (e) => {
  if (e.key === "Shift") held.shift = false;
  const dir = KEYS[e.code];
  if (dir) held.dirs = held.dirs.filter((d) => d !== dir);
});
addEventListener("blur", () => { held.dirs = []; held.shift = false; });
$("toast").addEventListener("click", hideToast);

// ---- model picker ---------------------------------------------------------------------------

const picker = $("model");
const modelState = $("model-state");

function savedModel() {
  try { return localStorage.getItem("local-npc:model"); } catch { return null; }
}
function saveModel(id) {
  try { localStorage.setItem("local-npc:model", id); } catch { /* storage unavailable */ }
}

function renderPicker() {
  const present = models.filter((m) => m.present);
  const missing = models.filter((m) => !m.present);
  const opt = (m) => `<option value="${m.id}" ${m.present ? "" : "disabled"}>${m.name} · ${m.sizeGB} GB</option>`;
  picker.innerHTML =
    (present.length ? `<optgroup label="Downloaded">${present.map(opt).join("")}</optgroup>` : `<option value="" disabled>No models downloaded yet</option>`) +
    (missing.length ? `<optgroup label="Still downloading">${missing.map(opt).join("")}</optgroup>` : "");
  if (selectedId) picker.value = selectedId;
}

function renderState(active) {
  const sel = models.find((m) => m.id === selectedId);
  let cls = "idle", text = sel ? "Not loaded" : "Pick a model";
  if (active?.model?.id === selectedId && active.status === "ready") { cls = "ready"; text = "Ready"; }
  else if (active?.model?.id === selectedId && active.status === "loading") { cls = "loading"; text = "Loading…"; }
  else if (active?.status === "error" && active.model?.id === selectedId) { cls = "error"; text = "Failed to load"; }
  modelState.className = `state ${cls}`;
  modelState.textContent = text;
  modelState.title = active?.error || "";
  $("model-notes").textContent = sel?.notes || "";
}

async function refreshModels(first = false) {
  try {
    const data = await api.getModels();
    const before = models.map((m) => `${m.id}:${m.present}`).join();
    models = data.models;
    if (first) {
      const saved = savedModel();
      const pick = [saved, data.active?.model?.id, ...PREFERRED].find((id) => models.some((m) => m.id === id && m.present));
      selectedId = pick || models.find((m) => m.present)?.id || null;
    } else if (!models.some((m) => m.id === selectedId && m.present)) {
      selectedId = models.find((m) => m.present)?.id || null;
    }
    if (first || before !== models.map((m) => `${m.id}:${m.present}`).join()) renderPicker();
    renderState(data.active);
    return data.active;
  } catch {
    // Polling continues; the badge tells the player the server is down.
    modelState.className = "state error";
    modelState.textContent = "Server offline";
  }
}

async function selectModel(id) {
  selectedId = id;
  saveModel(id);
  renderState({ model: { id }, status: "loading" });
  try {
    const { active } = await api.loadModel(id);
    renderState(active);
  } catch (e) {
    renderState({ model: { id }, status: "error", error: e.message });
  }
}

picker.addEventListener("change", () => {
  selectModel(picker.value);
  picker.blur();
});
$("reset-all").addEventListener("click", () => {
  dialogue.resetAll();
  showToast("Every villager has forgotten your conversations.");
});

// ---- boot -----------------------------------------------------------------------------------

async function boot() {
  resize();
  addEventListener("resize", resize);
  map = renderStatic();

  const list = await api.getNpcs();
  allNpcs = list.map((n) => entity({ ...n, homeX: n.x, homeY: n.y, wander: Number(n.wander) || 0, idle: Math.random() * 3 }));
  npcs = allNpcs;
  await mystery.load();

  const active = await refreshModels(true);
  if (selectedId && !(active?.model?.id === selectedId && active.status === "ready")) selectModel(selectedId);
  // Every game is a murder: without an unsolved case, go straight to setting one up.
  if (!mystery.current || mystery.current.accused) mystery.openSetup();
  setInterval(() => refreshModels(), 5000);

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<div class="fatal">Couldn't start the game: ${e.message}. Is the server running (npm start)?</div>`);
});
