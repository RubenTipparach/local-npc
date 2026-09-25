// What the bot keeps on disk, all under data/ (git-ignored):
//   data/discord.json        setup: bot token, play channel, extra hosts. Written by the setup
//                            wizard and /setup; edit it by hand if you like.
//   data/discord-state.json  the running game: who the table is talking to, every villager's
//                            memory of the conversation, the status message, the channel lock.
//                            Saved on every change, so a restart (or the laptop sleeping) picks
//                            up exactly where the table left off.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "data", "discord.json");
const STATE = path.join(ROOT, "data", "discord-state.json");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Write to a temp file and rename, so a crash mid-write never leaves half a file behind.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// Environment variables win over the file, so the bot can also run without one.
export function loadConfig() {
  const file = readJson(CONFIG) || {};
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    token: process.env.DISCORD_TOKEN || file.token || "",
    channelId: process.env.DISCORD_CHANNEL_ID || file.channelId || "",
    hosts: [...list(process.env.DISCORD_HOSTS), ...(file.hosts || [])],
    // Lock the play channel while a villager is thinking (needs the Manage Roles permission).
    lockChannel: file.lockChannel !== false,
    // Lock it while the bot is offline too, so nobody talks to an empty town.
    closeWhenOffline: file.closeWhenOffline !== false,
  };
}

export function saveConfig(patch) {
  writeJson(CONFIG, { ...(readJson(CONFIG) || {}), ...patch });
}

export const configPath = CONFIG;

const DEFAULT_STATE = {
  caseId: null, // the case the histories below belong to
  talking: null, // villager id the table is talking to
  histories: {}, // villager id -> [{role, content, opener?, by?}]
  options: null, // {messageId, npc, list}: the reply the suggestion buttons hang off
  showOptions: true,
  modelId: null,
  statusMessageId: null,
  lock: null, // {locked, channelId, targets}: what to restore when the channel unlocks
  closedByHost: false,
  lastSeen: null,
  cleanExit: true,
};

export function loadState() {
  return { ...DEFAULT_STATE, ...(readJson(STATE) || {}) };
}

// Coalesces bursts of changes (a streaming reply saves once, not per token).
export function stateSaver(state) {
  let timer = null;
  const now = () => {
    clearTimeout(timer);
    timer = null;
    writeJson(STATE, state);
  };
  const soon = () => {
    if (!timer) timer = setTimeout(now, 250);
  };
  return { soon, now };
}
