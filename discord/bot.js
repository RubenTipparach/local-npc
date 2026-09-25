// Bramblewick as a Discord bot. Runs on the same computer as the game server (usually a laptop)
// and plays the game in one channel. Started by `play.bat --discord` / `discord.bat` /
// `npm run discord`, which also start the game server.
//
// Because the laptop comes and goes, the bot keeps the channel honest about whether anyone's home:
//   - Its Discord presence is green when the town is open, red (do not disturb) while a villager
//     is thinking, yellow when the town is closed or the game server is down, and grey when the
//     laptop is off (Discord shows that on its own).
//   - It keeps one status message at the bottom of the channel: open, closed, or asleep.
//   - Closing it cleanly (Ctrl+C, closing the window) posts "closed" and locks the channel.
//   - After a crash or the laptop sleeping it says how long it was gone and how many messages
//     nobody heard.
//   - If the game server stops, it says so, locks the channel and starts it again.

import { ActivityType, Client, Events, GatewayIntentBits, REST, Routes, SnowflakeUtil, Status } from "discord.js";
import { client as gameClient } from "../scripts/game-client.js";
import { loadConfig, saveConfig, loadState, stateSaver, publicLink } from "./store.js";
import { ChannelLock } from "./lock.js";
import { COMMANDS, onInteraction, onMessage } from "./commands.js";
import { refresh, pickModel, thinking, loadModel, modelName, Busy, Closed } from "./table.js";
import { statusText } from "./format.js";
import { API, inviteUrl } from "./setup.js";

const HEARTBEAT_MS = 30_000; // how often the bot notes it's alive (and notices it slept)
const HEALTH_MS = 15_000; // how often it checks the game server
const SLEPT_MS = 90_000; // a heartbeat this late means the laptop was asleep
const BLIP_MS = 60_000; // offline for less than this isn't worth mentioning
const PRESENCE_EVERY_MS = 1_500; // presence changes count against the gateway's rate limit
const MESSAGE_CONTENT = (1 << 18) | (1 << 19);

// base: the game server's URL. server: {start(), running} to (re)start the game server if it stops,
// or null when someone else runs it. Call start() to connect and shutdown() to say goodbye.
export function createBot({ base, server = null }) {
  return new Bot({ base, server });
}

class Bot {
  constructor({ base, server }) {
    this.config = loadConfig();
    this.state = loadState();
    this.save = stateSaver(this.state);
    this.api = gameClient(base);
    this.server = server;
    this.lock = new ChannelLock(this);
    this.models = [];
    this.npcs = [];
    this.mystery = null;
    this.active = null;
    this.busy = null;
    this.channel = null;
    this.serverUp = false;
    this.failures = 0;
    this.hostIds = new Set(this.config.hosts);
    this.hostId = null;
    this.started = false;
    this.stopping = false;
    this.onlineSince = null;
    this.awaySince = null;
    this.lastTick = null;
    this.timers = [];
    this.lastPresence = 0;
  }

  log(message) {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    console.log(`[${time}] ${message}`);
  }

  // ---- connecting -----------------------------------------------------------------------------

  // Connects to Discord, and keeps trying while it can't: the laptop may well start before its
  // Wi-Fi does. Only a token Discord rejects gives up.
  async start() {
    const token = this.config.token;
    if (!token) throw new Error("The Discord bot isn't set up yet. Run `npm run discord:setup`.");
    for (let wait = 5; !this.stopping; wait = Math.min(wait * 2, 60)) {
      try {
        return await this.#connect(token);
      } catch (e) {
        if (e.fatal || this.stopping) throw e;
        await this.client?.destroy();
        this.client = null;
        this.log(`Can't reach Discord (${e.message}). Trying again in ${wait} s…`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
  }

  async #connect(token) {
    const rejected = () => Object.assign(new Error("Discord didn't accept the bot token. Run `npm run discord:setup` to paste a new one."), { fatal: true });
    const rest = new REST({ api: API }).setToken(token);
    let app;
    try {
      app = await rest.get(Routes.currentApplication());
    } catch (e) {
      throw e.status === 401 ? rejected() : e;
    }
    this.appId = app.id;
    this.canRead = (app.flags & MESSAGE_CONTENT) !== 0;
    this.hostId = app.team ? app.team.owner_user_id : app.owner?.id;
    for (const id of app.team ? app.team.members.map((m) => m.user.id) : [app.owner?.id]) if (id) this.hostIds.add(id);
    if (!this.canRead) this.log("The Message Content intent is off, so players talk with /say. Turn it on in the Developer Portal (Bot tab) to let them just type.");

    const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
    if (this.canRead) intents.push(GatewayIntentBits.MessageContent);
    this.client = new Client({ intents, rest: { api: API } });
    this.client.once(Events.ClientReady, () => this.#ready());
    this.client.on(Events.InteractionCreate, (i) => onInteraction(this, i));
    this.client.on(Events.MessageCreate, (m) => onMessage(this, m));
    this.client.on(Events.ChannelUpdate, (_, ch) => ch.id === this.channel?.id && this.lock.channelChanged());
    this.client.on(Events.ChannelDelete, (ch) => ch.id === this.channel?.id && this.#channelGone());
    this.client.on(Events.GuildCreate, (g) => this.#registerCommands(g));
    this.client.on(Events.ShardDisconnect, (e) => this.#away(`disconnected (${e.code})`));
    this.client.on(Events.ShardReconnecting, () => this.#away("reconnecting"));
    this.client.on(Events.ShardResume, () => this.#back());
    this.client.on(Events.ShardReady, () => this.#back());
    this.client.on(Events.Error, (e) => this.log(`Discord error: ${e.message}`));
    try {
      await this.client.login(token);
    } catch (e) {
      throw e.code === "TokenInvalid" ? rejected() : e;
    }
  }

  async #ready() {
    this.log(`Online as ${this.client.user.tag}.`);
    try {
      await Promise.all(this.client.guilds.cache.map((g) => this.#registerCommands(g)));
      await this.lock.restore();
      const ch = this.config.channelId ? await this.client.channels.fetch(this.config.channelId).catch(() => null) : null;
      if (ch) await this.useChannel(ch, { startup: true });
      else {
        await this.#checkServer();
        this.log(
          this.client.guilds.cache.size
            ? "No play channel yet: type /setup in the channel you want to play in."
            : `The bot isn't in any server yet. Invite it with:\n  ${inviteUrl(this.appId)}\nthen type /setup in the channel you want to play in.`,
        );
        this.presence();
      }
    } catch (e) {
      this.log(`Something went wrong starting up: ${e.stack || e.message}`);
    } finally {
      // Whatever happened, keep watching the laptop and the game server.
      this.started = true;
      this.lastTick = Date.now();
      this.timers.push(setInterval(() => this.#heartbeat(), HEARTBEAT_MS));
      this.timers.push(setInterval(() => this.#checkServer(), HEALTH_MS));
    }
  }

  async #registerCommands(guild) {
    try {
      await guild.commands.set(COMMANDS);
    } catch (e) {
      this.log(`Couldn't add the slash commands in ${guild.name} (${e.message}). Re-invite the bot with:\n  ${inviteUrl(this.appId)}`);
    }
  }

  // Plays in this channel from now on (/setup, or the saved channel at startup). Returns a
  // checklist for the host.
  async useChannel(ch, { startup = false } = {}) {
    if (this.channel && this.channel.id !== ch.id) {
      // Moving tables: leave the old channel unlocked and without a stale status message.
      await this.lock.restore();
      await this.channel.messages.delete(this.state.statusMessageId).catch(() => {});
      this.state.statusMessageId = null;
    }
    this.channel = ch;
    if (!startup) saveConfig({ channelId: ch.id });
    const lockProblem = await this.lock.prepare(ch);
    await this.#checkServer();
    const notes = startup ? await this.#comebackNotes() : [];
    this.onlineSince ||= Date.now();
    await this.#holdForTown();
    await this.postStatus(notes);
    this.presence();
    this.state.cleanExit = false;
    this.state.lastSeen = Date.now();
    this.save.now();
    if (this.town === "open") this.#warmUp();
    this.log(`Playing in #${ch.name} (${ch.guild.name}).`);

    const me = ch.permissionsFor(ch.guild.members.me);
    const ok = (yes, good, bad) => `${yes ? "✅" : "⚠️"} ${yes ? good : bad}`;
    return [
      `Bramblewick plays in <#${ch.id}> now.`,
      ok(me.has(["ViewChannel", "SendMessages", "EmbedLinks"]), "Can post in this channel.", "Can't post properly here: give the bot View Channel, Send Messages and Embed Links."),
      ok(!lockProblem, "Locks the channel while a villager is thinking.", `Won't lock the channel while a villager is thinking: ${lockProblem}. Messages sent then get a ⏳ instead.`),
      ok(this.canRead, "Players can just type to talk.", "Players need /say to talk: turn on the Message Content intent in the Developer Portal (Bot tab), then restart the bot."),
      ok(me.has("ReadMessageHistory"), "Can tell who spoke while the town was offline.", "Give the bot Read Message History so it can tell who spoke while the town was offline."),
    ].join("\n");
  }

  #channelGone() {
    this.log("The play channel was deleted. Type /setup in a new one.");
    this.channel = null;
    this.state.statusMessageId = null;
    this.state.lock = null;
    this.save.now();
  }

  // ---- open, closed, asleep -------------------------------------------------------------------

  get town() {
    if (this.state.closedByHost) return "closed";
    if (!this.serverUp) return "down";
    if (!this.state.modelId) return "nomodel";
    return "open";
  }

  townProblem() {
    return {
      closed: "🔴 Bramblewick is closed for now. The host can reopen it with `/town open`.",
      down: "💤 The villagers are asleep: the game server on the host's laptop isn't answering. Try again in a minute.",
      nomodel: "No models are downloaded on the host's laptop yet.",
    }[this.town];
  }

  isHost(i) {
    return this.hostIds.has(i.user.id) || !!i.memberPermissions?.has("ManageGuild");
  }

  // The channel is locked whenever the town can't talk.
  async #holdForTown() {
    const t = this.town;
    await (t === "closed" ? this.lock.hold("closed") : this.lock.release("closed"));
    await (t === "down" || t === "nomodel" ? this.lock.hold("down") : this.lock.release("down"));
  }

  // Replaces the status message, so the latest one is always at the bottom of the channel. One at
  // a time, so two changes close together can't leave two status messages behind.
  postStatus(notes = [], kind = this.town) {
    return this.#statusQueue(async () => {
      if (!this.channel) return;
      this.statusNotes = notes;
      this.lastLink = publicLink();
      const old = this.state.statusMessageId;
      try {
        const msg = await this.channel.send({ content: this.#statusText(kind), allowedMentions: { parse: [] } });
        this.state.statusMessageId = msg.id;
        this.save.now();
      } catch (e) {
        return this.log(`Couldn't post the status message: ${e.message}`);
      }
      if (old) await this.channel.messages.delete(old).catch(() => {});
    });
  }

  // Refreshes the status message where it is (a new case, another model).
  updateStatus() {
    return this.#statusQueue(async () => {
      if (!this.channel || !this.state.statusMessageId) return;
      await this.channel.messages.edit(this.state.statusMessageId, { content: this.#statusText(this.town) }).catch(() => {});
    });
  }

  #statusText(kind) {
    return statusText(kind, {
      hostId: this.hostId,
      since: this.onlineSince || Date.now(),
      mystery: this.mystery,
      model: this.state.modelId && modelName(this),
      canRead: this.canRead,
      link: publicLink(),
      notes: this.statusNotes || [],
    });
  }

  #statusQueue(fn) {
    const p = (this.statusChain || Promise.resolve()).then(fn).catch((e) => this.log(e.message));
    this.statusChain = p;
    return p;
  }

  presence() {
    if (!this.client?.user || this.stopping) return;
    let status = "online";
    let text;
    const t = this.town;
    if (this.busy) [status, text] = ["dnd", `💭 ${this.busy.label}…`];
    else if (t === "closed") [status, text] = ["idle", "🔴 Closed for now"];
    else if (t === "down") [status, text] = ["idle", "💤 The villagers are asleep"];
    else if (t === "nomodel") [status, text] = ["idle", "No models downloaded yet"];
    else if (this.mystery && !this.mystery.accused) text = `🕵️ ${this.mystery.title}`;
    else text = "🏘️ Bramblewick is open";
    // Presence changes count against Discord's rate limit: skip repeats, and send the latest one
    // when allowed.
    this.nextPresence = { status, activities: [{ type: ActivityType.Custom, name: "Custom Status", state: text.slice(0, 128) }] };
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(
      () => {
        this.presenceTimer = null;
        const key = JSON.stringify(this.nextPresence);
        if (this.stopping || key === this.sentPresence) return;
        this.sentPresence = key;
        this.lastPresence = Date.now();
        this.client.user.setPresence(this.nextPresence);
      },
      Math.max(0, this.lastPresence + PRESENCE_EVERY_MS - Date.now()),
    );
  }

  async closeTown() {
    this.state.closedByHost = true;
    this.save.now();
    await this.#holdForTown();
    await this.api.post("/api/models/unload").catch(() => {});
    await this.postStatus();
    this.presence();
    this.log("The host closed the town.");
  }

  async openTown() {
    this.state.closedByHost = false;
    this.save.now();
    await this.#checkServer();
    await this.#holdForTown();
    await this.postStatus();
    this.presence();
    if (this.town === "open") this.#warmUp();
    this.log("The host opened the town.");
  }

  // Load the model now so the first villager answers quickly.
  #warmUp() {
    const id = this.state.modelId;
    if (this.active?.status === "ready" && this.active.model?.id === id) return;
    thinking(this, "The villagers are waking up", () => loadModel(this, id)).then(
      (active) => this.log(`${modelName(this, id)} is loaded${active.device ? ` on the ${active.device.mode.toUpperCase()}` : ""}.`),
      (e) => e instanceof Closed || e instanceof Busy || this.log(`Couldn't load ${modelName(this, id)}: ${e.message}`),
    );
  }

  // ---- the game server ------------------------------------------------------------------------

  async #checkServer() {
    const before = caseKey(this.mystery);
    try {
      await refresh(this, AbortSignal.timeout(4000));
      const id = pickModel(this);
      if (id !== this.state.modelId) {
        this.state.modelId = id;
        this.save.soon();
      }
    } catch (e) {
      return this.apiFailed(e);
    }
    // A case started or solved from the browser or text mode, or a watch link opened or closed.
    const link = publicLink();
    const linkChanged = link !== this.lastLink;
    this.lastLink = link;
    if (this.started && (caseKey(this.mystery) !== before || linkChanged)) {
      this.presence();
      await this.updateStatus();
    }
  }

  // Called whenever the game server answers.
  gameServerSeen() {
    this.failures = 0;
    if (this.serverUp) return;
    this.serverUp = true;
    if (!this.started || this.stopping) return;
    this.log("The game server is back.");
    (async () => {
      await this.#checkServer();
      await this.#holdForTown();
      await this.postStatus(["The game server is back."]);
      this.presence();
    })().catch((e) => this.log(e.message));
  }

  // Called when a request to the game server fails. Two failures in a row mean it's down.
  apiFailed(e) {
    // A refused or dropped connection means the server is gone. A slow answer doesn't: on a busy
    // laptop the server can take a while and still be fine.
    const unreachable = e?.message === "fetch failed" || ["ECONNREFUSED", "ECONNRESET"].includes(e?.cause?.code);
    if (!unreachable) return;
    if (!this.serverUp && this.started) return;
    if (++this.failures < 2 && this.serverUp) return;
    this.serverUp = false;
    if (this.stopping) return;
    this.log("The game server isn't answering.");
    if (this.server && !this.server.running) this.server.start();
    if (!this.started) return;
    (async () => {
      await this.#holdForTown();
      await this.postStatus();
      this.presence();
    })().catch((err) => this.log(err.message));
  }

  // ---- being away -----------------------------------------------------------------------------

  #heartbeat() {
    const now = Date.now();
    if (this.lastTick && now - this.lastTick > SLEPT_MS) {
      // The timer fired late: the laptop was asleep. If Discord kept the connection (or has already
      // reconnected), there'll be no reconnect event to tell the channel, so check shortly.
      this.#away("the computer slept", this.lastTick);
      setTimeout(() => this.client.ws.status === Status.Ready && this.#back(), 20_000);
    }
    this.lastTick = now;
    this.state.lastSeen = now;
    this.save.soon();
  }

  #away(why, since = this.lastTick || Date.now()) {
    if (this.stopping || !this.started) return;
    if (!this.awaySince) this.log(`Lost Discord (${why}).`);
    this.awaySince ??= since;
  }

  async #back() {
    if (!this.started || !this.awaySince || this.stopping) return;
    const since = this.awaySince;
    this.awaySince = null;
    this.log("Back on Discord.");
    this.sentPresence = null; // a fresh connection starts without the custom status
    this.presence();
    if (Date.now() - since < BLIP_MS) return;
    await this.#checkServer();
    const notes = [`Back after being offline since ${`<t:${Math.floor(since / 1000)}:t>`} (<t:${Math.floor(since / 1000)}:R>).`];
    const missed = await this.#missed(SnowflakeUtil.generate({ timestamp: since }).toString());
    if (missed) notes.push(missedNote(missed));
    await this.#holdForTown();
    await this.postStatus(notes);
    this.presence();
  }

  // What to tell the channel when the bot starts: did it go away without saying goodbye, and did
  // anyone talk to an empty town?
  async #comebackNotes() {
    const notes = [];
    if (this.state.lastSeen && !this.state.cleanExit) {
      notes.push(`Went offline unexpectedly <t:${Math.floor(this.state.lastSeen / 1000)}:R> (the laptop slept or the bot stopped).`);
    }
    const missed = this.state.lastSeen ? await this.#missed(SnowflakeUtil.generate({ timestamp: this.state.lastSeen }).toString()) : 0;
    if (missed) notes.push(missedNote(missed));
    return notes;
  }

  async #missed(after) {
    try {
      const msgs = await this.channel.messages.fetch({ after, limit: 50 });
      return msgs.filter((m) => !m.author.bot && !m.system).size;
    } catch {
      return 0;
    }
  }

  // ---- closing --------------------------------------------------------------------------------

  // Say goodbye: post "closed", lock the channel, go offline. Quick, because Windows gives a
  // closing console window only a few seconds.
  async shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.presenceTimer);
    const goodbye = async () => {
      if (!this.started || !this.channel) return;
      if (this.config.closeWhenOffline) await this.lock.hold("offline");
      await this.postStatus([], this.state.closedByHost ? "closed" : "offline");
    };
    await Promise.race([goodbye().catch((e) => this.log(`Couldn't say goodbye: ${e.message}`)), new Promise((r) => setTimeout(r, 6000))]);
    this.state.cleanExit = true;
    this.state.lastSeen = Date.now();
    this.save.now();
    await this.client?.destroy();
  }
}

const caseKey = (c) => (c ? `${c.id}:${c.accused || ""}` : "");

const missedNote = (n) => `${n} message${n === 1 ? "" : "s"} came in while the town was away. The villagers didn't hear ${n === 1 ? "it" : "them"}, so say ${n === 1 ? "it" : "them"} again.`;
