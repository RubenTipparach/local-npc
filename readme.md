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

On other systems, or without the `.bat` files: `npm run setup`, then `npm run play`. There are no npm dependencies; you need Node 20+. Automatic llama.cpp download is Windows-only; elsewhere, install llama.cpp yourself and set `LLAMA_SERVER`.

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
- **Villagers** are `npcs/<id>/agent.md`: frontmatter for placement, looks and a one-line `hook` (what's going on in their life, which the director uses for motives), then Markdown the model reads as its character sheet, including a personal secret and when to reveal it. `npcs/town.md` is shared lore. Files are re-read on every reply, so edits take effect immediately. In game, the dialogue box's `agent.md` button shows the file and the full system prompt.
- **Models** are listed in `config/models.json`. Any other `.gguf` you drop into `models/` also appears in the picker with default settings.
- **Director mode** (`server/director.js`): code builds the facts so every case is solvable. Each innocent has a partner who can vouch for them at the time of the murder. At most one liar per pair, so an honest partner can always expose a lie. One honest witness glimpses the killer. The selected model then writes the weapon, motive, secrets and relationships. If the model's JSON is unusable, stock text fills the gaps.

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
