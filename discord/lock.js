// Locks the play channel while a villager is thinking (and while the town is closed), so nobody
// types into a reply that's still being written. Locking means denying Send Messages on the
// channel for @everyone and for any role or member the channel explicitly lets send; unlocking
// puts each of those back exactly as it was. Nothing else about the channel is ever touched.
//
// The bot first gives itself a "can send" overwrite on the channel so the lock never silences it.
// Needs the Manage Roles permission (shown as Manage Permissions on a channel). Without it the
// lock is skipped and messages sent while a villager is thinking are marked unheard instead.
//
// What to restore is saved before anything is changed, so if the bot dies mid-thought the next
// start unlocks the channel.

import { PermissionFlagsBits as P, OverwriteType, Routes } from "discord.js";

const SEND = P.SendMessages;
const SELF = P.ViewChannel | P.SendMessages | P.EmbedLinks | P.AttachFiles | P.ReadMessageHistory | P.AddReactions;
const REASON = "Bramblewick: lock the table while a villager is thinking";

export class ChannelLock {
  constructor(bot) {
    this.bot = bot;
    this.reasons = new Set(); // why the channel should be locked right now: busy, closed, down, offline
    this.queue = Promise.resolve();
    this.available = false;
    this.problem = "no play channel yet";
    this.baseline = null; // {channelId, targets}: the channel's send overwrites as of the last unlock
    this.lastWrite = 0;
  }

  get locked() {
    return !!this.bot.state.lock?.locked;
  }

  // Checks the bot can lock this channel and gives itself its "can send" overwrite. Returns a
  // sentence describing any problem, or null when locking works.
  async prepare(channel) {
    if (this.baseline?.channelId !== channel.id) this.baseline = null;
    if (!this.bot.config.lockChannel) return this.#off("turned off in data/discord.json (lockChannel)");
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(P.ManageRoles)) return this.#off("the bot needs the Manage Roles permission (Manage Permissions on this channel)");
    if (!perms.has(P.Administrator)) {
      const want = me.permissions.bitfield & SELF;
      const mine = channel.permissionOverwrites.cache.get(me.id);
      const allow = (mine?.allow.bitfield ?? 0n) | want;
      const deny = (mine?.deny.bitfield ?? 0n) & ~want;
      if (!mine || mine.allow.bitfield !== allow || mine.deny.bitfield !== deny) {
        try {
          await this.#put(channel.id, me.id, OverwriteType.Member, allow, deny, "Bramblewick: let the bot speak while the table is locked");
        } catch (e) {
          return this.#off(`couldn't give the bot its own send permission on the channel (${e.message})`);
        }
      }
    }
    this.available = true;
    this.problem = null;
    return null;
  }

  #off(problem) {
    this.available = false;
    this.problem = problem;
    return problem;
  }

  hold(reason) {
    return this.#run(() => {
      this.reasons.add(reason);
      return this.#apply();
    });
  }

  release(reason) {
    return this.#run(() => {
      this.reasons.delete(reason);
      return this.#apply();
    });
  }

  // Undo a lock left behind by a previous run (a crash, the laptop sleeping, or closing for the
  // night), whatever channel it was on.
  restore() {
    return this.#run(async () => {
      const saved = this.bot.state.lock;
      if (!saved?.locked) return;
      const targets = parse(saved.targets);
      try {
        await this.#write(saved.channelId, targets, false);
      } catch (e) {
        // The channel was deleted while the bot was away: nothing left to unlock.
        if (e.code !== 10003) throw e;
      }
      this.bot.state.lock = null;
      this.bot.save.now();
      // Discord takes a moment to tell the bot the channel changed; until it does, trust what
      // was just restored over the bot's copy of the channel.
      this.baseline = { channelId: saved.channelId, targets };
    });
  }

  // The channel's permissions were changed by someone other than the bot: forget the baseline so
  // the next lock starts from what the channel looks like now.
  channelChanged() {
    if (!this.locked && Date.now() - this.lastWrite > 5000) this.baseline = null;
  }

  #run(fn) {
    const p = this.queue.then(fn).catch((e) =>
      this.bot.log(
        this.reasons.size
          ? `Couldn't lock the channel: ${e.message}`
          : `Couldn't unlock the channel: ${e.message}. Give the bot Manage Roles, or remove the Send Messages block from the channel yourself.`,
      ),
    );
    this.queue = p;
    return p;
  }

  async #apply() {
    const want = this.reasons.size > 0;
    if (want === this.locked) return;
    const channel = this.bot.channel;
    if (want) {
      if (!channel || !this.available) return;
      const targets = this.baseline?.channelId === channel.id ? this.baseline.targets : capture(channel);
      // Saved before touching anything, so a crash halfway through still gets undone next start.
      this.bot.state.lock = { locked: true, channelId: channel.id, targets: serialize(targets) };
      this.bot.save.now();
      await this.#write(channel.id, targets, true);
    } else {
      const saved = this.bot.state.lock;
      const targets = parse(saved.targets);
      await this.#write(saved.channelId, targets, false);
      this.bot.state.lock = null;
      this.bot.save.now();
      this.baseline = { channelId: saved.channelId, targets };
    }
  }

  async #write(channelId, targets, lock) {
    for (const t of targets) {
      if (lock) await this.#put(channelId, t.id, t.type, t.allow & ~SEND, t.deny | SEND);
      else if (t.existed) await this.#put(channelId, t.id, t.type, t.allow, t.deny);
      else await this.bot.client.rest.delete(Routes.channelPermission(channelId, t.id), { reason: REASON });
      this.lastWrite = Date.now();
    }
  }

  #put(channelId, id, type, allow, deny, reason = REASON) {
    this.lastWrite = Date.now();
    return this.bot.client.rest.put(Routes.channelPermission(channelId, id), {
      body: { type, allow: allow.toString(), deny: deny.toString() },
      reason,
    });
  }
}

// @everyone, plus every role or member (other than the bot) the channel explicitly lets send,
// since an explicit allow would get round a lock on @everyone alone.
function capture(channel) {
  const everyone = channel.guild.roles.everyone.id;
  const me = channel.guild.members.me.id;
  const cache = channel.permissionOverwrites.cache;
  const row = (id, o, type) => ({ id, type, allow: o?.allow.bitfield ?? 0n, deny: o?.deny.bitfield ?? 0n, existed: !!o });
  const targets = [row(everyone, cache.get(everyone), OverwriteType.Role)];
  for (const o of cache.values()) {
    if (o.id !== everyone && o.id !== me && o.allow.bitfield & SEND) targets.push(row(o.id, o, o.type));
  }
  return targets;
}

const serialize = (targets) => targets.map((t) => ({ ...t, allow: t.allow.toString(), deny: t.deny.toString() }));
const parse = (targets) => (targets || []).map((t) => ({ ...t, allow: BigInt(t.allow), deny: BigInt(t.deny) }));
