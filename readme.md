# local-npc

A small top-down town (Bramblewick) where every villager is played by a local LLM. Walk around, talk to people in free text or pick from generated replies, and switch models at any time to compare them.

Every game is a murder mystery. The director picks a victim and a killer from the villagers and gives everyone an alibi. You get a briefing (who died, where, when, how, and your leads), then question villagers, compare their stories, and accuse someone. Each case is different. Difficulty sets how many innocent villagers also lie to protect secrets of their own.

## Quick start (Windows)

1. Double-click **`install.bat`**. It checks for Node.js (and offers to install it with winget), downloads llama.cpp, then asks which models to get:
   - **Starter** (~5 GB): TinyLlama, Llama 3.2 3B, Qwen3 4B. Enough to play.
   - **Recommended** (~31 GB): every model up to 8B.
   - **Everything** (~83 GB): adds the 12B–30B models.

   Skip the question with `install.bat starter`, `install.bat recommended` or `install.bat all`. Press Ctrl+C at any time; running it again resumes the downloads.
2. Double-click **`play.bat`**. It starts the game and opens http://127.0.0.1:3000. Press Ctrl+C in its window to stop.

   For **text mode** in the console instead of the browser, run `play.bat --cli` from a terminal in this folder. You get the same villagers, models and mysteries. Type a villager's number or name to talk, `1`–`3` to pick a suggested reply (or type your own), and `/help` for everything else (`/model`, `/mystery hard`, `/case`, `/inspect`, `/accuse`, `/quit`). The server's log goes to `logs/server.log`.

3. Optional: double-click **`discord.bat`** to run the game as a Discord bot, so friends can play in a channel of your server. See [Discord bot](#discord-bot).

On other systems, or without the `.bat` files: `npm run setup`, then `npm run play` (or `npm run discord`). You need Node 20+. The game itself has no npm dependencies; the Discord bot needs discord.js, which it installs by itself the first time. Automatic llama.cpp download is Windows-only; elsewhere, install llama.cpp yourself and set `LLAMA_SERVER`.

Controls: WASD or arrow keys to walk, Shift to run, E to talk or inspect, 1–3 to pick a reply, T to type your own, Esc to leave.

## How it fits together

```
browser (public/)  ──►  node server (server/)  ──►  llama-server child process (runtime/llama.cpp)
                         │                              one model loaded at a time,
                         ├─ npcs/*/agent.md             swapped when you pick another
                         ├─ config/models.json
                         └─ data/case.json (current mystery)
```

- **One API for every model.** `server/index.js` exposes the game API and an OpenAI-compatible API at `http://127.0.0.1:3000/v1`. Set `"model"` to any id from `config/models.json`, and the server loads that GGUF (unloading the previous one) before answering. Other tools such as scripts or chat UIs can point at it too.
- **Other front ends.** Text mode (`scripts/cli.js`) and the Discord bot (`discord/`) talk to the same game API as the browser; `scripts/game-client.js` is the client code they share.
- **Villagers** are `npcs/<id>/agent.md`: frontmatter for placement, looks and a one-line `hook` (what's going on in their life, which the director uses for motives), then Markdown the model reads as its character sheet, including a personal secret and when to reveal it. `npcs/town.md` is shared lore. Files are re-read on every reply, so edits take effect immediately. In game, the dialogue box's `agent.md` button shows the file and the full system prompt.
- **Models** are listed in `config/models.json`. Any other `.gguf` you drop into `models/` also appears in the picker with default settings.
- **Director mode** (`server/director.js`): code builds the facts so every case is solvable. Each innocent has a partner who can vouch for them at the time of the murder. At most one liar per pair, so an honest partner can always expose a lie. One honest witness glimpses the killer. The selected model then writes the weapon, motive, secrets and relationships. If the model's JSON is unusable, stock text fills the gaps.

## Discord bot

Run Bramblewick in a channel of your Discord server, from your own computer. The whole channel plays one case together: everyone sees what the villagers say, while lookups (the case file, a villager's agent.md, the chat log) answer only the person who asked.

### Set it up (once)

1. Double-click **`discord.bat`** (or run `npm run discord`). The first time, it installs the Discord library and walks you through making a bot in the [Discord Developer Portal](https://discord.com/developers/applications): you paste the bot's token and it prints the link that invites the bot to your server. The token is saved in `data/discord.json`, which is git-ignored.
2. In the channel you want to play in, type `/setup`. The bot replies with a checklist of what works.

That's all. From then on, `discord.bat` starts the game server and the bot together, and Ctrl+C (or closing the window) closes the town. Run `npm run discord:setup` to paste a new token.

The invite link asks for View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions and **Manage Roles**. Manage Roles is only used to lock the play channel while a villager is thinking; the bot only ever changes that channel's Send Messages setting. Also turn on **Message Content Intent** in the portal's Bot tab so players can just type to talk; without it they use `/say`.

### Playing

Everyone sees these:

| Command | What it does |
| --- | --- |
| `/talk <villager>` | Walk up to someone. Then just type in the channel to talk to them. |
| *(type a line)* | Said to whoever the table is talking to. `1`–`3` picks a suggested reply, a villager's name or number walks up to them, and a line starting with `//` is players talking among themselves. |
| Reply buttons | The three suggested replies, plus **Walk away**. Anyone can click. |
| `/say <text>` | Say something (for when typing isn't turned on). |
| `/leave` · `/reset` | Walk away · make the villager forget your conversation. |
| `/mystery [easy\|normal\|hard]` | Start a new case. Only the host can throw away a case nobody has solved. |
| `/accuse <suspect>` | Asks you privately first, then announces the verdict and the solution to everyone. |
| `/options on\|off` | Suggested replies (off is faster on CPU). |

Only you see these: `/case` (the briefing), `/inspect`, `/people`, `/agent [villager]` (spoilers), `/model` (the list), `/log [villager]` (this case's chat log as a Markdown file), `/status` and `/help`. They work from any channel of the server.

Host only: `/setup`, `/town open|close` (closing unloads the model to free up the laptop and locks the channel), and `/model <name>` to switch models. The host is whoever owns the bot in the Developer Portal, plus anyone with Manage Server, plus any user ids listed under `hosts` in `data/discord.json`.

### While a villager is thinking

Only one villager thinks at a time (there's one model), so while one does:

- The channel is locked: Send Messages is turned off for everyone until the answer and its suggested replies are in, then put back exactly as it was. Server admins can still type; their messages get a ⏳ and aren't heard.
- Older reply buttons stop working, and anything that would make someone think again gets a private "hold that thought".
- The bot's status turns red (Do Not Disturb) and reads "💭 Old Wen is thinking…". The director writing a case and a model loading count as thinking too.

### Online and offline

The town only exists while your laptop is on, so the bot keeps the channel honest about it. It keeps one status message at the bottom of the channel:

- 🟢 **open** when the bot starts, with the case and model. Its presence is green.
- 🔴 **closed** when you press Ctrl+C or close the window: it posts that, locks the channel and goes offline. The case and every conversation are kept for next time.
- If the laptop sleeps or the bot crashes, Discord shows it offline. When it's back, the status says how long it was gone and how many messages nobody heard, and a channel left locked mid-thought is unlocked.
- 🟡 **the villagers are asleep** if the game server stops: the channel locks and the server is restarted.
- If the laptop starts before its Wi-Fi does, the bot keeps trying until Discord is reachable.

`/status` shows all of it at once: open or closed, the model, the case, who's thinking, and whether locking and typing work.

### Chat logs and memory

- Every villager's memory of the conversation is saved in `data/discord-state.json`, so a restart or the laptop sleeping picks up exactly where the table left off.
- Everything said is also logged, one file per case, in `logs/discord/<case id>.jsonl`. `/log` turns the current case's log into a readable transcript.
- A new case (from Discord, the browser or text mode) starts everyone's conversations fresh; `/reset` clears just one villager.

### Settings

`data/discord.json` holds `token` and `channelId`, plus optional `hosts` (a list of user ids), `lockChannel` (`false` to never lock the channel) and `closeWhenOffline` (`false` to leave the channel open while the bot is offline). The environment variables `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID` and `DISCORD_HOSTS` (comma-separated) override the file.

`npm run test:discord` plays through a whole case against a mock Discord and a fake llama-server (no token or model needed; Linux and macOS).

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/models` | Models, which are downloaded, and which is loaded |
| POST | `/api/models/load` `{id}` | Load a model (swaps out the current one) |
| POST | `/api/models/unload` | Free the GPU/CPU |
| GET | `/api/npcs` · `/api/npcs/:id` | Villagers; the detail view includes the system prompt |
| POST | `/api/talk` `{model, npc, history}` | Server-sent events: `status`, `token`, `done`, `error` |
| POST | `/api/options` `{model, npc, history}` | Three suggested player replies |
| GET/POST | `/api/case` | Current mystery / generate one `{difficulty, model}` |
| POST | `/api/case/accuse` `{suspect}` | Name the killer; returns the solution |
| POST | `/api/case/end` | Drop the current case |
| GET | `/v1/models` | OpenAI-compatible model list |
| POST | `/v1/chat/completions` | OpenAI-compatible chat (streaming works) |

## GPU or CPU

On the first model load, the server runs a short `llama-bench` self-test on the GPU. If it fails, every model runs on the CPU and the console says why. The result is saved in `data/device.json` for a week, so later starts skip the test; delete that file to re-test sooner. On this laptop (RTX 2000 Ada, driver 595.79), GPU prompt batches larger than 32 tokens crash with `CUDA error: an illegal memory access`, and the Vulkan build fails too. That points at the driver or GPU rather than llama.cpp. After a driver update or reboot, restart the server to re-test. To skip the test, set `LLAMA_DEVICE=gpu` or `LLAMA_DEVICE=cpu`.

Environment variables: `PORT` (3000), `HOST` (127.0.0.1), `LLAMA_PORT` (8081, first of 20 ports used in rotation), `LLAMA_SERVER` (path to your own llama-server), `LLAMA_CUDA` (13.4, runtime download), `DOWNLOAD_CONNECTIONS` (8).
