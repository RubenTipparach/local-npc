// How the game looks in Discord: villager lines, the case briefing, the solution, lists and help.
// The wording follows the text mode (scripts/cli.js) so both read the same.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import { cap } from "../scripts/game-client.js";
import { publicLink } from "./store.js";

export const esc = (s) => escapeMarkdown(String(s ?? ""));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const CASE_COLOR = 0x8b1e2d;
const TOWN_COLOR = 0x6b8e4e;

// One villager line, in a box the colour of their shirt (their sprite's colour in the browser
// game). `head` is a line above the box: who walked up, or what a player said when the channel
// doesn't already show it (a button, a picked number, /say). `note` is the small print underneath.
export function villagerPost(npc, text, { head, note, earlier, thinking } = {}) {
  const said = thinking ? `💭 *${esc(npc.name)} is thinking…*` : `${earlier ? "*(earlier)* " : ""}${esc(text)}`;
  const box = new EmbedBuilder().setColor(shirtColor(npc)).setAuthor({ name: clip(`${npc.name}, ${npc.title}`, 256) }).setDescription(clip(said, 4000));
  if (note) box.setFooter({ text: clip(note, 2048) });
  return { content: head ? clip(head, 2000) : "", embeds: [box] };
}

// Lightened a little so dark shirts still stand out against Discord's dark theme.
function shirtColor(npc) {
  if (!/^#[0-9a-f]{6}$/i.test(npc.shirt || "")) return TOWN_COLOR;
  const n = parseInt(npc.shirt.slice(1), 16);
  const lift = (c) => Math.round(c + (255 - c) * 0.3);
  return (lift(n >> 16) << 16) | (lift((n >> 8) & 255) << 8) | lift(n & 255);
}

// A line of narration (someone walks away, a setting changes), boxed like the rest of the story.
export function narration(text, color = TOWN_COLOR) {
  return { content: "", embeds: [new EmbedBuilder().setColor(color).setDescription(clip(text, 4000))] };
}

// The line above a villager's box.
export const heads = {
  walksUp: (by, npc) => `🚶 **${esc(by)}** walks up to **${esc(npc.name)}**, ${esc(npc.title)}.`,
  said: (by, text) => `🗨 **${esc(by)}:** ${esc(text)}`,
  forgets: (npc) => `🧹 **${esc(npc.name)}** forgets your whole conversation.`,
};

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

// The one status message the bot keeps at the bottom of the play channel, boxed in the colour of
// the state: green open, red closed or down, yellow waiting on the laptop.
const STATUS = {
  open: [0x23a55a, "🟢 Bramblewick is open"],
  offline: [0xda373c, "🔴 The server is down"],
  closed: [0xda373c, "🔴 Bramblewick is closed for now"],
  down: [0xf0b232, "🟡 The server is down"],
  nomodel: [0xf0b232, "🟡 Bramblewick can't open yet"],
};

export function statusPost(kind, { hostId, since, mystery, model, canRead, link, notes = [] }) {
  const host = hostId ? `<@${hostId}>'s` : "the host's";
  const now = Date.now();
  const lines = [];
  if (kind === "open") {
    lines.push(mystery ? `**Case:** *${esc(mystery.title)}* (${mystery.difficulty}${mystery.accused ? ", solved" : ""})` : "**No case yet:** start one with `/mystery`.");
    if (model) lines.push(`**Model:** ${esc(model)}`);
    // Angle brackets keep Discord from unfurling the page into a big preview.
    if (link) lines.push(`🌐 **Watch the town:** <${link}>`);
    lines.push(`Runs on ${host} laptop, so the town is only open while it's on. Open since ${at(since, "t")}.`);
  } else if (kind === "offline") {
    lines.push(`${cap(host)} laptop went offline ${at(now)}, so the town is closed. **Try again later.**`, "The case and everyone's memories are kept.");
  } else if (kind === "closed") {
    lines.push(`The host closed the town ${at(now)}. **Try again later.**`, "The case and everyone's memories are kept.");
  } else if (kind === "down") {
    lines.push(`The game stopped on ${host} laptop ${at(now)} and is restarting. **Try again in a minute.**`);
  } else if (kind === "nomodel") {
    lines.push(`No models are downloaded on ${host} laptop yet.`);
  }
  for (const n of notes) lines.push(`*${n}*`);
  const [color, title] = STATUS[kind];
  const box = new EmbedBuilder().setColor(color).setTitle(title).setDescription(clip(lines.join("\n"), 4000));
  if (kind === "open") {
    box.setFooter({
      text: canRead
        ? "/talk to walk up to someone, then just type to talk to them. Start a message with // to talk among yourselves. /help for everything."
        : "/talk to walk up to someone and /say to talk to them. /help for everything.",
    });
  }
  return { content: "", embeds: [box] };
}

export function verdictEmbed({ by, suspect, correct, killer }) {
  return new EmbedBuilder()
    .setColor(correct ? 0x23a55a : 0xda373c)
    .setTitle(clip(`⚖️ ${by} accuses ${suspect}`, 256))
    .setDescription(correct ? `✅ **You got it.** ${esc(killer)} did it.` : `❌ **Wrong.** It was ${esc(killer)}.`);
}

export function inspectEmbed(c) {
  return new EmbedBuilder().setColor(CASE_COLOR).setTitle(clip(`At ${cap(c.scene)}`, 256)).setDescription(clip(esc(c.evidence), 4000));
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
      { name: "Watch link", value: publicLink() ? `<${publicLink()}> (view only)` : "None (the host can open one with `npm run tunnel`)", inline: false },
      { name: "Chat lock while thinking", value: bot.lock.available ? "✅ Working" : `⚠️ Off: ${bot.lock.problem}`, inline: false },
      { name: "Typing to talk", value: bot.canRead ? "✅ On" : "⚠️ Off: turn on the Message Content intent in the Developer Portal (Bot tab). `/say` works meanwhile.", inline: false },
    );
}
