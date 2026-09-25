// End-to-end test of the Discord bot, with no real Discord and no real model:
//   - the real game server runs from a scratch copy of the repo, on a fake llama-server
//     (test/fake-llama.cjs) that answers instantly and repeats back what the player said;
//   - the real bot (scripts/play.js --discord) talks to a mock Discord (test/mock-discord.js);
//   - the test plays through a case as three people and checks what the channel shows, that the
//     channel locks while a villager is thinking, and what happens when things go offline.
//
//   node test/discord-bot.test.js           (VERBOSE=1 to see the bot's own log)
//
// Linux and macOS only (the fake llama-server is started through a shell script).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MockDiscord, IDS } from "./mock-discord.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_PORT = 20000 + Math.floor(Math.random() * 5000);
const LLAMA_PORT = 26000 + Math.floor(Math.random() * 5000);
const EPHEMERAL = 64;
const MESSAGE_CONTENT_INTENT = 1 << 15;

let failed = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} ${dim(`${Date.now() - t} ms`)}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e.stack.split("\n").slice(0, 4).join("\n    ")}`);
    if (!process.env.KEEP_GOING) throw e;
  }
}
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a scratch copy of the game ---------------------------------------------------------------

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bramblewick-"));
  for (const d of ["server", "npcs", "config", "scripts", "discord", "test", "public"]) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(dir, "package.json"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  fs.mkdirSync(path.join(dir, "models"));
  fs.writeFileSync(path.join(dir, "models", "fake-model.gguf"), "not really a model");
  const exe = path.join(dir, "runtime", "llama.cpp", "llama-server");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "test", "fake-llama.cjs")}" "$@"\n`, { mode: 0o755 });
  return dir;
}

function startBot(dir, mock, extraEnv = {}, extraArgs = []) {
  const p = spawn(process.execPath, ["scripts/play.js", "--discord", ...extraArgs], {
    cwd: dir,
    detached: true, // its own process group, so "Ctrl+C" reaches the game server too, like a console
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(GAME_PORT),
      LLAMA_PORT: String(LLAMA_PORT),
      LLAMA_DEVICE: "cpu",
      DISCORD_TOKEN: "test-token",
      DISCORD_API: mock.api,
      FAKE_LLAMA_MS: "250",
      NO_COLOR: "1",
      ...extraEnv,
    },
  });
  p.log = "";
  const onData = (d) => {
    p.log += d;
    if (process.env.VERBOSE) process.stdout.write(dim(`    bot| ${String(d).trimEnd().replace(/\n/g, "\n    bot| ")}\n`));
  };
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  p.exited = new Promise((r) => p.on("exit", (code, signal) => r({ code, signal })));
  return p;
}

const game = async (p) => (await fetch(`http://127.0.0.1:${GAME_PORT}${p}`)).json();

// ---- helpers over the mock --------------------------------------------------------------------

const isPrivate = (msg) => !!(msg.flags & EPHEMERAL);
const text = (msg) =>
  [msg.content, ...msg.embeds.map((e) => [e.author?.name, e.title, e.description, ...(e.fields || []).map((f) => `${f.name} ${f.value}`), e.footer?.text].filter(Boolean).join(" "))]
    .filter(Boolean)
    .join(" ");
const buttons = (msg) => msg.components.flatMap((r) => r.components);

// The first answer to an interaction (its reply, or the edit of a deferred reply).
async function answer(mock, token, what = "an answer") {
  return mock.waitFor(what, () => {
    const r = mock.response(token);
    return r?.original && !r.original.deferred ? r.original : r?.followups[0];
  });
}

// The status message is a box whose title starts with its colour.
const isStatus = (m) => m.author.id === IDS.bot && /^(🟢|🔴|🟡)/.test(m.embeds?.[0]?.title || "");
const statusMessage = (mock) => mock.lastBotMessage(isStatus);
const status = (mock) => (statusMessage(mock) ? text(statusMessage(mock)) : "");
// A villager's line is a box with their name on top.
const npcMessages = (mock, name) => mock.channelMessages().filter((m) => m.author.id === IDS.bot && m.embeds?.[0]?.author?.name?.startsWith(`${name},`));

// ---- the test ---------------------------------------------------------------------------------

async function main() {
  const dir = sandbox();
  const mock = await new MockDiscord().start();
  let bot = startBot(dir, mock);
  let npc; // who we question
  let caseInfo;
  console.log(`Bramblewick Discord bot, end to end ${dim(dir)}`);

  try {
    await step("connects, asks for typing access and registers every command", async () => {
      await mock.waitFor("identify", () => mock.identifies.length);
      assert.ok(mock.identifies[0].intents & MESSAGE_CONTENT_INTENT, "asks for message content");
      await mock.waitFor("17 commands", () => mock.commands.length === 17);
      await mock.waitFor("setup hint", () => bot.log.includes("type /setup"));
    });

    await step("/setup: players can't, the host can; the bot can still speak while the channel is locked", async () => {
      const no = await answer(mock, mock.command("setup", {}, { as: "alice" }));
      assert.ok(isPrivate(no) && no.content.includes("Only the host"));
      const yes = await answer(mock, mock.command("setup", {}, { as: "host" }), "the setup report");
      assert.ok(isPrivate(yes));
      assert.match(yes.content, /plays in <#\d+> now/);
      assert.match(yes.content, /✅ Locks the channel while a villager is thinking/);
      assert.match(yes.content, /✅ Players can just type/);
      const mine = mock.overwrites.get(IDS.channel).find((o) => o.id === IDS.bot);
      assert.ok(mine && BigInt(mine.allow) & (1n << 11n), "bot allowed to send");
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "data", "discord.json"), "utf8"));
      assert.equal(saved.channelId, IDS.channel);
      assert.match(status(mock), /🟢 Bramblewick is open/);
    });

    await step("loads the model at once, locking the channel meanwhile", async () => {
      await mock.waitFor("model loaded", () => bot.log.includes("is loaded"));
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
      const locks = mock.calls.filter((c) => c.method === "PUT" && c.path === `/channels/${IDS.channel}/permissions/${IDS.guild}`);
      assert.ok(locks.some((c) => BigInt(c.body.deny) & (1n << 11n)), "locked while loading");
    });

    await step("/mystery: the director writes a case, in public", async () => {
      const token = mock.command("mystery", { difficulty: "normal" });
      const msg = await answer(mock, token);
      assert.ok(!isPrivate(msg));
      assert.match(text(mock.response(token).callbacks[0].data), /director is writing it/);
      await mock.waitFor("case briefing", () => msg.embeds[0]?.title?.startsWith("☠"));
      assert.match(text(msg), /Leads/);
      assert.match(text(msg), /Suspects/);
      caseInfo = (await game("/api/case")).case;
      const npcs = await game("/api/npcs");
      npc = npcs.find((n) => n.id !== caseInfo.victim.id && n.size !== "small");
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
    });

    await step("/talk: a thinking post while they think, then it's deleted and the answer is posted", async () => {
      const token = mock.command("talk", { villager: npc.id });
      const thinking = await answer(mock, token);
      assert.match(thinking.content, new RegExp(`walks up to \\*\\*${npc.name}\\*\\*`));
      assert.ok(text(thinking).includes(`💭 *${npc.name} is thinking…*`), "a thinking post first");
      await mock.waitFor("typing indicator", () => mock.typing > 0);
      const reply = await mock.waitFor("reply buttons", () => npcMessages(mock, npc.name).find((m) => buttons(m).length === 4));
      assert.ok(mock.deleted.has(thinking.id), "the thinking post is deleted");
      assert.notEqual(reply.id, thinking.id, "the answer is a new post");
      assert.equal(reply.content, thinking.content, "with the same line above it");
      assert.equal(reply.edits, 0, "posted whole, never edited");
      assert.equal(npcMessages(mock, npc.name).length, 1, "one post left for the walk-up");
      assert.match(reply.embeds[0].description, /What brings you down to the river\?/);
      assert.deepEqual(
        buttons(reply).map((b) => b.label),
        ["1. Where were you at ten?", "2. Who did you see by the mill?", "3. Thanks, I'll be off.", "Walk away"],
      );
      assert.equal(reply.embeds[0].footer.text, "fake-model · 12.5 tok/s · pick a reply or type your own");
      const lift = (c) => Math.round(c + (255 - c) * 0.3);
      const shirt = parseInt(npc.shirt.slice(1), 16);
      assert.equal(reply.embeds[0].color, (lift(shirt >> 16) << 16) | (lift((shirt >> 8) & 255) << 8) | lift(shirt & 255), "boxed in the villager's shirt colour");
    });

    await step("typing talks to the villager; the channel locks until they're done", async () => {
      const bobs = mock.say("where were you last night?", { as: "bob" });
      await mock.waitFor("locked", () => mock.everyoneSend() === "deny");
      await mock.waitFor("red presence while thinking", () => mock.presences.at(-1)?.status === "dnd");
      assert.match(mock.presences.at(-1).activities[0].state, /💭 .* is thinking/);
      // Someone who can type anyway (an admin) isn't heard...
      const alices = mock.say("hurry up!", { as: "alice" });
      await mock.waitFor("⏳ reaction", () => mock.reactions.some((r) => r.messageId === alices && r.emoji === "⏳"));
      await sleep(300);
      assert.ok(!mock.channelMessages().some((m) => text(m).includes("aren't heard")), "no extra post, just the ⏳");
      // ...and commands that would make them think again are turned away, privately.
      const busy = await answer(mock, mock.command("say", { text: "me next" }));
      assert.ok(isPrivate(busy));
      assert.match(busy.content, /⏳ .* is thinking/);
      const thinkingPost = mock.channelMessages().find((m) => m.message_reference?.message_id === bobs && text(m).includes("is thinking"));
      assert.ok(thinkingPost, "a thinking post answers Bob right away");
      const reply = await mock.waitFor("answer", () => npcMessages(mock, npc.name).find((m) => text(m).includes('You ask me "where were you last night?"') && buttons(m).length));
      assert.equal(reply.message_reference?.message_id, bobs, "answers Bob's message");
      assert.ok(mock.deleted.has(thinkingPost.id), "and the thinking post is gone");
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
      assert.ok(!npcMessages(mock, npc.name).some((m) => text(m).includes("hurry up")), "the unheard line never reached the villager");
    });

    let first;
    await step("a suggested-reply button: marks the pick, quotes it, strips the old buttons", async () => {
      const msgs = npcMessages(mock, npc.name);
      first = msgs[0];
      const current = msgs.at(-1);
      assert.equal(buttons(first).length, 0, "older line lost its buttons");
      mock.click(current.id, "opt:1", { as: "bob" });
      await mock.waitFor("pick marked", () => buttons(current)[1]?.style === 1 && buttons(current).every((b) => b.disabled));
      const reply = await mock.waitFor("answer", () => npcMessages(mock, npc.name).find((m) => m.content === "🗨 **Bob:** Who did you see by the mill?" && buttons(m).length));
      assert.match(reply.embeds[0].description, /You ask me "Who did you see by the mill\?"/);
    });

    await step("typing 1-3 picks a suggested reply, like text mode", async () => {
      mock.say("3", { as: "alice" });
      await mock.waitFor("answer", () => npcMessages(mock, npc.name).find((m) => m.content === "🗨 **Alice:** Thanks, I'll be off." && buttons(m).length));
    });

    await step("an old button says the moment has passed", async () => {
      const r = await answer(mock, mock.click(first.id, "opt:0"));
      assert.ok(isPrivate(r));
      assert.match(r.content, /moment has passed/);
    });

    await step("lookups answer only the person who asked", async () => {
      const ask = async (name, opts = {}) => {
        const r = await answer(mock, mock.command(name, opts, { as: "bob", channel: IDS.general }), `/${name}`);
        assert.ok(isPrivate(r), `/${name} is private`);
        return r;
      };
      assert.match(text(await ask("people")), new RegExp(`${npc.name}.*talking now`));
      assert.match(text(await ask("case")), /☠/);
      assert.match(text(await ask("inspect")), /torn scrap of cloth/);
      assert.match(text(await ask("agent", { villager: npc.id })), new RegExp(`npcs/${npc.id}/agent.md`));
      assert.match(text(await ask("status")), /Open since/);
      assert.match(text(await ask("help")), /Just for you/);
      assert.match(text(await ask("model")), /fake-model/);
      const log = await ask("log");
      assert.equal(log.attachments.length, 1);
      assert.match(log.attachments[0].filename, /^bramblewick-.*\.md$/);
      assert.match(log.attachments[0].text, /\*\*Bob\*\* to .*: where were you last night\?/);
      assert.match(log.attachments[0].text, /walks up to/);
      const away = await answer(mock, mock.command("talk", { villager: npc.id }, { channel: IDS.general }));
      assert.ok(isPrivate(away) && away.content.includes("The table is in"));
    });

    await step("autocomplete for villagers, suspects and models", async () => {
      const t1 = mock.autocomplete("talk", "villager", npc.name.slice(0, 3).toLowerCase());
      const c1 = await mock.waitFor("villager choices", () => mock.response(t1).choices);
      assert.ok(c1.some((c) => c.value === npc.id));
      assert.ok(!c1.some((c) => c.value === caseInfo.victim.id), "the victim isn't around to talk to");
      const t2 = mock.autocomplete("accuse", "suspect", "");
      assert.equal((await mock.waitFor("suspects", () => mock.response(t2).choices)).length, caseInfo.suspects.length);
      const t3 = mock.autocomplete("model", "name", "fake");
      assert.match((await mock.waitFor("models", () => mock.response(t3).choices))[0].name, /fake-model.*in use/);
    });

    await step("/leave, then table talk is left alone, and a name walks back up", async () => {
      const bye = await answer(mock, mock.command("leave"));
      assert.match(text(bye), /walks away from/);
      await mock.waitFor("nothing left to click", () => npcMessages(mock, npc.name).every((m) => buttons(m).every((b) => b.disabled)));
      const before = npcMessages(mock, npc.name).length;
      mock.say("// I think it was the baker", { as: "bob" });
      mock.say("what do we do now?", { as: "alice" });
      await mock.waitFor("hint", () => mock.channelMessages().some((m) => m.content.includes("Nobody's listening")));
      assert.equal(npcMessages(mock, npc.name).length, before);
      mock.say(npc.name.split(" ")[0].toLowerCase(), { as: "alice" });
      const back = await mock.waitFor("walks back", () => npcMessages(mock, npc.name).find((m) => text(m).includes("*(earlier)*") && buttons(m).length));
      assert.match(back.content, /^🚶 \*\*Alice\*\* walks up to/);
    });

    await step("/reset makes them forget", async () => {
      const r = await answer(mock, mock.command("reset"));
      assert.match(r.content, /forgets your whole conversation/);
      await mock.waitFor("fresh greeting", () => npcMessages(mock, npc.name).filter((m) => text(m).includes("What brings you")).length === 2);
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
    });

    await step("only the host switches models", async () => {
      const r = await answer(mock, mock.command("model", { name: "fake-model" }));
      assert.ok(isPrivate(r) && r.content.includes("Only the host"));
      const h = await answer(mock, mock.command("model", { name: "fake-model" }, { as: "host" }));
      await mock.waitFor("switched", () => text(h).includes("now speak with **fake-model**"));
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
    });

    await step("/accuse: a private are-you-sure, then the verdict for everyone", async () => {
      const killer = caseInfo.suspects[0];
      const sure = await answer(mock, mock.command("accuse", { suspect: killer.id }));
      assert.ok(isPrivate(sure));
      const yes = buttons(sure).find((b) => b.custom_id.startsWith("acc:"));
      mock.click(sure.id, yes.custom_id);
      const verdict = await mock.waitFor("verdict", () => mock.lastBotMessage((m) => m.embeds[0]?.title?.startsWith("⚖️")));
      assert.match(text(verdict), /(You got it|Wrong)/);
      assert.equal(verdict.embeds.length, 3, "verdict, solution and timeline in one post");
      assert.deepEqual(buttons(verdict).map((b) => b.custom_id), ["case:easy", "case:normal", "case:hard"]);
      assert.ok((await game("/api/case")).case.accused);
      const again = await answer(mock, mock.command("accuse", { suspect: killer.id }));
      assert.match(again.content, /already made the accusation/);
    });

    await step("/town close: closed status, locked channel, nobody's heard; /town open reopens", async () => {
      const r = await answer(mock, mock.command("town", { action: "close" }, { as: "host" }));
      assert.match(r.content, /Closed/);
      await mock.waitFor("closed status", () => status(mock).includes("closed for now"));
      assert.equal(mock.everyoneSend(), "deny");
      const said = mock.say("hello?", { as: "alice" });
      await mock.waitFor("💤", () => mock.reactions.some((x) => x.messageId === said && x.emoji === "💤"));
      const t = await answer(mock, mock.command("talk", { villager: npc.id }));
      assert.match(t.content, /closed for now/);
      await mock.waitFor("idle presence", () => mock.presences.at(-1)?.status === "idle");
      await answer(mock, mock.command("town", { action: "open" }, { as: "host" }));
      await mock.waitFor("open status", () => status(mock).includes("🟢 Bramblewick is open"));
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
      assert.equal(mock.channelMessages().filter(isStatus).length, 1, "only one status message in the channel");
    });

    await step("the game server dies: the channel hears, locks, and reopens when it's restarted", async () => {
      const pid = await serverPid(dir);
      process.kill(pid, "SIGKILL");
      await answer(mock, mock.command("status"));
      await answer(mock, mock.command("status"));
      await mock.waitFor("server down status", () => status(mock).includes("🟡 The server is down") && status(mock).includes("restarting"), 20000);
      assert.equal(mock.everyoneSend(), "deny");
      const t = await answer(mock, mock.command("talk", { villager: npc.id }));
      assert.match(t.content, /server is down right now.*Try again later/);
      const typed = mock.say("hello?", { as: "bob" });
      await mock.waitFor("💤", () => mock.reactions.some((x) => x.messageId === typed && x.emoji === "💤"));
      await mock.waitFor("one server-down reply", () => mock.channelMessages().some((m) => m.message_reference?.message_id === typed && text(m).includes("server is down")));
      const again = mock.say("anyone?", { as: "alice" });
      await mock.waitFor("💤 again", () => mock.reactions.some((x) => x.messageId === again));
      await sleep(300);
      assert.ok(!mock.channelMessages().some((m) => m.message_reference?.message_id === again), "said once, not to every message");
      await mock.waitFor("back status", () => status(mock).includes("The game server is back"), 40000);
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
    });

    await step("a case started from the browser shows up here too", async () => {
      await fetch(`http://127.0.0.1:${GAME_PORT}/api/case`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ difficulty: "hard", model: "fake-model" }) });
      await mock.waitFor("status mentions the new case", () => status(mock).includes("(hard)"), 25000);
      await mock.waitFor("presence names it", () => mock.presences.at(-1)?.activities[0].state.startsWith("🕵️"));
      const r = await answer(mock, mock.command("say", { text: "hello?" }));
      assert.match(r.content, /not talking to anyone/, "the old conversation belonged to the old case");
      caseInfo = (await game("/api/case")).case;
      npc = (await game("/api/npcs")).find((n) => n.id !== caseInfo.victim.id && n.size !== "small");
      await answer(mock, mock.command("talk", { villager: npc.id }));
      await mock.waitFor("greeting", () => npcMessages(mock, npc.name).some((m) => buttons(m).length === 4 && text(m).includes("What brings you")));
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
    });

    await step("a short network blip doesn't bother the channel", async () => {
      const before = statusMessage(mock).id;
      mock.dropConnections(4000);
      await mock.waitFor("reconnected", () => bot.log.includes("Back on Discord"), 20000);
      await sleep(500);
      assert.equal(statusMessage(mock).id, before);
    });

    await step("Ctrl+C: posts 'closed', locks the channel, exits cleanly", async () => {
      process.kill(-bot.pid, "SIGINT");
      const { code } = await bot.exited;
      assert.equal(code, 0);
      assert.match(status(mock), /🔴 The server is down <@\d+>'s laptop went offline .*Try again later/);
      assert.equal(mock.channelMessages().filter(isStatus).length, 1);
      assert.equal(mock.everyoneSend(), "deny");
      const state = JSON.parse(fs.readFileSync(path.join(dir, "data", "discord-state.json"), "utf8"));
      assert.equal(state.cleanExit, true);
      assert.equal(state.lock.locked, true);
    });

    await step("back online: unlocks, says who talked to an empty town, remembers the conversation", async () => {
      mock.say("anyone home?", { as: "host" }); // an admin can post into a locked channel
      bot = startBot(dir, mock);
      await mock.waitFor("open again", () => status(mock).includes("🟢 Bramblewick is open"), 20000);
      assert.match(status(mock), /1 message came in while the town was away/);
      assert.doesNotMatch(status(mock), /unexpectedly/);
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
      await mock.waitFor("model loaded", () => bot.log.includes("is loaded"));
      await mock.waitFor("unlocked after loading", () => mock.everyoneSend() === null);
      const state = JSON.parse(fs.readFileSync(path.join(dir, "data", "discord-state.json"), "utf8"));
      assert.equal(state.talking, npc.id);
      assert.ok(state.histories[npc.id].length >= 2);
    });

    await step("killed mid-thought (laptop dies): next start unlocks and says it went away", async () => {
      mock.say("one more question", { as: "bob" });
      await mock.waitFor("locked", () => mock.everyoneSend() === "deny");
      process.kill(-bot.pid, "SIGKILL");
      await bot.exited;
      await sleep(300);
      bot = startBot(dir, mock);
      await mock.waitFor("open again", () => status(mock).includes("Went offline unexpectedly"), 20000);
      await mock.waitFor("model loaded", () => bot.log.includes("is loaded"));
      await mock.waitFor("unlocked", () => mock.everyoneSend() === null);
    });

    await step("stops cleanly again", async () => {
      process.kill(-bot.pid, "SIGINT");
      assert.equal((await bot.exited).code, 0);
    });

    await step("--tunnel: a view-only watch link in the status message, gone again on Ctrl+C", async () => {
      // A stand-in for cloudflared that hands out a link and then just stays up.
      const bin = path.join(dir, "fakebin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(
        path.join(bin, "cloudflared"),
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cloudflared 2026.9.0"; exit 0; fi\necho "INF |  https://quiet-town-test.trycloudflare.com  |" >&2\nexec sleep 100000\n',
        { mode: 0o755 },
      );
      const mirrorPort = GAME_PORT + 7;
      const b = startBot(dir, mock, { PATH: `${bin}:${process.env.PATH}`, MIRROR_PORT: String(mirrorPort) }, ["--tunnel"]);
      const linkFile = path.join(dir, "data", "public-url.json");
      try {
        await mock.waitFor("status with the link", () => status(mock).includes("🌐 **Watch the town:** <https://quiet-town-test.trycloudflare.com>"), 20000);
        assert.match(b.log, /http:\/\/127\.0\.0\.1:\d+\/\s+->\s+https:\/\/quiet-town-test\.trycloudflare\.com\//);
        assert.match(text(await answer(mock, mock.command("status"))), /quiet-town-test.*view only/);

        // The mirror: the town can be looked at, nothing else.
        const at = (p, init) => fetch(`http://127.0.0.1:${mirrorPort}${p}`, init);
        const page = await at("/");
        assert.equal(page.status, 200);
        assert.match(await page.text(), /This link is view only/);
        assert.equal((await at("/js/main.js")).status, 200);
        assert.equal((await at("/api/case")).status, 200);
        const villager = await (await at(`/api/npcs/${npc.id}`)).json();
        assert.ok(villager.raw.includes(npc.name));
        assert.match(villager.systemPrompt, /Hidden on the shared link/);
        assert.doesNotMatch(JSON.stringify(villager), /Your role|You killed/);
        const post = (p, body) => at(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const talk = await post("/api/talk", { model: "fake-model", npc: npc.id, history: [] });
        assert.equal(talk.status, 403);
        assert.match((await talk.json()).error, /view-only link/);
        for (const [p, body] of [["/api/options", {}], ["/api/case", { difficulty: "easy" }], ["/api/case/accuse", { suspect: npc.id }], ["/api/case/end", {}], ["/api/models/unload", {}], ["/v1/chat/completions", {}]]) {
          assert.equal((await post(p, body)).status, 403, `${p} is blocked`);
        }
        assert.equal((await at("/v1/models")).status, 403);
        assert.equal((await post("/api/models/load", { id: "fake-model" })).status, 200, "the model already loaded is fine");
        assert.equal((await post("/api/models/load", { id: "some-other-model" })).status, 403);
      } finally {
        process.kill(-b.pid, "SIGINT");
        assert.equal((await b.exited).code, 0);
      }
      assert.ok(!fs.existsSync(linkFile), "the link is forgotten");
      await assert.rejects(fetch(`http://127.0.0.1:${mirrorPort}/`), "the mirror is closed");
    });

    await step("without the Message Content intent: slash commands only, and it says so", async () => {
      const quiet = await new MockDiscord({ messageContent: false }).start();
      const b = startBot(dir, quiet);
      try {
        await quiet.waitFor("identify", () => quiet.identifies.length);
        assert.ok(!(quiet.identifies[0].intents & MESSAGE_CONTENT_INTENT));
        await quiet.waitFor("status", () => statusMessage(quiet), 20000);
        assert.match(status(quiet), /\/say to talk to them/);
        const help = await answer(quiet, quiet.command("help"));
        assert.match(text(help), /\/say <text>/);
      } finally {
        process.kill(-b.pid, "SIGINT");
        await b.exited;
        await quiet.stop();
      }
    });

    await step("without Manage Roles: never locks, marks messages sent mid-thought as unheard instead", async () => {
      const weak = await new MockDiscord({ botPerms: (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 16n) | (1n << 6n) }).start();
      const b = startBot(dir, weak);
      try {
        await weak.waitFor("commands", () => weak.commands.length === 17, 20000);
        const report = await answer(weak, weak.command("setup", {}, { as: "host" }), "the setup report");
        assert.match(report.content, /⚠️ Won't lock the channel while a villager is thinking: the bot needs the Manage Roles permission/);
        await weak.waitFor("model loaded", () => b.log.includes("is loaded"));
        // Someone nobody has talked to yet, so they really have to think.
        const other = (await game("/api/npcs")).find((n) => n.id !== npc.id && n.id !== caseInfo.victim.id);
        await answer(weak, weak.command("talk", { villager: other.id }));
        await weak.waitFor("red presence", () => weak.presences.at(-1)?.status === "dnd");
        const early = weak.say("wait for me", { as: "bob" });
        await weak.waitFor("⏳", () => weak.reactions.some((r) => r.messageId === early && r.emoji === "⏳"));
        await weak.waitFor("answer", () => npcMessages(weak, other.name).some((m) => buttons(m).length));
        assert.ok(!weak.calls.some((c) => c.method === "PUT" && c.path.includes("/permissions/")), "never touched permissions");
      } finally {
        process.kill(-b.pid, "SIGINT");
        await b.exited;
        await weak.stop();
      }
    });

    await step("started before the network is up: keeps trying, then connects", async () => {
      const port = 31000 + Math.floor(Math.random() * 2000);
      const later = new MockDiscord();
      later.api = `http://127.0.0.1:${port}/api`; // nothing listening there yet
      const b = startBot(dir, later);
      try {
        await later.waitFor("a retry", () => b.log.includes("Can't reach Discord"), 20000);
        await later.start(port);
        await later.waitFor("connected", () => later.identifies.length && b.log.includes("Online as"), 30000);
        await later.waitFor("open", () => status(later).includes("🟢 Bramblewick is open"), 20000);
      } finally {
        process.kill(-b.pid, "SIGINT");
        assert.equal((await b.exited).code, 0);
        await later.stop();
      }
    });

    await step("a bad token stops with a clear message instead of retrying forever", async () => {
      const strict = await new MockDiscord({ rejectToken: true }).start();
      try {
        const b = startBot(dir, strict);
        const { code } = await b.exited;
        assert.equal(code, 1, "exits with an error so discord.bat keeps the window open");
        assert.match(b.log, /Discord didn't accept the bot token/);
        assert.doesNotMatch(b.log, /Trying again/);
      } finally {
        await strict.stop();
      }
    });
  } finally {
    try {
      process.kill(-bot.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await mock.stop();
    if (!failed && !process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} step(s) failed` : "\nAll good.");
  process.exitCode = failed ? 1 : 0;
}

async function serverPid(dir) {
  const { execSync } = await import("node:child_process");
  return Number(execSync(`pgrep -f "${path.join(dir, "server", "index.js")}"`).toString().trim().split("\n")[0]);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
