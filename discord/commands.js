// Every text-mode command as a slash command, plus the buttons and plain messages in the play
// channel. Talking to villagers happens in the open (the whole channel sees it); looking things
// up (/case, /people, /agent, /log...) answers only the person who asked.

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { findNpc } from "../scripts/game-client.js";
import { Busy, Closed, SERVER_DOWN, refresh, thinking, npcTurn, replySink, stripButtons, newMystery, loadModel, npcById, modelName } from "./table.js";
import {
  esc,
  heads,
  narration,
  replyButtons,
  caseEmbed,
  solutionEmbeds,
  verdictEmbed,
  inspectEmbed,
  newCaseButtons,
  peopleEmbed,
  helpEmbed,
  modelsEmbed,
  agentEmbed,
  statusEmbed,
} from "./format.js";
import { record, markdown } from "./transcript.js";

const PRIVATE = MessageFlags.Ephemeral;
const NO_PINGS = { parse: [] };
const HINT_EVERY_MS = 10 * 60 * 1000;
const DOWN_NOTE_EVERY_MS = 2 * 60 * 1000;

const villager = (o, required) => o.setName("villager").setDescription("Who (start typing a name)").setAutocomplete(true).setRequired(required);

export const COMMANDS = [
  new SlashCommandBuilder().setName("talk").setDescription("Walk up to a villager and talk (everyone sees the conversation)").addStringOption((o) => villager(o, true)),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Say something to the villager you're talking to")
    .addStringOption((o) => o.setName("text").setDescription("What you say").setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName("leave").setDescription("Walk away from the current conversation"),
  new SlashCommandBuilder().setName("reset").setDescription("Make the current villager forget your conversation"),
  new SlashCommandBuilder().setName("people").setDescription("Who's around town (only you see this)"),
  new SlashCommandBuilder().setName("case").setDescription("The case briefing: who, where, when, leads, suspects (only you see this)"),
  new SlashCommandBuilder().setName("inspect").setDescription("Examine the crime scene (only you see this)"),
  new SlashCommandBuilder()
    .setName("accuse")
    .setDescription("Name the killer. Ends the case for everyone")
    .addStringOption((o) => o.setName("suspect").setDescription("Who did it").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder()
    .setName("mystery")
    .setDescription("Start a new case (the director takes a minute or two)")
    .addStringOption((o) =>
      o.setName("difficulty").setDescription("How many innocents also lie").addChoices({ name: "easy", value: "easy" }, { name: "normal", value: "normal" }, { name: "hard", value: "hard" }),
    ),
  new SlashCommandBuilder()
    .setName("options")
    .setDescription("Turn the suggested replies on or off (off is faster on CPU)")
    .addStringOption((o) => o.setName("state").setDescription("on or off").setRequired(true).addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })),
  new SlashCommandBuilder().setName("agent").setDescription("Read a villager's agent.md, secrets and all (only you see this)").addStringOption((o) => villager(o, false)),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("List the models on the host's laptop, or (host) switch to one")
    .addStringOption((o) => o.setName("name").setDescription("Model to switch to (host only)").setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName("log")
    .setDescription("The chat log of this case, as a file (only you see this)")
    .addStringOption((o) => villager(o, false).setDescription("Only the parts with this villager")),
  new SlashCommandBuilder().setName("status").setDescription("Is the town open, what's loaded, who's thinking (only you see this)"),
  new SlashCommandBuilder().setName("help").setDescription("How to play and every command (only you see this)"),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Host: play Bramblewick in this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("town")
    .setDescription("Host: open or close the town (closing frees up the laptop)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName("action").setDescription("open or close").setRequired(true).addChoices({ name: "open", value: "open" }, { name: "close", value: "close" }),
    ),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

// ---- routing --------------------------------------------------------------------------------

export async function onInteraction(bot, i) {
  try {
    if (i.isAutocomplete()) return await autocomplete(bot, i);
    if (i.isChatInputCommand()) {
      bot.log(`${nameOf(i)} used /${i.commandName}`);
      return await command(bot, i);
    }
    if (i.isButton()) return await button(bot, i);
  } catch (e) {
    if (e instanceof Busy) return tell(i, `⏳ ${e.message}. Hold that thought until they're done.`).catch(() => {});
    if (e instanceof Closed) return tell(i, e.message).catch(() => {});
    bot.log(`${i.commandName ? `/${i.commandName}` : i.customId} failed: ${e.stack || e.message}`);
    return tell(i, `Something went wrong: ${e.message}`).catch(() => {});
  }
}

async function command(bot, i) {
  await refreshQuietly(bot);
  const name = i.commandName;
  if (name === "setup") return setup(bot, i);
  if (name === "help") return tell(i, null, { embeds: [helpEmbed({ canRead: bot.canRead })] });
  if (name === "status") return tell(i, null, { embeds: [statusEmbed(bot)] });
  if (!bot.channel) return tell(i, "Bramblewick isn't set up yet. A host runs `/setup` in the channel to play in.");

  // Things only you see work from any channel.
  switch (name) {
    case "people":
      return tell(i, null, { embeds: [peopleEmbed(bot.npcs, bot.state.talking)] });
    case "case":
      return caseFile(bot, i);
    case "inspect":
      if (!bot.mystery) return tell(i, "There's nothing to inspect. Start a case with `/mystery`.");
      return tell(i, null, { embeds: [inspectEmbed(bot.mystery)] });
    case "agent":
      return agent(bot, i);
    case "log":
      return chatLog(bot, i);
    case "model":
      if (!i.options.getString("name")) return tell(i, null, { embeds: [modelsEmbed(bot.models, bot.state.modelId)] });
      break;
    case "town":
      return town(bot, i);
  }

  // Everything else happens at the table.
  if (i.channelId !== bot.channel.id) return tell(i, `The table is in <#${bot.channel.id}>. Play there.`);
  switch (name) {
    case "talk":
      return talk(bot, i);
    case "say":
      return say(bot, i);
    case "leave":
      return leave(bot, i);
    case "reset":
      return reset(bot, i);
    case "accuse":
      return accuse(bot, i);
    case "mystery":
      return mystery(bot, i, i.options.getString("difficulty") || "normal");
    case "options":
      return options(bot, i);
    case "model":
      return switchModel(bot, i);
  }
  return tell(i, `Unknown command /${name}.`);
}

async function button(bot, i) {
  const [kind, arg, arg2] = i.customId.split(":");
  if (kind === "opt") return pick(bot, i, Number(arg));
  if (kind === "leave") return leave(bot, i);
  if (kind === "acc") return accuseAnswer(bot, i, arg, arg2);
  if (kind === "case") {
    await refreshQuietly(bot);
    return mystery(bot, i, arg);
  }
}

// ---- talking --------------------------------------------------------------------------------

async function talk(bot, i) {
  const npc = resolveNpc(bot, i.options.getString("villager"));
  if (!npc) return tell(i, "Nobody by that name around town. `/people` lists everyone.");
  const by = nameOf(i);
  await thinking(bot, `${npc.name} is thinking`, async () => {
    record(bot.state.caseId, { kind: "event", npc: npc.name, text: `${by} walks up to ${npc.name}` });
    await npcTurn(bot, npc, { head: heads.walksUp(by, npc), sink: replySink(i) });
  });
}

async function say(bot, i) {
  const npc = talkingTo(bot);
  if (!npc) return tell(i, "You're not talking to anyone. `/talk` to walk up to someone first.");
  const text = i.options.getString("text").trim();
  const by = nameOf(i);
  await thinking(bot, `${npc.name} is thinking`, () => npcTurn(bot, npc, { line: text, by, head: heads.said(by, text), sink: replySink(i) }));
}

// A suggested-reply button.
async function pick(bot, i, n) {
  const o = bot.state.options;
  if (!o || o.messageId !== i.message.id || o.npc !== bot.state.talking) {
    await i.message.edit({ components: [] }).catch(() => {});
    return tell(i, "That moment has passed. Answer the newest line instead.");
  }
  const npc = npcById(bot, o.npc);
  const line = o.list[n];
  if (!npc || !line) return tell(i, "That reply isn't available any more.");
  await thinking(bot, `${npc.name} is thinking`, async () => {
    await i.update({ components: replyButtons(o.list, { chosen: n }) });
    await npcTurn(bot, npc, { line, by: nameOf(i), head: heads.said(nameOf(i), line), clicked: i.message.id });
  });
}

async function leave(bot, i) {
  const npc = talkingTo(bot);
  if (!npc) return tell(i, "You're not talking to anyone.");
  if (i.isButton() && bot.state.options?.messageId !== i.message.id) {
    await i.message.edit({ components: [] }).catch(() => {});
    return tell(i, "That conversation is already over.");
  }
  if (bot.busy) throw new Busy(bot.busy.label);
  const by = nameOf(i);
  bot.state.talking = null;
  bot.save.soon();
  await i.reply({ ...narration(`👋 **${esc(by)}** walks away from **${esc(npc.name)}**.`), allowedMentions: NO_PINGS });
  record(bot.state.caseId, { kind: "event", npc: npc.name, text: `${by} walks away from ${npc.name}` });
  await stripButtons(bot);
}

async function reset(bot, i) {
  const npc = talkingTo(bot);
  if (!npc) return tell(i, "You're not talking to anyone. `/talk` to walk up to someone first.");
  const by = nameOf(i);
  await thinking(bot, `${npc.name} is thinking`, async () => {
    delete bot.state.histories[npc.id];
    bot.save.soon();
    record(bot.state.caseId, { kind: "event", npc: npc.name, text: `${by} made ${npc.name} forget the conversation` });
    await npcTurn(bot, npc, { head: heads.forgets(npc), sink: replySink(i) });
  });
}

// A line typed in the play channel. While the table is talking to someone, it's said to them
// ("1"-"3" picks a suggested reply, like text mode). Otherwise a villager's name or number walks
// up to them. Anything starting with // is the players talking among themselves.
export async function onMessage(bot, msg) {
  if (msg.author.bot || msg.system || !bot.channel || msg.channelId !== bot.channel.id) return;
  bot.state.lastSeen = Date.now();
  bot.save.soon();
  const text = msg.content.trim();
  if (!text || text.startsWith("//") || text.startsWith("((")) return;
  if (bot.town !== "open") return closedNote(bot, msg);
  if (bot.busy) return react(msg, "⏳");
  const by = msg.member?.displayName || msg.author.displayName;
  try {
    await refreshQuietly(bot);
    const npc = talkingTo(bot);
    if (npc) {
      const o = bot.state.options;
      const n = Number(text);
      const choice = o?.npc === npc.id && Number.isInteger(n) && n >= 1 && n <= o.list.length ? o.list[n - 1] : null;
      return await thinking(bot, `${npc.name} is thinking`, () => npcTurn(bot, npc, { line: choice || text, by, head: choice && heads.said(by, choice), replyTo: msg.id }));
    }
    const walkTo = !/\s/.test(text) && findNpc(bot.npcs, text);
    if (walkTo) {
      return await thinking(bot, `${walkTo.name} is thinking`, () => {
        record(bot.state.caseId, { kind: "event", npc: walkTo.name, text: `${by} walks up to ${walkTo.name}` });
        return npcTurn(bot, walkTo, { replyTo: msg.id, head: heads.walksUp(by, walkTo) });
      });
    }
    if (Date.now() - (bot.lastHint || 0) > HINT_EVERY_MS) {
      bot.lastHint = Date.now();
      await msg.reply({
        content: "-# Nobody's listening. `/talk` to walk up to a villager (or just type their name), `/help` for more. Start a message with `//` to talk among yourselves.",
        allowedMentions: { ...NO_PINGS, repliedUser: false },
      });
    }
  } catch (e) {
    if (e instanceof Busy) return react(msg, "⏳");
    if (e instanceof Closed) return closedNote(bot, msg);
    bot.log(`couldn't answer ${by}: ${e.stack || e.message}`);
  }
}

// Said while the town can't answer (the server is down, or the host closed it): mark it 💤, and
// say why once every couple of minutes rather than answering every message.
async function closedNote(bot, msg) {
  react(msg, "💤");
  if (Date.now() - (bot.lastDownNote || 0) < DOWN_NOTE_EVERY_MS) return;
  bot.lastDownNote = Date.now();
  await msg.reply({ ...narration(bot.townProblem(), 0x9a7b2f), allowedMentions: { ...NO_PINGS, repliedUser: false } }).catch(() => {});
}

const react = (msg, emoji) => msg.react(emoji).catch(() => {});

// ---- the case -------------------------------------------------------------------------------

async function caseFile(bot, i) {
  const c = bot.mystery;
  if (!c) return tell(i, "No case is running. Start one with `/mystery`.");
  await tell(i, null, { embeds: [caseEmbed(c)] });
  if (c.solution) await tell(i, null, { embeds: solutionEmbeds(c) });
}

async function accuse(bot, i) {
  const c = bot.mystery;
  if (!c) return tell(i, "No case is running.");
  if (c.accused) return tell(i, "Someone has already made the accusation. `/case` shows the solution.");
  const arg = i.options.getString("suspect").trim();
  const t = arg.toLowerCase();
  const suspect = c.suspects.find((s, n) => s.id === arg || String(n + 1) === arg || s.name.toLowerCase().split(" ").some((w) => t && w.startsWith(t)));
  if (!suspect) return tell(i, `Accuse whom? ${c.suspects.map((s, n) => `\`${n + 1}\` ${esc(s.name)}`).join("  ")}`);
  return i.reply({
    content: `Accuse **${esc(suspect.name)}**? This ends the case for everyone at the table.`,
    flags: PRIVATE,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`acc:${c.id}:${suspect.id}`).setLabel(`Accuse ${suspect.name}`).setEmoji("⚖️").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("acc:no").setLabel("Not yet").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

async function accuseAnswer(bot, i, caseId, suspectId) {
  if (caseId === "no") return i.update({ content: "You keep your suspicions to yourself.", components: [] });
  const c = bot.mystery;
  const suspect = c?.suspects.find((s) => s.id === suspectId);
  if (!c || c.id !== caseId || c.accused || !suspect) return i.update({ content: "That case is already over.", components: [] });
  if (bot.busy) throw new Busy(bot.busy.label);
  const by = nameOf(i);
  await i.update({ content: `You accuse **${esc(suspect.name)}**.`, components: [] });
  await refreshQuietly(bot);
  if (bot.mystery?.id !== caseId || bot.mystery.accused) return tell(i, "Someone beat you to it: that case is already over.");
  const { correct, case: solved } = await bot.api.post("/api/case/accuse", { suspect: suspectId });
  bot.mystery = solved;
  record(bot.state.caseId, { kind: "event", text: `${by} accused ${suspect.name}: ${correct ? "right" : `wrong, it was ${solved.solution.killer}`}` });
  await announce(bot, i, { embeds: [verdictEmbed({ by, suspect: suspect.name, correct, killer: solved.solution.killer }), ...solutionEmbeds(solved)], components: newCaseButtons() });
  bot.presence();
  await bot.updateStatus();
}

// /mystery, or a "New case" button under a solution.
async function mystery(bot, i, difficulty) {
  if (!["easy", "normal", "hard"].includes(difficulty)) return tell(i, "Pick easy, normal or hard.");
  const c = bot.mystery;
  if (c && !c.accused && !bot.isHost(i)) return tell(i, "A case is still open. Solve it with `/accuse` first, or ask the host to start over.");
  if (i.isButton() && i.channelId !== bot.channel.id) return tell(i, `The table is in <#${bot.channel.id}>.`);
  const by = nameOf(i);
  await thinking(bot, "The director is writing a case", async () => {
    const writing = `🖋️ **${esc(by)}** asked for a new **${difficulty}** case. The director is writing it with **${esc(modelName(bot))}**. On the CPU this takes 1 to 2 minutes…`;
    await i.reply({ ...narration(writing), allowedMentions: NO_PINGS });
    if (i.isButton()) i.message.edit({ components: [] }).catch(() => {});
    try {
      const { embeds } = await newMystery(bot, difficulty, { progress: (s) => i.editReply(narration(`${writing}\n-# ⏱ ${s}s`)) });
      await i.editReply({ content: `🖋️ A new **${difficulty}** case, asked for by **${esc(by)}**.`, embeds });
    } catch (e) {
      const down = bot.apiFailed(e);
      await i.editReply(narration(down ? SERVER_DOWN : `The director couldn't write a case: ${esc(e.message)}. Try \`/mystery\` again.`, 0x9a7b2f));
    }
  });
  bot.presence();
  await bot.updateStatus();
}

// ---- settings and lookups -------------------------------------------------------------------

async function options(bot, i) {
  bot.state.showOptions = i.options.getString("state") === "on";
  bot.save.soon();
  return i.reply(narration(`💬 Suggested replies are **${bot.state.showOptions ? "on" : "off"}**.`));
}

async function agent(bot, i) {
  const v = i.options.getString("villager");
  const npc = v ? resolveNpc(bot, v) : talkingTo(bot);
  if (!npc) return tell(i, v ? "Nobody by that name around town." : "You're not talking to anyone. Name someone: `/agent <villager>`.");
  const full = await bot.api.get(`/api/npcs/${npc.id}`);
  return tell(i, null, { embeds: [agentEmbed(full)] });
}

async function chatLog(bot, i) {
  const v = i.options.getString("villager");
  const npc = v && resolveNpc(bot, v);
  if (v && !npc) return tell(i, "Nobody by that name around town.");
  const title = bot.mystery?.title;
  const md = markdown(bot.state.caseId, { title, npc: npc?.name });
  if (!md) return tell(i, "Nothing has been said in this case yet.");
  const slug = (title || "town").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return tell(i, `The chat log of ${title ? `*${esc(title)}*` : "the town"}${npc ? `, just the parts with ${esc(npc.name)}` : ""}.`, {
    files: [new AttachmentBuilder(Buffer.from(md), { name: `bramblewick-${slug}${npc ? `-${npc.id}` : ""}.md` })],
  });
}

async function switchModel(bot, i) {
  if (!bot.isHost(i)) return tell(i, "Only the host can switch models (they run on the host's laptop).");
  const want = i.options.getString("name").trim().toLowerCase();
  const m = bot.models.find((x) => x.present && (x.id === want || x.name.toLowerCase() === want));
  if (!m) return tell(i, "No downloaded model by that name. `/model` lists them.");
  await thinking(bot, `Loading ${m.name}`, async () => {
    await i.reply(narration(`📦 Switching the town to **${esc(m.name)}**…`));
    try {
      const active = await loadModel(bot, m.id);
      await i.editReply(narration(`📦 The villagers now speak with **${esc(m.name)}**, ${active.device?.mode === "cpu" ? "on the CPU" : "on the GPU"}.`));
    } catch (e) {
      await i.editReply(narration(bot.apiFailed(e) ? SERVER_DOWN : `📦 Couldn't load ${esc(m.name)}: ${esc(e.message)}`, 0x9a7b2f));
    }
  });
  await bot.updateStatus();
}

// ---- host -----------------------------------------------------------------------------------

async function setup(bot, i) {
  if (!bot.isHost(i)) return tell(i, "Only the host can do that.");
  const ch = i.channel;
  if (!ch || !ch.isTextBased() || ch.isThread() || ch.isDMBased() || !ch.permissionOverwrites) return tell(i, "Run `/setup` in an ordinary text channel.");
  await i.deferReply({ flags: PRIVATE });
  const report = await bot.useChannel(ch);
  return i.editReply({ content: report, allowedMentions: NO_PINGS });
}

async function town(bot, i) {
  if (!bot.isHost(i)) return tell(i, "Only the host can do that.");
  if (i.options.getString("action") === "close") {
    if (bot.busy) throw new Busy(bot.busy.label);
    if (bot.state.closedByHost) return tell(i, "The town is already closed. `/town open` reopens it.");
    await i.deferReply({ flags: PRIVATE });
    await bot.closeTown();
    return i.editReply("🔴 Closed. The model is unloaded and the channel is locked. `/town open` reopens it.");
  }
  if (!bot.state.closedByHost) return tell(i, "The town is already open.");
  await i.deferReply({ flags: PRIVATE });
  await bot.openTown();
  return i.editReply(bot.town === "open" ? "🟢 Open again." : `The town can't open right now: ${bot.townProblem()}`);
}

// ---- autocomplete ---------------------------------------------------------------------------

async function autocomplete(bot, i) {
  await refreshQuietly(bot);
  const focused = i.options.getFocused(true);
  const q = focused.value.toLowerCase();
  const has = (...s) => !q || s.some((x) => String(x).toLowerCase().includes(q));
  let choices = [];
  if (focused.name === "villager") choices = bot.npcs.filter((n) => has(n.name, n.title, n.id)).map((n) => ({ name: `${n.name}, ${n.title}`, value: n.id }));
  if (focused.name === "suspect") choices = (bot.mystery?.suspects || []).filter((s) => has(s.name, s.title)).map((s) => ({ name: `${s.name}, ${s.title}`, value: s.id }));
  if (focused.name === "name") {
    choices = bot.models
      .filter((m) => m.present && has(m.name, m.id))
      .map((m) => ({ name: `${m.name} (${m.sizeGB} GB)${m.id === bot.state.modelId ? ", in use" : ""}`, value: m.id }));
  }
  return i.respond(choices.slice(0, 25).map((c) => ({ ...c, name: c.name.slice(0, 100) })));
}

// ---- helpers --------------------------------------------------------------------------------

// A private answer: only the person who asked sees it.
function tell(i, content, extra = {}) {
  const payload = { ...(content ? { content } : {}), flags: PRIVATE, allowedMentions: NO_PINGS, ...extra };
  return i.replied || i.deferred ? i.followUp(payload) : i.reply(payload);
}

// A public message in the play channel, falling back to the interaction if the bot can't post.
async function announce(bot, i, payload) {
  try {
    return await bot.channel.send({ ...payload, allowedMentions: NO_PINGS });
  } catch {
    return i.followUp({ ...payload, allowedMentions: NO_PINGS });
  }
}

async function refreshQuietly(bot) {
  try {
    await refresh(bot, AbortSignal.timeout(1500)); // Discord wants an answer within three seconds
  } catch (e) {
    bot.apiFailed(e);
  }
}

export function nameOf(i) {
  const m = i.member;
  return m?.displayName || m?.nick || i.user.globalName || i.user.username;
}

const talkingTo = (bot) => (bot.state.talking ? npcById(bot, bot.state.talking) : null);

function resolveNpc(bot, value) {
  return bot.npcs.find((n) => n.id === value) || findNpc(bot.npcs, value.trim());
}

