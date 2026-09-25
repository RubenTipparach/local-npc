// The table: the one shared game in the play channel. Everyone in the channel is on the same
// case and hears the same conversations; only one villager thinks at a time, and while they do
// the channel is locked (see lock.js) and anything that would make them think again is turned away.

import { partial, holdBack, tidy, wire, PREFERRED } from "../scripts/game-client.js";
import { npcLine, replyButtons, caseEmbed } from "./format.js";
import { record } from "./transcript.js";

const EDIT_EVERY_MS = 1100; // Discord allows about five edits per five seconds per channel
const MAX_HISTORY = 200;

export class Busy extends Error {}
export class Closed extends Error {}

// Loads models, villagers and the case from the game server. If the case changed since last time
// (a new one here, or one started from the browser or text mode), the table forgets the old one.
export async function refresh(bot, signal) {
  const [{ models, active }, npcs, { case: c }] = await Promise.all([
    bot.api.get("/api/models", signal),
    bot.api.get("/api/npcs", signal),
    bot.api.get("/api/case", signal),
  ]);
  bot.models = models;
  bot.active = active;
  bot.mystery = c;
  bot.npcs = npcs.filter((n) => n.id !== c?.victim.id);
  const caseId = c?.id || null;
  if (bot.state.caseId !== caseId) {
    Object.assign(bot.state, { caseId, histories: {}, talking: null, options: null });
    bot.save.soon();
  }
  if (bot.state.talking && !bot.npcs.some((n) => n.id === bot.state.talking)) bot.state.talking = null;
  bot.gameServerSeen();
}

export function pickModel(bot) {
  const present = (id) => bot.models.some((m) => m.id === id && m.present);
  return [bot.state.modelId, ...PREFERRED].find((id) => id && present(id)) || bot.models.find((m) => m.present)?.id || null;
}

export const npcById = (bot, id) => bot.npcs.find((n) => n.id === id);
export const modelName = (bot, id = bot.state.modelId) => bot.models.find((m) => m.id === id)?.name || id;

// Runs `fn` as the one thing the table is waiting on. Throws Busy if a villager is already
// thinking and Closed if the town isn't open. Checking and claiming happen with no await in
// between, so two clicks at once can never both get through.
export async function thinking(bot, label, fn) {
  if (bot.town !== "open") throw new Closed(bot.townProblem());
  if (bot.busy) throw new Busy(bot.busy.label);
  bot.busy = { label, since: Date.now() };
  bot.presence();
  bot.lock.hold("busy");
  try {
    return await fn();
  } finally {
    bot.busy = null;
    await bot.lock.release("busy");
    bot.presence();
  }
}

// Take the buttons off the last villager line so only the newest one can be clicked.
export async function stripButtons(bot, exceptId) {
  const o = bot.state.options;
  if (!o) return;
  bot.state.options = null;
  bot.save.soon();
  if (o.messageId === exceptId) return;
  // By id rather than through the bot's copy of the message, which can lag behind the last edit.
  await bot.channel.messages.edit(o.messageId, { components: [] }).catch(() => {
    // Deleted; nothing to clean up.
  });
}

function histories(bot, npcId) {
  return (bot.state.histories[npcId] ||= []);
}

// One turn of conversation, like the text mode's reply(): the villager answers (streamed into a
// message as it's written), then the table gets suggested replies as buttons.
//   line     what the player said, or nothing when they've just walked up
//   by       who said it (for the chat log and the quote)
//   quote    show the line above the answer (it came from a button or /say, not a message)
//   replyTo  the player's message to answer
//   intro    small print above the answer
//   clicked  the message whose button was just clicked (already updated, so left alone)
export async function npcTurn(bot, npc, { line, by, quote, replyTo, intro, clicked } = {}) {
  await stripButtons(bot, clicked);
  bot.state.talking = npc.id;
  const history = histories(bot, npc.id);

  // Walking back up to someone you've already talked to: remind the table where you left off.
  const last = !line && [...history].reverse().find((m) => m.role === "assistant");
  if (last) {
    const shown = (note) => npcLine(npc, last.content, { earlier: true, intro, note });
    const msg = await send(bot, shown(bot.state.showOptions ? "thinking of replies…" : ""), replyTo);
    await suggest(bot, npc, msg, shown);
    return;
  }

  const shown = (text, opts) => npcLine(npc, text, { quote: quote && line ? { by, text: line } : null, intro, ...opts });
  const msg = await send(bot, shown("", {}), replyTo);
  const live = liveEdits(msg);
  if (line) {
    history.push({ role: "user", content: line, by });
    record(bot.state.caseId, { kind: "say", who: by, npc: npc.name, text: line });
  } else history.push({ role: "user", opener: true });
  bot.save.soon();

  let raw = "";
  let stats = null;
  let started = false;
  try {
    const body = { model: bot.state.modelId, npc: npc.id, history: wire(history) };
    for await (const { event, data } of bot.api.stream("/api/talk", body)) {
      if (event === "status" && data.state === "loading") live.set({ content: shown("", { note: `loading ${data.model}…` }) });
      if (event === "token") {
        raw += data.t;
        const text = partial(raw, npc.name);
        if (!started && holdBack(text, raw)) continue;
        started = true;
        live.set({ content: shown(text, { streaming: true }) });
      }
      if (event === "error") throw new Error(data.error);
      if (event === "done") stats = data;
    }
  } catch (e) {
    history.pop();
    bot.save.soon();
    await live.done({ content: shown("", { note: `${npc.name} didn't answer: ${e.message}` }) });
    bot.apiFailed(e);
    return;
  }

  const content = tidy(raw, npc.name, true) || "…";
  history.push({ role: "assistant", content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  record(bot.state.caseId, { kind: "npc", npc: npc.name, text: content });
  bot.save.soon();

  const tps = stats?.tokensPerSecond ? ` · ${stats.tokensPerSecond.toFixed(1)} tok/s` : "";
  const stat = stats ? `${stats.model.name}${tps}` : "";
  const final = (note) => shown(content, { note: [stat, note].filter(Boolean).join(" · ") });
  await live.done({ content: final(bot.state.showOptions ? "thinking of replies…" : "") });
  await suggest(bot, npc, msg, final);
}

// Three suggested replies as buttons under the villager's line (or just "Walk away" when
// suggestions are off). Anyone can click one, or type 1-3. `shown(note)` renders the line.
async function suggest(bot, npc, msg, shown) {
  let list = [];
  if (bot.state.showOptions) {
    try {
      ({ options: list } = await bot.api.post("/api/options", { model: bot.state.modelId, npc: npc.id, history: wire(histories(bot, npc.id)) }));
    } catch {
      list = [];
    }
  }
  bot.state.options = { messageId: msg.id, npc: npc.id, list };
  bot.save.soon();
  const content = shown(list.length ? "pick a reply or type your own" : "");
  await msg.edit({ content, components: replyButtons(list) }).catch((e) => bot.log(`couldn't add the reply buttons: ${e.message}`));
}

// Posts in the play channel, as a reply to the player's message when there is one.
export function send(bot, content, replyTo) {
  return bot.channel.send({
    content,
    allowedMentions: { parse: [], repliedUser: false },
    ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
  });
}

// Streaming edits, throttled to what Discord allows and never overlapping.
function liveEdits(msg) {
  let pending = null;
  let timer = null;
  let last = 0;
  let chain = Promise.resolve();
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const payload = pending;
    pending = null;
    last = Date.now();
    chain = chain.then(() => msg.edit(payload)).catch(() => {});
  };
  return {
    set(payload) {
      pending = payload;
      if (!timer) timer = setTimeout(flush, Math.max(0, last + EDIT_EVERY_MS - Date.now()));
    },
    async done(payload) {
      pending = payload;
      flush();
      await chain;
    },
  };
}

// The director writes a new case. Everyone's conversations belong to the old case, so they go too.
export async function newMystery(bot, difficulty, { progress }) {
  const started = Date.now();
  const tick = setInterval(() => progress(Math.round((Date.now() - started) / 1000)).catch(() => {}), 5000);
  try {
    await bot.api.post("/api/case", { difficulty, model: bot.state.modelId });
  } finally {
    clearInterval(tick);
  }
  await stripButtons(bot);
  await refresh(bot);
  record(bot.state.caseId, { kind: "event", text: `New ${difficulty} case: ${bot.mystery.title}` });
  return { embeds: [caseEmbed(bot.mystery)] };
}

export async function loadModel(bot, id) {
  const { active } = await bot.api.post("/api/models/load", { id });
  bot.state.modelId = id;
  bot.active = active;
  bot.save.soon();
  return active;
}
