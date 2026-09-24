// The conversation box: streams villager replies, offers generated reply choices plus free text.

import * as api from "./api.js";
import { drawPortrait } from "./sprites.js";

const $ = (id) => document.getElementById(id);

export class Dialogue {
  constructor({ getModel, getTimeOfDay, onClose }) {
    this.getModel = getModel;
    this.getTimeOfDay = getTimeOfDay;
    this.onClose = onClose;
    this.histories = new Map(); // npc id -> [{role, content, opener?, model?, stats?}]
    this.npc = null;
    this.busy = false;
    this.abort = null;

    this.box = $("dialogue");
    this.log = $("log");
    this.choices = $("choices");
    this.meta = $("meta");
    this.form = $("free");
    this.input = $("free-input");

    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text || this.busy) return;
      this.input.value = "";
      this.say(text);
    });
    $("close-dialogue").addEventListener("click", () => this.close());
    $("show-agent").addEventListener("click", () => this.showAgent());
    $("reset-talk").addEventListener("click", () => this.reset());
    $("agent-close").addEventListener("click", () => ($("agent-panel").hidden = true));
  }

  get isOpen() {
    return !!this.npc;
  }

  open(npc) {
    this.npc = npc;
    this.box.hidden = false;
    $("dlg-name").textContent = npc.name;
    $("dlg-title").textContent = npc.title || "";
    drawPortrait($("portrait"), npc);
    const history = this.history();
    this.renderLog();
    if (!history.length) {
      history.push({ role: "user", opener: true });
      this.turn();
    } else {
      this.meta.textContent = "";
      this.fetchOptions();
    }
  }

  close() {
    this.abort?.abort();
    this.busy = false;
    this.npc = null;
    this.box.hidden = true;
    $("agent-panel").hidden = true;
    this.input.blur();
    this.onClose?.();
  }

  history() {
    if (!this.histories.has(this.npc.id)) this.histories.set(this.npc.id, []);
    return this.histories.get(this.npc.id);
  }

  reset() {
    if (!this.npc) return;
    const npc = this.npc;
    this.abort?.abort();
    this.busy = false;
    this.histories.delete(npc.id);
    this.open(npc);
  }

  resetAll() {
    this.histories.clear();
  }

  choose(n) {
    const btn = this.choices.querySelectorAll("button")[n];
    if (btn && !btn.disabled) btn.click();
  }

  focusInput() {
    this.input.focus();
  }

  say(text) {
    this.history().push({ role: "user", content: text });
    this.renderLog();
    this.turn();
  }

  // Wire history to the server: {opener} and {role, content} only.
  wire() {
    return this.history()
      .filter((m) => !m.error)
      .map((m) => (m.opener ? { role: "user", opener: true } : { role: m.role, content: m.content }));
  }

  async turn() {
    const npc = this.npc;
    const model = this.getModel();
    if (!model) {
      this.renderChoices([]);
      this.meta.textContent = "No model is downloaded yet. Pick one from the Model menu once a download finishes.";
      return;
    }
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.busy = true;
    this.renderChoices(null, "…");
    const line = this.addLine("npc", "");
    line.classList.add("typing");
    this.meta.textContent = `${model.name} is thinking…`;

    let text = "";
    try {
      for await (const { event, data } of api.talk({ model: model.id, npc: npc.id, history: this.wire(), timeOfDay: this.getTimeOfDay() }, abort.signal)) {
        if (event === "status" && data.state === "loading") this.meta.textContent = `Loading ${data.model} into memory… large models can take a minute.`;
        if (event === "status" && data.state === "generating") this.meta.textContent = `${data.model} is thinking…`;
        if (event === "token") {
          text += data.t;
          line.querySelector(".text").textContent = clean(text, npc.name);
          this.log.scrollTop = this.log.scrollHeight;
        }
        if (event === "error") throw new Error(data.error);
        if (event === "done") {
          const reply = clean(text, npc.name) || "…";
          line.querySelector(".text").textContent = reply;
          line.classList.remove("typing");
          this.history().push({ role: "assistant", content: reply, model: data.model.name, stats: data });
          line.dataset.model = data.model.name;
          this.meta.textContent = stats(data);
        }
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      line.remove();
      this.addLine("error", `Couldn't get a reply: ${e.message}`);
      this.busy = false;
      this.renderChoices([], null, true);
      this.meta.textContent = "";
      return;
    }
    if (abort.signal.aborted || this.npc !== npc) return;
    this.busy = false;
    this.fetchOptions();
  }

  async fetchOptions() {
    const npc = this.npc;
    const model = this.getModel();
    if (!model) return;
    const abort = (this.abort = new AbortController());
    this.renderChoices(null, "Thinking of replies");
    try {
      const { options } = await api.getOptions({ model: model.id, npc: npc.id, history: this.wire() }, abort.signal);
      if (!abort.signal.aborted && this.npc === npc) this.renderChoices(options);
    } catch (e) {
      if (!abort.signal.aborted && this.npc === npc) this.renderChoices(["Where were you last night?", "Who would want to hurt anyone here?", "See you later!"]);
    }
  }

  renderChoices(options, placeholder, retry = false) {
    this.choices.replaceChildren();
    if (options === null) {
      for (let i = 0; i < 3; i++) {
        const b = document.createElement("button");
        b.className = "choice pending";
        b.disabled = true;
        b.innerHTML = `<kbd>${i + 1}</kbd><span>${i === 0 && placeholder ? placeholder : ""}</span>`;
        this.choices.append(b);
      }
      return;
    }
    options.forEach((opt, i) => {
      const b = document.createElement("button");
      b.className = "choice";
      b.innerHTML = `<kbd>${i + 1}</kbd><span></span>`;
      b.querySelector("span").textContent = opt;
      b.addEventListener("click", () => !this.busy && this.say(opt));
      this.choices.append(b);
    });
    if (retry) {
      const b = document.createElement("button");
      b.className = "choice";
      b.innerHTML = "<kbd>1</kbd><span>Try again</span>";
      b.addEventListener("click", () => {
        const h = this.history();
        while (h.length && h.at(-1).error) h.pop();
        this.renderLog();
        this.turn();
      });
      this.choices.append(b);
    }
  }

  addLine(kind, text, model) {
    const div = document.createElement("div");
    div.className = `line ${kind}`;
    const who = kind === "npc" ? this.npc.name : kind === "you" ? "You" : "";
    div.innerHTML = `${who ? `<span class="who"></span>` : ""}<span class="text"></span>`;
    if (who) div.querySelector(".who").textContent = who;
    div.querySelector(".text").textContent = text;
    if (model) div.dataset.model = model;
    this.log.append(div);
    this.log.scrollTop = this.log.scrollHeight;
    return div;
  }

  renderLog() {
    this.log.replaceChildren();
    for (const m of this.history()) {
      if (m.opener) continue;
      this.addLine(m.role === "user" ? "you" : "npc", m.content, m.model);
    }
  }

  async showAgent() {
    if (!this.npc) return;
    const panel = $("agent-panel");
    panel.hidden = false;
    $("agent-file").textContent = `npcs/${this.npc.id}/agent.md`;
    $("agent-md").textContent = "Loading…";
    try {
      const data = await api.getNpc(this.npc.id);
      $("agent-md").textContent = data.raw;
      $("system-prompt").textContent = data.systemPrompt;
    } catch (e) {
      $("agent-md").textContent = e.message;
    }
  }
}

// Small models sometimes prefix their own name, wrap the line in quotes or add stage directions.
function clean(text, name) {
  let t = text.replace(/^\s+/, "");
  const first = name.split(" ")[0];
  t = t.replace(new RegExp(`^(${escape(name)}|${escape(first)})\\s*:\\s*`, "i"), "");
  t = t.replace(/\s*(\([^)\n]{1,80}\)|\*[^*\n]{1,80}\*)/g, "");
  t = t.replace(/^"/, "").replace(/"\s*$/, "");
  return t.trim();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stats(d) {
  const parts = [d.model.name];
  if (d.tokensPerSecond) parts.push(`${d.tokensPerSecond.toFixed(1)} tokens/s`);
  if (d.firstTokenMs != null) parts.push(`first word in ${(d.firstTokenMs / 1000).toFixed(2)}s`);
  if (d.tokens != null) parts.push(`${d.tokens} tokens`);
  return parts.join(" · ");
}
