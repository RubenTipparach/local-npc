// A tiny stand-in for Discord (the gateway WebSocket plus the REST routes the bot uses), so the
// bot can be driven end to end without a real bot token. One server ("guild") with a play channel
// and a general channel, a host (the application owner) and two players.
//
// Tests inject slash commands, button clicks and typed messages, then read back what the channel
// shows: messages (with edits), replies only one person sees, reactions, permission overwrites and
// the bot's presence.

import http from "node:http";
import { WebSocketServer } from "ws";
import { SnowflakeUtil } from "discord.js";

const P = {
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  UseApplicationCommands: 1n << 31n,
  ManageGuild: 1n << 5n,
  ManageRoles: 1n << 28n,
  Administrator: 1n << 3n,
};
const EVERYONE_PERMS = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.AddReactions | P.UseApplicationCommands | P.EmbedLinks | P.AttachFiles;

export const IDS = {
  guild: "900000000000000001",
  channel: "900000000000000002",
  general: "900000000000000003",
  app: "900000000000000010",
  bot: "900000000000000010",
  botRole: "900000000000000011",
  host: "900000000000000020",
  alice: "900000000000000021",
  bob: "900000000000000022",
};

const user = (id, username, extra = {}) => ({ id, username, global_name: username, discriminator: "0", avatar: null, ...extra });
export const USERS = {
  host: user(IDS.host, "Ruben"),
  alice: user(IDS.alice, "Alice"),
  bob: user(IDS.bob, "Bob"),
};
const BOT_USER = user(IDS.bot, "Bramblewick", { bot: true });

export class MockDiscord {
  constructor({ messageContent = true, botPerms = EVERYONE_PERMS | P.ManageRoles, rejectToken = false } = {}) {
    this.messageContent = messageContent;
    this.rejectToken = rejectToken;
    this.botPerms = botPerms;
    this.calls = []; // every REST call: {method, path, body}
    this.messages = new Map(); // id -> message (channel messages and interaction responses)
    this.order = []; // message ids in the order they were created
    this.deleted = new Set();
    this.reactions = []; // {messageId, emoji}
    this.presences = [];
    this.responses = new Map(); // interaction token -> {id, callbacks: [], original, followups: []}
    this.commands = [];
    this.identifies = [];
    this.overwrites = new Map([
      [IDS.channel, []],
      [IDS.general, []],
    ]);
    this.sockets = new Set();
    this.seq = 0;
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  async start(port = 0) {
    this.http = http.createServer((req, res) => this.#rest(req, res).catch((e) => this.#send(res, 500, { message: e.message })));
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => this.#gateway(ws));
    await new Promise((r) => this.http.listen(port, "127.0.0.1", r));
    this.port = this.http.address().port;
    this.api = `http://127.0.0.1:${this.port}/api`;
    return this;
  }

  async stop() {
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    await new Promise((r) => this.http.close(r));
  }

  // Drops every gateway connection, like a network blip or the laptop sleeping.
  dropConnections(code = 4000) {
    for (const ws of this.sockets) ws.close(code);
  }

  // ---- what the tests do ----------------------------------------------------------------------

  // A slash command. options: {name: value}. Returns the interaction token.
  command(name, options = {}, { as = "alice", channel = IDS.channel } = {}) {
    const opts = Object.entries(options).map(([k, v]) => ({ name: k, type: 3, value: v }));
    return this.#interaction(2, { id: this.#id(), name, type: 1, options: opts, guild_id: IDS.guild }, { as, channel });
  }

  autocomplete(name, option, value, { as = "alice" } = {}) {
    return this.#interaction(4, { id: this.#id(), name, type: 1, options: [{ name: option, type: 3, value, focused: true }], guild_id: IDS.guild }, { as });
  }

  click(messageId, customId, { as = "alice" } = {}) {
    const message = this.messages.get(messageId);
    if (!message) throw new Error(`no message ${messageId}`);
    return this.#interaction(3, { custom_id: customId, component_type: 2 }, { as, message, channel: message.channel_id });
  }

  // A player types in the channel.
  say(text, { as = "alice", channel = IDS.channel } = {}) {
    const msg = this.#message({ channel_id: channel, author: USERS[as], content: this.messageContent ? text : "" });
    this.#dispatch("MESSAGE_CREATE", { ...msg, guild_id: IDS.guild, member: this.#member(as) });
    return msg.id;
  }

  // What the channel shows now, oldest first (deleted messages left out).
  channelMessages(channel = IDS.channel) {
    return this.order.map((id) => this.messages.get(id)).filter((m) => m && m.channel_id === channel && !this.deleted.has(m.id) && !m.ephemeral);
  }

  lastBotMessage(match) {
    return [...this.channelMessages()].reverse().find((m) => m.author.id === IDS.bot && (!match || match(m)));
  }

  response(token) {
    return this.responses.get(token);
  }

  // The @everyone overwrite's Send Messages state in the play channel: "deny", "allow" or null.
  everyoneSend(channel = IDS.channel) {
    const o = this.overwrites.get(channel).find((x) => x.id === IDS.guild);
    if (!o) return null;
    if (BigInt(o.deny) & P.SendMessages) return "deny";
    if (BigInt(o.allow) & P.SendMessages) return "allow";
    return null;
  }

  async waitFor(what, fn, timeout = 15000) {
    const until = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ---- gateway --------------------------------------------------------------------------------

  #gateway(ws) {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null }));
    ws.on("message", (raw) => {
      const p = JSON.parse(raw);
      if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
      if (p.op === 3) this.presences.push(p.d);
      if (p.op === 2) {
        this.identifies.push(p.d);
        this.#sendTo(ws, "READY", {
          v: 10,
          user: BOT_USER,
          guilds: [{ id: IDS.guild, unavailable: true }],
          session_id: `session-${this.identifies.length}`,
          resume_gateway_url: `ws://127.0.0.1:${this.port}`,
          shard: [0, 1],
          application: { id: IDS.app, flags: 0 },
          private_channels: [],
        });
        this.#sendTo(ws, "GUILD_CREATE", this.#guild());
      }
      if (p.op === 6) this.#sendTo(ws, "RESUMED", {});
    });
  }

  #sendTo(ws, t, d) {
    ws.send(JSON.stringify({ op: 0, t, s: ++this.seq, d }));
  }

  #dispatch(t, d) {
    for (const ws of this.sockets) this.#sendTo(ws, t, d);
  }

  #channel(id) {
    const name = id === IDS.channel ? "bramblewick" : "general";
    return { id, type: 0, guild_id: IDS.guild, name, position: 0, permission_overwrites: this.overwrites.get(id), parent_id: null, topic: null, nsfw: false, rate_limit_per_user: 0, last_message_id: null, flags: 0 };
  }

  #member(as) {
    return { user: USERS[as] || BOT_USER, roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0, nick: null, avatar: null };
  }

  #guild() {
    const role = (id, name, permissions, position, extra = {}) => ({ id, name, permissions: String(permissions), position, color: 0, hoist: false, managed: false, mentionable: false, flags: 0, icon: null, unicode_emoji: null, ...extra });
    return {
      id: IDS.guild,
      name: "Test Town",
      icon: null,
      owner_id: IDS.host,
      afk_timeout: 300,
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      features: [],
      mfa_level: 0,
      system_channel_flags: 0,
      premium_tier: 0,
      preferred_locale: "en-US",
      nsfw_level: 0,
      premium_progress_bar_enabled: false,
      roles: [role(IDS.guild, "@everyone", EVERYONE_PERMS, 0), role(IDS.botRole, "Bramblewick", this.botPerms, 1, { managed: true, tags: { bot_id: IDS.bot } })],
      emojis: [],
      stickers: [],
      channels: [this.#channel(IDS.channel), this.#channel(IDS.general)],
      threads: [],
      members: [{ ...this.#member("bot"), roles: [IDS.botRole] }],
      voice_states: [],
      presences: [],
      member_count: 4,
      large: false,
      unavailable: false,
      joined_at: new Date().toISOString(),
      stage_instances: [],
      guild_scheduled_events: [],
      soundboard_sounds: [],
    };
  }

  #interaction(type, data, { as = "alice", channel = IDS.channel, message } = {}) {
    const id = this.#id();
    const token = `token-${id}`;
    const perms = as === "host" ? EVERYONE_PERMS | P.ManageGuild | P.Administrator : EVERYONE_PERMS;
    this.responses.set(token, { id, type, as, command: data.name, channel, message: message?.id, callbacks: [], original: null, followups: [] });
    this.#dispatch("INTERACTION_CREATE", {
      id,
      application_id: IDS.app,
      type,
      token,
      version: 1,
      guild_id: IDS.guild,
      channel_id: channel,
      channel: { ...this.#channel(channel), permissions: String(perms) },
      member: { ...this.#member(as), permissions: String(perms) },
      data,
      ...(message ? { message } : {}),
      locale: "en-US",
      guild_locale: "en-US",
      app_permissions: String(this.botPerms),
      entitlements: [],
      authorizing_integration_owners: { 0: IDS.guild },
      context: 0,
      attachment_size_limit: 8388608,
    });
    return token;
  }

  // ---- REST -----------------------------------------------------------------------------------

  #id() {
    return SnowflakeUtil.generate().toString();
  }

  #message(fields) {
    const msg = {
      id: this.#id(),
      type: 0,
      author: BOT_USER,
      content: "",
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      flags: 0,
      components: [],
      edits: 0,
      ...fields,
    };
    this.messages.set(msg.id, msg);
    this.order.push(msg.id);
    return msg;
  }

  #edit(msg, body) {
    for (const k of ["content", "embeds", "components", "attachments"]) if (k in body) msg[k] = body[k] ?? (k === "content" ? "" : []);
    msg.edited_timestamp = new Date().toISOString();
    msg.edits++;
    return msg;
  }

  #fromBody(body, files) {
    const out = { content: body.content || "", embeds: body.embeds || [], components: body.components || [], flags: body.flags || 0 };
    if (files?.length) out.attachments = files.map((f, n) => ({ id: String(n), filename: f.name, size: f.data.length, url: `http://files/${f.name}`, proxy_url: "", text: f.data }));
    if (body.message_reference) out.message_reference = body.message_reference;
    return out;
  }

  async #rest(req, res) {
    const url = new URL(req.url, "http://x");
    const path = decodeURIComponent(url.pathname).replace(/^\/api\/v\d+/, "");
    const { body, files } = await readBody(req);
    this.calls.push({ method: req.method, path, body, query: Object.fromEntries(url.searchParams) });
    const m = (method, re) => req.method === method && path.match(re);
    let r;
    if (this.rejectToken) return this.#send(res, 401, { message: "401: Unauthorized", code: 0 });

    if ((r = m("GET", /^\/gateway\/bot$/))) {
      return this.#send(res, 200, { url: `ws://127.0.0.1:${this.port}`, shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 } });
    }
    if ((r = m("GET", /^\/applications\/@me$/))) {
      return this.#send(res, 200, { id: IDS.app, name: "Bramblewick", flags: this.messageContent ? 1 << 19 : 0, owner: USERS.host, bot: BOT_USER, team: null });
    }
    if ((r = m("PUT", /^\/applications\/\d+\/guilds\/\d+\/commands$/))) {
      this.commands = body;
      return this.#send(res, 200, body.map((c) => ({ ...c, id: this.#id(), application_id: IDS.app, guild_id: IDS.guild, version: "1", type: 1, default_member_permissions: c.default_member_permissions ?? null, options: c.options || [] })));
    }
    if ((r = m("POST", /^\/channels\/(\d+)\/messages$/))) {
      if (!this.#canSend(r[1])) return this.#send(res, 403, { message: "Missing Permissions", code: 50013 });
      const msg = this.#message({ channel_id: r[1], ...this.#fromBody(body, files) });
      this.#send(res, 200, msg);
      return this.#echo("MESSAGE_CREATE", msg);
    }
    if ((r = m("GET", /^\/channels\/(\d+)\/messages$/))) {
      const after = url.searchParams.get("after");
      const list = this.order
        .map((id) => this.messages.get(id))
        .filter((x) => x.channel_id === r[1] && !this.deleted.has(x.id) && !x.ephemeral && (!after || BigInt(x.id) > BigInt(after)))
        .reverse();
      return this.#send(res, 200, list.slice(0, Number(url.searchParams.get("limit") || 50)));
    }
    if ((r = m("GET", /^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      const msg = this.messages.get(r[2]);
      return msg && !this.deleted.has(msg.id) ? this.#send(res, 200, msg) : this.#send(res, 404, { message: "Unknown Message", code: 10008 });
    }
    if ((r = m("PATCH", /^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      const msg = this.messages.get(r[2]);
      if (!msg || this.deleted.has(msg.id)) return this.#send(res, 404, { message: "Unknown Message", code: 10008 });
      this.#send(res, 200, this.#edit(msg, body));
      return this.#echo("MESSAGE_UPDATE", msg);
    }
    if ((r = m("DELETE", /^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      this.deleted.add(r[2]);
      this.#send(res, 204);
      return this.#dispatch("MESSAGE_DELETE", { id: r[2], channel_id: r[1], guild_id: IDS.guild });
    }
    if ((r = m("PUT", /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/))) {
      this.reactions.push({ messageId: r[2], emoji: decodeURIComponent(r[3]) });
      return this.#send(res, 204);
    }
    if ((r = m("PUT", /^\/channels\/(\d+)\/permissions\/(\d+)$/))) {
      const list = this.overwrites.get(r[1]).filter((o) => o.id !== r[2]);
      list.push({ id: r[2], type: body.type, allow: String(body.allow), deny: String(body.deny) });
      this.overwrites.set(r[1], list);
      this.#dispatch("CHANNEL_UPDATE", this.#channel(r[1]));
      return this.#send(res, 204);
    }
    if ((r = m("DELETE", /^\/channels\/(\d+)\/permissions\/(\d+)$/))) {
      this.overwrites.set(r[1], this.overwrites.get(r[1]).filter((o) => o.id !== r[2]));
      this.#dispatch("CHANNEL_UPDATE", this.#channel(r[1]));
      return this.#send(res, 204);
    }
    if ((r = m("POST", /^\/interactions\/(\d+)\/([^/]+)\/callback$/))) {
      const it = this.responses.get(r[2]);
      it.callbacks.push(body);
      const data = body.data || {};
      if (body.type === 4 || body.type === 5) {
        it.original = this.#message({ channel_id: it.channel, ...this.#fromBody(data, files), ephemeral: !!(data.flags & 64), deferred: body.type === 5, interactionId: it.id, by: it.as, command: it.command });
      }
      if (body.type === 7) {
        const target = this.#componentMessage(it);
        if (target) this.#edit(target, data);
      }
      if (body.type === 8) it.choices = data.choices;
      if (url.searchParams.get("with_response") === "true" && it.original) {
        const { edits, ephemeral, deferred, interactionId, by, command, ...wire } = it.original;
        return this.#send(res, 200, {
          interaction: { id: it.id, type: it.type, response_message_id: wire.id, response_message_loading: body.type === 5, response_message_ephemeral: !!ephemeral },
          resource: { type: body.type, message: wire },
        });
      }
      if (body.type === 4 && !(data.flags & 64)) this.#echo("MESSAGE_CREATE", it.original);
      return this.#send(res, 204);
    }
    if ((r = m("PATCH", /^\/webhooks\/\d+\/([^/]+)\/messages\/(@original|\d+)$/))) {
      const it = this.responses.get(r[1]);
      const msg = r[2] === "@original" ? it.original : this.messages.get(r[2]);
      if (!msg) return this.#send(res, 404, { message: "Unknown Message", code: 10008 });
      msg.deferred = false;
      return this.#send(res, 200, this.#edit(msg, this.#fromBody({ ...msg, ...body }, files)));
    }
    if ((r = m("GET", /^\/webhooks\/\d+\/([^/]+)\/messages\/@original$/))) {
      return this.#send(res, 200, this.responses.get(r[1]).original);
    }
    if ((r = m("POST", /^\/webhooks\/\d+\/([^/]+)$/))) {
      const it = this.responses.get(r[1]);
      const msg = this.#message({ channel_id: it.channel, ...this.#fromBody(body, files), ephemeral: !!(body.flags & 64), interactionId: it.id, by: it.as });
      it.followups.push(msg);
      return this.#send(res, 200, msg);
    }
    return this.#send(res, 404, { message: `mock: no route for ${req.method} ${path}`, code: 0 });
  }

  // The message a clicked button belongs to.
  #componentMessage(it) {
    return it.message ? this.messages.get(it.message) : null;
  }

  // Would Discord let the bot post here? Only the bot's own member overwrite or no lock at all.
  #canSend(channel) {
    const list = this.overwrites.get(channel) || [];
    const me = list.find((o) => o.id === IDS.bot);
    if (me && BigInt(me.allow) & P.SendMessages) return true;
    const everyone = list.find((o) => o.id === IDS.guild);
    return !(everyone && BigInt(everyone.deny) & P.SendMessages);
  }

  // Discord tells every connected bot about messages, its own included, a moment after the REST
  // call returns; so the bot's copy of a message catches up only then.
  #echo(t, msg) {
    const { edits, ephemeral, deferred, interactionId, by, command, ...wire } = msg;
    setTimeout(() => this.#dispatch(t, { ...wire, guild_id: IDS.guild, member: { ...this.#member("bot"), roles: [IDS.botRole] } }), 20);
  }

  #send(res, status, obj) {
    if (status === 204 || obj === undefined) {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }
}

// JSON bodies, or multipart (payload_json plus files) when the bot attaches a file.
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const type = req.headers["content-type"] || "";
  if (!buf.length) return { body: {} };
  if (type.startsWith("application/json")) return { body: JSON.parse(buf.toString()) };
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
  if (!boundary) return { body: {} };
  const parts = buf.toString("latin1").split(`--${boundary[1] || boundary[2]}`);
  let body = {};
  const files = [];
  for (const part of parts) {
    const [head, ...rest] = part.split("\r\n\r\n");
    const data = rest.join("\r\n\r\n").replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]+)"/.exec(head)?.[1];
    if (name === "payload_json") body = JSON.parse(Buffer.from(data, "latin1").toString());
    else if (filename) files.push({ name: filename, data: Buffer.from(data, "latin1").toString() });
  }
  return { body, files };
}
