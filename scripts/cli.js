// Text mode: the same villagers, models and mysteries as the browser game, in the terminal.
// Talks to the running server over its HTTP API. Started by `play.bat --cli`.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS = path.join(ROOT, "data", "cli.json");
const PREFERRED = ["qwen3-8b", "llama-3.1-8b", "qwen3-4b-2507", "llama-3.2-3b", "gemma-3-4b", "tinyllama-1.1b"];

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1), dim = paint(2), red = paint(31), green = paint(32), yellow = paint(33), cyan = paint(36), magenta = paint(35);

const HELP = `
${bold("Commands")}
  ${cyan("<number or name>")}   walk up to a villager and talk
  ${cyan("1-3")}                 while talking: pick a suggested reply (anything else is said as typed)
  ${cyan("/leave")}              walk away from the current conversation
  ${cyan("/people")}             list villagers
  ${cyan("/model [n]")}          list models, or switch to model n
  ${cyan("/options on|off")}     suggested replies (off is faster on CPU)
  ${cyan("/agent")}              show the current villager's agent.md
  ${cyan("/reset")}              make the current villager forget your conversation
  ${cyan("/case")}               the case briefing: who, where, when, leads, suspects
  ${cyan("/inspect")}            examine the crime scene
  ${cyan("/accuse <name>")}      name the killer (ends the case)
  ${cyan("/mystery [easy|normal|hard]")}   throw this case away and start a new one
  ${cyan("/help")}  ${cyan("/quit")}
`;

export async function runCli(base) {
  const api = client(base);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const state = {
    models: [],
    modelId: null,
    npcs: [],
    mystery: null,
    npc: null,
    histories: new Map(),
    options: [],
    showOptions: loadSettings().options !== false,
    abort: null,
  };

  rl.on("SIGINT", () => {
    if (state.abort) {
      state.abort.abort();
      return;
    }
    rl.close();
  });
  const ask = lineReader(rl);

  console.log(`\n${bold(magenta("Bramblewick"))} ${dim("· text mode")}`);
  await refresh(api, state);
  const saved = loadSettings().model;
  const pick = [saved, ...PREFERRED].find((id) => state.models.some((m) => m.id === id && m.present)) || state.models.find((m) => m.present)?.id;
  if (!pick) {
    console.log(red("No models are downloaded yet. Run install.bat first."));
    rl.close();
    return;
  }
  await useModel(api, state, pick);
  if (!(await openingCase(api, state, ask))) return rl.close();
  console.log(dim("Type a number or name to talk to someone, or /help for commands."));

  for (;;) {
    const input = await ask(state.npc ? `${cyan("you")} > ` : "> ");
    if (input === null) break; // input closed (Ctrl+C or end of stdin)
    const line = input.trim();
    if (!line) continue;
    try {
      if (line.startsWith("/")) {
        if (!(await command(api, state, ask, line))) break;
      } else if (state.npc) {
        const n = Number(line);
        const text = state.showOptions && n >= 1 && n <= state.options.length ? state.options[n - 1] : line;
        await say(api, state, text);
      } else {
        const npc = findNpc(state, line);
        if (npc) await talkTo(api, state, npc);
        else if (line.includes(" ")) console.log(dim("You're not talking to anyone yet. Type a villager's number or name first."));
        else console.log(dim("Nobody by that name. /people lists everyone."));
      }
    } catch (e) {
      state.abort = null;
      console.log(red(`\n${e.message}`));
    }
  }
  rl.close();
}

// ---- commands -------------------------------------------------------------------------------

async function command(api, state, ask, line) {
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  const arg = args.join(" ");
  switch (cmd.toLowerCase()) {
    case "quit":
    case "exit":
    case "q":
      return false;
    case "help":
    case "h":
      console.log(HELP);
      break;
    case "leave":
      if (state.npc) console.log(dim(`You leave ${state.npc.name}.`));
      state.npc = null;
      printPeople(state);
      break;
    case "people":
      printPeople(state);
      break;
    case "model":
    case "models":
      await modelCommand(api, state, arg);
      break;
    case "options":
      state.showOptions = arg !== "off";
      saveSettings({ options: state.showOptions });
      console.log(dim(`Suggested replies ${state.showOptions ? "on" : "off"}.`));
      break;
    case "agent": {
      if (!state.npc) return notTalking();
      const npc = await api.get(`/api/npcs/${state.npc.id}`);
      console.log(`\n${dim(`npcs/${npc.id}/agent.md`)}\n${npc.raw}\n`);
      break;
    }
    case "reset":
      if (!state.npc) return notTalking();
      state.histories.delete(state.npc.id);
      await talkTo(api, state, state.npc);
      break;
    case "mystery":
      await newMystery(api, state, arg || "normal");
      break;
    case "case":
      if (!state.mystery) console.log(dim("No case is running. Start one with /mystery."));
      else printCaseFile(state);
      break;
    case "inspect":
      if (!state.mystery) console.log(dim("There's nothing to inspect. Start a case with /mystery."));
      else console.log(`\n${bold(`At ${state.mystery.scene}:`)} ${state.mystery.evidence}\n`);
      break;
    case "accuse":
      await accuse(api, state, ask, arg);
      break;
    default:
      console.log(dim(`Unknown command /${cmd}. Type /help.`));
  }
  return true;
}

function notTalking() {
  console.log(dim("You're not talking to anyone. Type a villager's name first."));
  return true;
}

async function modelCommand(api, state, arg) {
  await refresh(api, state);
  const present = state.models.filter((m) => m.present);
  if (arg) {
    const m = present[Number(arg) - 1] || present.find((x) => x.id === arg);
    if (!m) return console.log(dim("No downloaded model with that number."));
    return useModel(api, state, m.id);
  }
  console.log(`\n${bold("Models")} ${dim("(switch with /model <n>)")}`);
  present.forEach((m, i) => {
    const mark = m.id === state.modelId ? green("●") : " ";
    console.log(`  ${mark} ${String(i + 1).padStart(2)}) ${m.name.padEnd(30)} ${dim(`${m.sizeGB} GB`)}`);
  });
  const missing = state.models.length - present.length;
  if (missing) console.log(dim(`  ${missing} more still downloading.`));
  console.log();
}

async function useModel(api, state, id) {
  const m = state.models.find((x) => x.id === id);
  process.stdout.write(dim(`Loading ${m.name}… `));
  const { active } = await api.post("/api/models/load", { id });
  state.modelId = id;
  saveSettings({ model: id });
  const where = active.device?.mode === "cpu" ? "on CPU" : "on GPU";
  console.log(dim(`ready ${where}.`));
}

// ---- conversation ---------------------------------------------------------------------------

function findNpc(state, text) {
  const n = Number(text);
  if (n >= 1 && n <= state.npcs.length) return state.npcs[n - 1];
  const t = text.toLowerCase();
  return state.npcs.find((p) => p.name.toLowerCase().split(" ").some((w) => w.startsWith(t)) || p.id.startsWith(t));
}

async function talkTo(api, state, npc) {
  state.npc = npc;
  state.options = [];
  console.log(`\n${bold(`— ${npc.name}, ${npc.title} —`)} ${dim("(/leave to walk away)")}`);
  const history = histories(state);
  if (history.length) {
    const last = [...history].reverse().find((m) => m.role === "assistant");
    if (last) console.log(`${bold(first(npc))}: ${dim("(earlier)")} ${last.content}`);
    await suggest(api, state);
    return;
  }
  history.push({ role: "user", opener: true });
  await reply(api, state);
}

async function say(api, state, text) {
  histories(state).push({ role: "user", content: text });
  await reply(api, state);
}

async function reply(api, state) {
  const npc = state.npc;
  const abort = (state.abort = new AbortController());
  const history = histories(state);
  const label = `${bold(first(npc))}: `;
  process.stdout.write(label);
  let stopDots = ellipsis();
  const quiet = () => {
    stopDots();
    stopDots = () => {};
  };

  // Hold back the first few characters so a leading "Name:" can be dropped, and any unfinished
  // (stage direction) or closing quote, so nothing printed ever has to be taken back.
  let raw = "", printed = 0, stats = null;
  const flush = (final) => {
    let text = tidy(raw, npc.name, final);
    if (!final) text = text.replace(/[(*][^)*]*$/, "").replace(/"$/, "");
    if (!final && printed === 0 && text.length < 24 && !raw.includes("\n")) return;
    if (text.length > printed) {
      quiet();
      process.stdout.write(text.slice(printed));
    }
    printed = Math.max(printed, text.length);
  };

  try {
    for await (const { event, data } of api.stream("/api/talk", { model: state.modelId, npc: npc.id, history: wire(history) }, abort.signal)) {
      if (event === "status" && data.state === "loading") {
        quiet();
        process.stdout.write(dim(`(loading ${data.model}) `));
        stopDots = ellipsis();
      }
      if (event === "token") {
        raw += data.t;
        flush(false);
      }
      if (event === "error") throw new Error(data.error);
      if (event === "done") stats = data;
    }
  } catch (e) {
    quiet();
    state.abort = null;
    if (abort.signal.aborted) {
      console.log(dim(" (interrupted)"));
      history.pop();
      return;
    }
    history.pop();
    throw e;
  }
  flush(true);
  quiet();
  state.abort = null;
  const content = tidy(raw, npc.name, true) || "…";
  history.push({ role: "assistant", content });
  if (stats) {
    const tps = stats.tokensPerSecond ? ` · ${stats.tokensPerSecond.toFixed(1)} tok/s` : "";
    console.log(`\n${dim(`  ${stats.model.name}${tps}`)}`);
  } else console.log();
  await suggest(api, state);
}

async function suggest(api, state) {
  state.options = [];
  if (!state.showOptions) return;
  process.stdout.write(dim("  thinking of replies"));
  const stopDots = ellipsis();
  try {
    const { options } = await api.post("/api/options", { model: state.modelId, npc: state.npc.id, history: wire(histories(state)) });
    state.options = options;
  } catch {
    state.options = [];
  }
  stopDots();
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  } else process.stdout.write("\n");
  state.options.forEach((o, i) => console.log(`  ${yellow(i + 1)}) ${o}`));
  console.log(dim("  or type anything"));
}

// Animated "." ".." "..." at the cursor while waiting (terminal only). Returns a function that
// stops it and erases the dots, leaving the cursor where the dots began.
function ellipsis() {
  if (!process.stdout.isTTY) return () => {};
  let frame = 1;
  let shown = 0;
  const erase = () => process.stdout.write("\b".repeat(shown) + " ".repeat(shown) + "\b".repeat(shown));
  const draw = () => {
    erase();
    process.stdout.write(dim(".".repeat(frame)));
    shown = frame;
    frame = (frame % 3) + 1;
  };
  draw();
  const timer = setInterval(draw, 400);
  return () => {
    clearInterval(timer);
    erase();
    shown = 0;
  };
}

function histories(state) {
  if (!state.histories.has(state.npc.id)) state.histories.set(state.npc.id, []);
  return state.histories.get(state.npc.id);
}

const wire = (history) => history.map((m) => (m.opener ? { role: "user", opener: true } : { role: m.role, content: m.content }));

// Small models sometimes prefix their own name, add (stage directions) or *actions*, or wrap the
// line in quotes. The trailing quote is only dropped once the reply is complete.
function tidy(text, name, final) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const t = text
    .replace(/^\s+/, "")
    .replace(new RegExp(`^(${esc(name)}|${esc(first({ name }))})\\s*:\\s*`, "i"), "")
    .replace(/\s*(\([^)\n]{1,80}\)|\*[^*\n]{1,80}\*)/g, "")
    .replace(/^"/, "");
  return final ? t.replace(/"\s*$/, "").trim() : t;
}

const first = (npc) => npc.name.split(" ")[0];

// ---- director mode --------------------------------------------------------------------------

async function newMystery(api, state, difficulty) {
  if (!["easy", "normal", "hard"].includes(difficulty)) return console.log(dim("Use /mystery easy, /mystery normal or /mystery hard."));
  const model = state.models.find((m) => m.id === state.modelId);
  console.log(dim(`The director is writing a ${difficulty} case with ${model.name}. On the CPU this takes 1–2 minutes…`));
  const c = await withTimer(() => api.post("/api/case", { difficulty, model: state.modelId }).then((r) => r.case));
  state.histories.clear();
  state.npc = null;
  await refresh(api, state);
  state.mystery = c;
  printCaseIntro(state);
  printPeople(state);
}

// Every game is a murder: resume an unsolved case, or ask for a difficulty and write a new one.
// Returns false if input closed before the player answered.
async function openingCase(api, state, ask) {
  if (state.mystery && !state.mystery.accused) {
    console.log(dim("\nPicking up the case you were working on. /mystery starts a new one."));
    printCaseIntro(state);
    printPeople(state);
    return true;
  }
  const answer = await ask(`\nA body has been found in Bramblewick. How hard should the case be? ${dim("1) easy  2) normal  3) hard")} [2]: `);
  if (answer === null) return false;
  const difficulty = { 1: "easy", 3: "hard", easy: "easy", hard: "hard" }[answer.trim().toLowerCase()] || "normal";
  try {
    await newMystery(api, state, difficulty);
  } catch (e) {
    console.log(red(`The director couldn't write a case: ${e.message}. Try /mystery again.`));
    printPeople(state);
  }
  return true;
}

// Shows elapsed seconds on one line while a slow request runs (terminal only).
async function withTimer(fn) {
  if (!process.stdout.isTTY) return fn();
  const started = Date.now();
  const clear = () => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  };
  const tick = setInterval(() => {
    clear();
    process.stdout.write(dim(`  ${Math.round((Date.now() - started) / 1000)}s`));
  }, 1000);
  try {
    return await fn();
  } finally {
    clearInterval(tick);
    clear();
  }
}

async function accuse(api, state, ask, arg) {
  const c = state.mystery;
  if (!c) return console.log(dim("No case is running."));
  if (c.accused) return console.log(dim("You've already made your accusation. /case shows the solution."));
  const t = arg.toLowerCase();
  const suspect = c.suspects.find((s, i) => String(i + 1) === arg || s.name.toLowerCase().split(" ").some((w) => t && w.startsWith(t)));
  if (!suspect) {
    console.log(`Accuse whom? ${c.suspects.map((s, i) => `${i + 1}) ${s.name}`).join("  ")}`);
    return;
  }
  const sure = ((await ask(`Accuse ${bold(suspect.name)}? This ends the case. [y/N] `)) || "").trim().toLowerCase();
  if (sure !== "y" && sure !== "yes") return console.log(dim("You keep your suspicions to yourself."));
  const { correct, case: solved } = await api.post("/api/case/accuse", { suspect: suspect.id });
  state.mystery = solved;
  console.log(correct ? green(bold(`\nYou got it. ${solved.solution.killer} did it.`)) : red(bold(`\nWrong. It was ${solved.solution.killer}.`)));
  printSolution(solved);
}

// The preamble: who died, where, when, how, and what to follow up on.
function printCaseIntro(state) {
  const c = state.mystery;
  const rule = dim("─".repeat(Math.min(72, process.stdout.columns || 72)));
  console.log(`
${rule}
${red(bold(`☠  ${c.title}`))} ${dim(`· ${c.difficulty}`)}
${rule}`);
  console.log(`${c.discovery}
`);
  console.log(`  ${bold("Who  ")}  ${c.victim.name}, ${c.victim.title}. ${c.victimBio}`);
  console.log(`  ${bold("Where")}  ${cap(c.scene)}`);
  console.log(`  ${bold("When ")}  ${cap(c.timeOfDeath)}. The body was found at 6 AM by ${c.finder}.`);
  console.log(`  ${bold("How  ")}  ${cap(c.weapon)}`);
  console.log(`
${bold("Leads")}`);
  for (const l of c.leads) console.log(`  • ${l}`);
  console.log(`
${bold("Suspects")}  ${c.suspects.map((s, i) => `${i + 1}) ${s.name}`).join("  ")}`);
  console.log(dim(`
Talk to people by number or name. /case shows this briefing again; /accuse <name> when you're sure.
${rule}`));
}

function printCaseFile(state) {
  printCaseIntro(state);
  if (state.mystery.solution) printSolution(state.mystery);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function printSolution(c) {
  const s = c.solution;
  console.log(`${bold("What happened:")} at ${s.murderTime}. ${s.motive}`);
  for (const l of s.liars) console.log(`${bold(l.name)} lied. They were really ${l.truth}. ${l.secret}`);
  console.log(bold("\nWhere everyone really was"));
  for (const row of s.timeline) console.log(`  ${row.name.padEnd(20)} ${row.slots.join(" | ")}`);
  console.log(dim("\n/mystery starts a new case."));
}

// ---- helpers --------------------------------------------------------------------------------

// Lines typed while a villager is still replying are queued, not dropped, and answered next.
function lineReader(rl) {
  const queued = [];
  let waiting = null;
  let closed = false;
  rl.on("line", (l) => (waiting ? (waiting(l), (waiting = null)) : queued.push(l)));
  rl.on("close", () => {
    closed = true;
    waiting?.(null);
    waiting = null;
  });
  return (prompt) => {
    if (closed) process.stdout.write(prompt);
    else {
      rl.setPrompt(prompt);
      rl.prompt();
    }
    if (queued.length) {
      const l = queued.shift();
      if (!process.stdin.isTTY) process.stdout.write(`${l}
`);
      return Promise.resolve(l);
    }
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => (waiting = resolve));
  };
}

async function refresh(api, state) {
  const [{ models }, npcs, { case: c }] = await Promise.all([api.get("/api/models"), api.get("/api/npcs"), api.get("/api/case")]);
  state.models = models;
  state.mystery = c;
  state.npcs = npcs.filter((n) => n.id !== c?.victim.id);
}

function printPeople(state) {
  console.log(`\n${bold("Around town:")}`);
  state.npcs.forEach((n, i) => console.log(`  ${yellow(String(i + 1).padStart(2))}) ${n.name.padEnd(20)} ${dim(n.title)}`));
  console.log();
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...loadSettings(), ...patch }, null, 2));
}

function client(base) {
  const req = async (method, p, body, signal) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body), signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  };
  return {
    get: (p) => req("GET", p),
    post: (p, body) => req("POST", p, body || {}),
    async *stream(p, body, signal) {
      const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) yield { event, data: JSON.parse(data) };
        }
      }
    },
  };
}
