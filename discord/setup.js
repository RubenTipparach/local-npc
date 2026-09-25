// One-time setup for the Discord bot: walks through making a bot in the Discord Developer Portal,
// checks the token, saves it to data/discord.json and prints the link that invites the bot to
// your server. Runs by itself the first time you start the bot, or any time with
// `npm run discord:setup` (e.g. to paste a new token).

import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { loadConfig, saveConfig, configPath } from "./store.js";

export const API = process.env.DISCORD_API || "https://discord.com/api";

// What the bot needs in your server. Manage Roles is only used to lock the play channel's
// Send Messages while a villager is thinking; the bot never touches anything else.
const PERMISSIONS = {
  "View Channels": 1n << 10n,
  "Send Messages": 1n << 11n,
  "Embed Links": 1n << 14n,
  "Attach Files": 1n << 15n,
  "Read Message History": 1n << 16n,
  "Add Reactions": 1n << 6n,
  "Manage Roles": 1n << 28n,
};
const MESSAGE_CONTENT = (1 << 18) | (1 << 19); // application flags: the Message Content intent is on

export function inviteUrl(appId) {
  const perms = Object.values(PERMISSIONS).reduce((a, b) => a | b, 0n);
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot+applications.commands&permissions=${perms}`;
}

export const needsSetup = () => !loadConfig().token;

// Asks Discord who the token belongs to. Returns the application, or throws with a readable reason.
export async function checkToken(token) {
  const r = await fetch(`${API}/v10/applications/@me`, { headers: { Authorization: `Bot ${token}` } });
  if (r.status === 401) throw new Error("Discord didn't accept that token. Copy it again from the Bot tab (Reset Token gives you a fresh one).");
  if (!r.ok) throw new Error(`Discord answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const app = await r.json();
  return { id: app.id, name: app.bot?.username || app.name, canRead: (app.flags & MESSAGE_CONTENT) !== 0 };
}

export async function runSetup({ starting = false } = {}) {
  if (!process.stdin.isTTY && !process.env.DISCORD_TOKEN) {
    throw new Error("The Discord bot isn't set up. Run `npm run discord:setup` in a terminal, or set DISCORD_TOKEN.");
  }
  console.log(`
== Bramblewick on Discord: one-time setup ==

The bot runs here on this computer and plays the game in one channel of your Discord server.
Everyone in that channel plays the same case together.

1. Open https://discord.com/developers/applications and click "New Application".
   Name it what the bot should be called (for example "Bramblewick").
2. Open the "Bot" tab:
   - Click "Reset Token" and copy the token.
   - Under "Privileged Gateway Intents", turn on "Message Content Intent" and save. That lets
     players just type to talk to a villager. (Without it they use /say instead.)
`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let app = null;
  let token = "";
  try {
    for (let tries = 0; !app && tries < 3; tries++) {
      token = (await rl.question("3. Paste the bot token here: ")).trim().replace(/^Bot\s+/i, "");
      if (!token) break;
      try {
        app = await checkToken(token);
      } catch (e) {
        console.log(`   ${e.message}`);
      }
    }
  } finally {
    rl.close();
  }
  if (!app) throw new Error("Setup cancelled. Run `npm run discord:setup` to try again.");

  saveConfig({ token });
  console.log(`
   That's ${app.name}. Token saved to ${configPath} (git-ignored; keep it private).
${app.canRead ? "" : `
   Note: the Message Content intent is still off, so players will need /say to talk. Turn it on
   in the Bot tab whenever you like; the bot picks it up the next time it starts.
`}
4. Invite the bot to your server with this link (pick the server, then Authorize):

   ${inviteUrl(app.id)}

   "Manage Roles" is only used to lock the play channel while a villager is thinking, so nobody
   types over them. The bot only ever changes that channel's Send Messages setting.

${
    starting
      ? "5. The bot starts now. Once it shows as online, type /setup in the channel you want to play in."
      : "5. Start the bot (discord.bat, play.bat --discord or npm run discord), then type /setup in the\n   channel you want to play in."
  }
`);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSetup().catch((e) => {
    console.error(`\n${e.message}`);
    process.exitCode = 1;
  });
}
