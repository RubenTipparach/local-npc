// How the game looks in Discord: villager lines, the case briefing, the solution, lists and help.
// The wording follows the text mode (scripts/cli.js) so both read the same.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import { cap } from "../scripts/game-client.js";

export const esc = (s) => escapeMarkdown(String(s ?? ""));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const CASE_COLOR = 0x8b1e2d;
const TOWN_COLOR = 0x6b8e4e;

// One villager line. `quote` shows the player's line above it when the channel doesn't already
// show it (a button or /say); `note` is small print underneath.
export function npcLine(npc, text, { quote, intro, note, streaming, earlier } = {}) {
  const lines = [];
  if (intro) lines.push(`-# ${intro}`);
  if (quote) lines.push(`> **${esc(quote.by)}:** ${esc(quote.text)}`);
  const said = text ? `${earlier ? "*(earlier)* " : ""}${esc(text)}${streaming ? " ▍" : ""}` : "*…*";
  lines.push(`**${esc(npc.name)}:** ${said}`);
  if (note) lines.push(`-# ${note}`);
  return clip(lines.join("\n"), 2000);
}

// The suggested replies as buttons, plus a way to walk off. `chosen` marks the one picked.
export function replyButtons(options, { chosen = -1, disabled = false } = {}) {
  const rows = [];
  if (options.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        options.map((o, i) =>
          new ButtonBuilder()
            .setCustomId(`opt:${i}`)
            .setLabel(clip(`${i + 1}. ${o}`, 80))
            .setStyle(i === chosen ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(disabled || chosen >= 0),
        ),
      ),
    );
  }
  if (chosen < 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("leave").setLabel("Walk away").setEmoji("👋").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      ),
    );
  }
  return rows;
}

// The preamble: who died, where, when, how, and what to follow up on.
export function caseEmbed(c) {
  const e = new EmbedBuilder()
    .setColor(CASE_COLOR)
    .setTitle(clip(`☠ ${c.title}`, 256))
    .setDescription(clip(esc(c.discovery), 4000))
    .addFields(
      { name: "Who", value: clip(`${esc(c.victim.name)}, ${esc(c.victim.title)}. ${esc(c.victimBio)}`, 1024) },
      { name: "Where", value: clip(esc(cap(c.scene)), 1024), inline: true },
      { name: "When", value: clip(`${esc(cap(c.timeOfDeath))}. Found at 6 AM by ${esc(c.finder)}.`, 1024), inline: true },
      { name: "How", value: clip(esc(cap(c.weapon)), 1024) },
      { name: "Leads", value: clip(c.leads.map((l) => `• ${esc(l)}`).join("\n"), 1024) },
      { name: "Suspects", value: clip(c.suspects.map((s, i) => `\`${i + 1}\` ${esc(s.name)}`).join("  "), 1024) },
    )
    .setFooter({ text: `${cap(c.difficulty)} case · /talk to question people · /case shows this again · /accuse when you're sure` });
  return e;
}

export function solutionEmbeds(c) {
  const s = c.solution;
  const lines = [`**What happened:** at ${s.murderTime}. ${esc(s.motive)}`];
  for (const l of s.liars) lines.push(`**${esc(l.name)}** lied. They were really ${esc(l.truth)}. ${esc(l.secret)}`);
  // One small card per villager (three to a row on a computer, stacked on a phone).
  const where = s.timeline.slice(0, 25).map((r) => ({ name: clip(r.name, 256), value: clip(r.slots.map(esc).join("\n"), 1024), inline: true }));
  return [
    new EmbedBuilder().setColor(CASE_COLOR).setTitle(clip(`The solution: ${s.killer} did it`, 256)).setDescription(clip(lines.join("\n\n"), 4000)),
    new EmbedBuilder().setColor(CASE_COLOR).setTitle("Where everyone really was").addFields(where),
  ];
}

export function newCaseButtons() {
  return [
    new ActionRowBuilder().addComponents(
      ["easy", "normal", "hard"].map((d) =>
        new ButtonBuilder().setCustomId(`case:${d}`).setLabel(`New ${d} case`).setStyle(d === "normal" ? ButtonStyle.Primary : ButtonStyle.Secondary),
      ),
    ),
  ];
}

export function peopleEmbed(npcs, talking) {
  return new EmbedBuilder()
    .setColor(TOWN_COLOR)
    .setTitle("Around town")
    .setDescription(
      npcs.map((n, i) => `\`${String(i + 1).padStart(2)}\` **${esc(n.name)}**, ${esc(n.title)}${n.id === talking ? "  🗨 *talking now*" : ""}`).join("\n") ||
        "Nobody's around.",
    )
    .setFooter({ text: "/talk <name> to walk up to someone" });
}

// Public = everyone in the channel sees it; private = only you see the answer.
export function helpEmbed({ canRead }) {
  return new EmbedBuilder()
    .setColor(TOWN_COLOR)
    .setTitle("Bramblewick")
    .setDescription(
      "Every game is a murder mystery. Question the villagers, compare their stories and accuse the killer. " +
        "The whole channel plays one case together: everyone sees what the villagers say, and while one of them is " +
        "thinking the channel is locked so nobody talks over them.",
    )
    .addFields(
      {
        name: "Talking (everyone sees)",
        value: [
          "`/talk <villager>` walk up to someone and talk",
          canRead
            ? "Then just **type** in the channel to talk to them (`/say <text>` works too). Type `1`–`3` or click a button to pick a suggested reply."
            : "`/say <text>` say something to them, or click a button to pick a suggested reply.",
          canRead && "Start a message with `//` to talk to the table instead of the villager.",
          "`/leave` walk away · `/reset` make them forget your conversation",
          "`/accuse <suspect>` name the killer (ends the case) · `/mystery [easy|normal|hard]` start a new case",
          "`/options on|off` suggested replies (off is faster on CPU)",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        name: "Just for you (only you see the answer)",
        value: [
          "`/case` the briefing: who, where, when, leads, suspects",
          "`/inspect` examine the crime scene",
          "`/people` who's around town",
          "`/agent [villager]` read a villager's agent.md (spoilers!)",
          "`/model` the models on the host's laptop",
          "`/log [villager]` the chat log of this case, as a file",
          "`/status` is the town open, what's loaded, who's thinking",
        ].join("\n"),
      },
      {
        name: "Host",
        value: "`/setup` play in this channel · `/town open|close` open or close for the night · `/model <name>` switch models",
      },
    );
}

export function modelsEmbed(models, currentId) {
  const present = models.filter((m) => m.present);
  const missing = models.length - present.length;
  return new EmbedBuilder()
    .setColor(TOWN_COLOR)
    .setTitle("Models")
    .setDescription(
      present.map((m) => `${m.id === currentId ? "🟢" : "▫️"} **${esc(m.name)}** · ${m.sizeGB} GB`).join("\n") + (missing ? `\n-# ${missing} more not downloaded.` : ""),
    )
    .setFooter({ text: "The host switches with /model <name>" });
}

export function agentEmbed(npc) {
  const body = clip(npc.raw, 3900);
  return new EmbedBuilder()
    .setColor(TOWN_COLOR)
    .setTitle(`npcs/${npc.id}/agent.md`)
    .setDescription(`\`\`\`md\n${body.replace(/```/g, "ʼʼʼ")}\n\`\`\``);
}

const at = (ms, style = "R") => `<t:${Math.floor(ms / 1000)}:${style}>`;

// The one status message the bot keeps at the bottom of the play channel: open, closed, asleep.
export function statusText(kind, { hostId, since, mystery, model, canRead, notes = [] }) {
  const host = hostId ? `<@${hostId}>'s` : "the host's";
  const now = Date.now();
  const lines = [];
  if (kind === "open") {
    lines.push("🟢 **Bramblewick is open.**");
    const bits = [mystery ? `Case: *${esc(mystery.title)}* (${mystery.difficulty}${mystery.accused ? ", solved" : ""})` : "No case yet: start one with `/mystery`"];
    if (model) bits.push(`Model: ${esc(model)}`);
    lines.push(bits.join(" · "));
    lines.push(`-# Runs on ${host} laptop, so the town is only open while it's on. Open since ${at(since, "t")}.`);
    lines.push(
      canRead
        ? "-# `/talk` to walk up to someone, then just type to talk to them. Start a message with `//` to talk among yourselves. `/help` for everything."
        : "-# `/talk` to walk up to someone and `/say` to talk to them. `/help` for everything.",
    );
  } else if (kind === "offline") {
    lines.push(`🔴 **Bramblewick is closed.** ${cap(host)} laptop went offline ${at(now)}.`);
    lines.push("-# The case and everyone's memories are kept. The town reopens when the laptop is back.");
  } else if (kind === "closed") {
    lines.push(`🔴 **Bramblewick is closed for now.** The host closed it ${at(now)}.`);
    lines.push("-# The case and everyone's memories are kept.");
  } else if (kind === "down") {
    lines.push(`🟡 **The villagers are asleep.** The game server on ${host} laptop stopped ${at(now)}. Trying to wake it…`);
  } else if (kind === "nomodel") {
    lines.push(`🟡 **Bramblewick can't open yet.** No models are downloaded on ${host} laptop.`);
  }
  for (const n of notes) lines.push(`-# ${n}`);
  return lines.join("\n");
}

export function statusEmbed(bot) {
  const t = bot.town;
  const town = {
    open: `🟢 Open since ${at(bot.onlineSince || Date.now())}`,
    closed: "🔴 Closed by the host",
    down: "🟡 The game server isn't answering",
    nomodel: "🟡 No models downloaded",
  }[t];
  const a = bot.active;
  const model = bot.models.find((m) => m.id === bot.state.modelId);
  const loaded = a?.model?.id === bot.state.modelId && a?.status === "ready";
  const talking = bot.npcs.find((n) => n.id === bot.state.talking);
  const c = bot.mystery;
  return new EmbedBuilder()
    .setColor(t === "open" ? TOWN_COLOR : 0x9a7b2f)
    .setTitle("Bramblewick status")
    .addFields(
      { name: "Town", value: town, inline: true },
      { name: "Right now", value: bot.busy ? `💭 ${esc(bot.busy.label)} (${at(bot.busy.since)})` : "Nobody's thinking", inline: true },
      { name: "Model", value: model ? `${esc(model.name)} · ${loaded ? `loaded on the ${a.device?.mode === "cpu" ? "CPU" : "GPU"}` : "loads on the next line"}` : "None", inline: true },
      { name: "Case", value: c ? `*${esc(c.title)}* (${c.difficulty}${c.accused ? ", solved" : ""})` : "None", inline: true },
      { name: "Talking to", value: talking ? esc(talking.name) : "Nobody", inline: true },
      { name: "Suggested replies", value: bot.state.showOptions ? "On" : "Off", inline: true },
      { name: "Play channel", value: bot.channel ? `<#${bot.channel.id}>` : "Not set up (`/setup`)", inline: true },
      { name: "Chat lock while thinking", value: bot.lock.available ? "✅ Working" : `⚠️ Off: ${bot.lock.problem}`, inline: false },
      { name: "Typing to talk", value: bot.canRead ? "✅ On" : "⚠️ Off: turn on the Message Content intent in the Developer Portal (Bot tab). `/say` works meanwhile.", inline: false },
    );
}
