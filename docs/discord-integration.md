# Discord integration guide

How to run Bramblewick as a Discord bot from your own laptop: what runs where, the local URLs involved, setting up the bot, day-to-day running, sharing a view-only link to the town, and fixing what goes wrong.

Everything here assumes the game server and the models run on your laptop at `http://127.0.0.1:3000`. Nothing is hosted anywhere else.

## How it fits together

```
 your laptop                                                      the internet
 ─────────────────────────────────────────────────────────────    ──────────────────────────
 llama-server  127.0.0.1:8081+    one model at a time
      ▲
 game server   127.0.0.1:3000     browser game, game API, /v1
      ▲
 Discord bot   (no port)          ──── outbound only ─────────►   Discord (gateway + REST)
      │
      └ optional: mirror 127.0.0.1:3001 ── cloudflared / ngrok ──►  https://….trycloudflare.com
                  (view only)                                       (a link to watch the town)
```

- **The bot needs no public URL.** It opens an outbound connection to Discord and receives slash commands, button clicks and messages over it. No port forwarding and no firewall rules, and it works behind any home router or hotel Wi-Fi.
- **The game server stays on `127.0.0.1`**, so nothing on your network, let alone the internet, can reach it.
- **The watch link is optional.** It mirrors a view-only copy of the browser game so people can see the town. See [Sharing a view-only link](#sharing-a-view-only-link).

## Local URLs

| URL | What it is | Who uses it |
| --- | --- | --- |
| `http://127.0.0.1:3000/` | The browser game | You, in a browser on the laptop |
| `http://127.0.0.1:3000/api/…` | Game API: models, villagers, talk, the case | The browser game, text mode and the bot |
| `http://127.0.0.1:3000/v1` | OpenAI-compatible API over your local models | Any tool you point at it |
| `http://127.0.0.1:8081` to `:8100` | llama-server, one port per model launch | Only the game server |
| `http://127.0.0.1:3001/` | The view-only mirror, while a watch link is open | Only the tunnel program |

The game API calls the bot makes, all to `http://127.0.0.1:3000`:

| Call | For |
| --- | --- |
| `GET /api/models` | Which models are downloaded and which is loaded. Also the bot's health check, every 15 seconds. |
| `POST /api/models/load` · `POST /api/models/unload` | Warming up a model, `/model <name>`, `/town close` |
| `GET /api/npcs` · `GET /api/npcs/:id` | The villager list and `/agent` |
| `POST /api/talk` | A villager's reply, streamed |
| `POST /api/options` | The three suggested replies |
| `GET /api/case` · `POST /api/case` · `POST /api/case/accuse` | The case, `/mystery` and `/accuse` |

Ports, if 3000 is taken on your laptop:

| Setting | Default | Changes |
| --- | --- | --- |
| `PORT` | `3000` | The game server (the bot and the mirror follow it) |
| `HOST` | `127.0.0.1` | What the game server listens on. Leave it: `0.0.0.0` would open it to your whole network. |
| `LLAMA_PORT` | `8081` | The first of the 20 ports llama-server rotates through |
| `MIRROR_PORT` | `PORT + 1` | The view-only mirror |

The bot only connects out, to two Discord addresses: `https://discord.com/api/v10` and the gateway, `wss://gateway.discord.gg`.

## Set up the bot (once)

### 1. Create the application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. The name is what players see (for example "Bramblewick").
2. **Bot** tab:
   - **Reset Token**, then copy it. It's a password for the bot: never commit or share it.
   - Under **Privileged Gateway Intents**, turn on **Message Content Intent** and save. It lets players type to talk to a villager; without it they use `/say`. Presence and Server Members stay off.
3. **General Information** tab: leave **Interactions Endpoint URL** empty. If it's set, Discord sends slash commands to that URL instead of to the bot, and every command fails with "The application did not respond".

There's nothing to set under OAuth2 redirects, Linked Roles or Activities: the bot uses none of them.

### 2. Give the token to the bot

Double-click **`discord.bat`** (or `npm run discord`). The first run installs the Discord library, asks for the token, checks it with Discord and saves it in `data/discord.json` (git-ignored). `npm run discord:setup` pastes a new one later.

It then prints the invite link. You can also build the link by hand:

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION ID>&scope=bot+applications.commands&permissions=268553280
```

`268553280` is these permissions:

| Permission | Why |
| --- | --- |
| View Channels, Read Message History | See the play channel, and count messages nobody heard while the town was offline |
| Send Messages, Embed Links, Attach Files | Villager lines, the case briefing, `/log` files |
| Add Reactions | ⏳ on a message sent while a villager is thinking |
| Manage Roles | Lock the play channel while a villager is thinking. It only changes that channel's Send Messages setting. |

Both scopes matter: `bot` adds the bot, and `applications.commands` lets it add its slash commands.

### 3. Pick the play channel

In the channel you want to play in, type `/setup`. It replies, privately, with a checklist:

- ✅ **Can post in this channel**
- ✅ **Locks the channel while a villager is thinking**: this needs Manage Roles. Without it the lock is skipped and messages sent mid-thought get a ⏳ instead.
- ✅ **Players can just type to talk**: this needs the Message Content intent (then restart the bot).
- ✅ **Can tell who spoke while the town was offline**: this needs Read Message History.

A dedicated channel works best: while a villager is thinking, and while the town is closed, the bot turns off Send Messages there for everyone. It puts each setting back exactly as it was afterwards, and gives itself its own "can send" permission on that channel so the lock never silences it. Server admins can type through the lock; the bot marks their messages with a ⏳ and the villager doesn't hear them.

## Running it day to day

- **Start:** `discord.bat`. It starts the game server and the bot together. The game server's own log goes to `logs/server.log`; the window shows the bot's log.
- **Stop:** Ctrl+C or close the window. The bot posts 🔴 **closed**, locks the channel and goes offline. The case and every conversation are kept.
- **Laptop sleeps or crashes:** Discord shows the bot offline. When it's back, its status message says how long it was gone and how many messages nobody heard, and a channel left locked mid-thought is unlocked.
- **Wi-Fi not up yet:** the bot keeps retrying until Discord is reachable.
- **Game server stops:** the channel gets 🟡 **the villagers are asleep** and locks, and the server is restarted.
- **Closing for the night without stopping the bot:** `/town close` unloads the model to free up the laptop; `/town open` reopens.
- **`/status`** (private) shows it all: open or closed, the model, the case, who's thinking, whether locking and typing work, and the watch link.

To keep the town open while the laptop is plugged in, set it to never sleep when plugged in (Windows 11: Settings, System, Power & battery, Screen and sleep). To start it when you log in, make a Task Scheduler task with the action `discord.bat`, the trigger "At log on", and "Start in" set to this folder.

## Sharing a view-only link

People in Discord can't open `http://127.0.0.1:3000`: it only exists on your laptop. To let them watch the town (villagers walking around, the crime scene, the case briefing), mirror it to a public HTTPS link:

```
npm run tunnel                    # Cloudflare Tunnel or ngrok, whichever is installed
npm run tunnel -- --with ngrok    # pick one
discord.bat --tunnel              # open the link together with the bot
play.bat --tunnel                 # or together with the browser game
```

It prints the mapping and the bot adds the link to its status message (🌐 **Watch the town**) and to `/status`:

```
Mirroring Bramblewick through Cloudflare Tunnel (view only):
  http://127.0.0.1:3000/  ->  https://quiet-town-maple.trycloudflare.com/
  Talking, cases, accusations, model switching and /v1 stay on this laptop.
```

Install one tunnel program first (both are free):

| Program | Install on Windows | Notes |
| --- | --- | --- |
| Cloudflare Tunnel | `winget install --id Cloudflare.cloudflared` | No account needed. A new random `trycloudflare.com` link every time. |
| ngrok | `winget install --id Ngrok.Ngrok`, then `ngrok config add-authtoken <token>` | Needs a free ngrok account (the token is on its dashboard). |

Open a new terminal after installing so it's on your PATH.

### What the link can and can't do

The tunnel never points at the game server. It points at a small mirror on `127.0.0.1:3001` that lets through only what the town needs to be looked at:

| Request | On the link |
| --- | --- |
| The page, scripts, styles, sprites | ✅ Served, with a note that the link is view only |
| `GET /api/models`, `/api/npcs`, `/api/case` | ✅ Served |
| `GET /api/npcs/:id` | ✅ Served without the system prompt, which would give the killer away |
| `POST /api/models/load` | ✅ Only for the model that's already loaded (the page asks for one when it opens); any other model is refused |
| `POST /api/talk`, `/api/options` | ❌ "This is a view-only link. Talk to the villagers in the Discord channel." |
| `POST /api/case`, `/api/case/accuse`, `/api/case/end`, `/api/models/unload` | ❌ Refused |
| `/v1/…` | ❌ Refused, so nobody else can use your models |

Anyone with the link can watch; nobody can talk, change the case or use the laptop's models through it. Ctrl+C closes the link and the bot drops it from the status message within 15 seconds.

Don't point a tunnel at port 3000 directly (for example `cloudflared tunnel --url http://127.0.0.1:3000`): that publishes the whole game API, including `/v1`, model loading and every villager's instructions.

## Files and settings

| File | What's in it |
| --- | --- |
| `data/discord.json` | Your settings: `token`, `channelId`, and optionally `hosts` (user ids who can use host commands), `lockChannel: false` (never lock the channel) and `closeWhenOffline: false` (leave it open while the bot is offline) |
| `data/discord-state.json` | The running game: who the table is talking to, each villager's memory of the conversation, the status message, what the channel lock changed |
| `data/public-url.json` | The watch link, while one is open |
| `logs/discord/<case id>.jsonl` | Everything said in each case. `/log` turns the current one into a transcript. |
| `logs/server.log` | The game server's log |

`data/` and `logs/` are git-ignored. Environment variables win over `data/discord.json`: `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID` and `DISCORD_HOSTS` (comma-separated user ids).

The host is whoever owns the application in the Developer Portal, plus anyone with Manage Server in your Discord server, plus the ids in `hosts`.

## Daily mode (planned)

A daily game is designed but not built yet. Each day the bot would post a case in the play channel, open a thread for questioning and use the post as the ballot, then reveal the table's pick at midnight Central. See the clickable mockup in [`docs/discord-daily-mockup.html`](discord-daily-mockup.html) and its open questions. Midnight reveals need the laptop on (or the bot catches up when it's back), so the power settings above matter more there.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| The slash commands don't show up | Re-invite with the link above: it must include `applications.commands`. Then restart the bot, which registers them in every server it's in. |
| "The application did not respond" | The bot is offline (laptop asleep or `discord.bat` not running), or the Interactions Endpoint URL is set in the Developer Portal. Clear it. |
| Typing does nothing; only `/say` works | Turn on Message Content Intent (Bot tab), then restart the bot. |
| The channel doesn't lock while a villager thinks | Give the bot Manage Roles, then run `/setup` again. `/status` shows why the lock is off. |
| The channel stays locked | Run `/town open` if the town is closed. Otherwise restart the bot, which unlocks at start. As a last resort, remove the Send Messages ✗ for @everyone in the channel's permissions. |
| "Discord didn't accept the bot token" | Reset the token in the Bot tab and run `npm run discord:setup`. |
| 🟡 "The villagers are asleep" | The game server stopped. Check `logs/server.log`; the bot restarts it on its own. |
| "No tunnel program is installed" | Install Cloudflare Tunnel or ngrok (above) and open a new terminal. |
| The watch link says "Bramblewick is closed right now" | The game server isn't running on the laptop. Start `discord.bat` or `play.bat`. |
| `Port 3001 is taken` | Set `MIRROR_PORT` to another port. |

To check the bot end to end without Discord or a model, run `npm run test:discord`. It plays a whole case against a mock Discord and a fake llama-server (Linux and macOS).

## Security

- The bot token lives only in `data/discord.json` or `DISCORD_TOKEN`. If it leaks, reset it in the Bot tab: the old one stops working at once.
- The game server listens on `127.0.0.1` only. Keep `HOST` at its default.
- The watch link is view only, as above, and a Cloudflare quick-tunnel link changes every time you open one.
