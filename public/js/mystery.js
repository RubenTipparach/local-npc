// Director mode UI: set up a case, read the case file, inspect the scene, accuse a suspect.

import * as api from "./api.js";

const $ = (id) => document.getElementById(id);

export class Mystery {
  constructor({ getModel, onChange, toast }) {
    this.getModel = getModel;
    this.onChange = onChange;
    this.toast = toast;
    this.current = null;
    this.armed = null; // suspect id awaiting a second click to confirm

    $("new-mystery").addEventListener("click", () => this.openSetup());
    $("open-case").addEventListener("click", () => this.openPanel());
    $("setup-cancel").addEventListener("click", () => ($("setup").hidden = true));
    $("case-close").addEventListener("click", () => ($("case-panel").hidden = true));
    $("case-end").addEventListener("click", () => {
      $("case-panel").hidden = true;
      this.openSetup();
    });
    $("setup-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.generate(new FormData(e.target).get("difficulty"));
    });
  }

  get isOverlayOpen() {
    return !$("setup").hidden || !$("case-panel").hidden;
  }

  closeOverlays() {
    if (!$("setup-go").disabled) $("setup").hidden = true;
    $("case-panel").hidden = true;
  }

  async load() {
    try {
      const { case: c } = await api.getCase();
      this.set(c, false);
    } catch {
      // No server case yet; the town runs in its normal mode.
    }
  }

  set(c, changed = true) {
    this.current = c;
    this.armed = null;
    $("open-case").hidden = !c;
    if (c) this.renderPanel();
    this.onChange?.(c, changed);
  }

  openSetup() {
    const model = this.getModel();
    $("setup-model").textContent = model
      ? `${model.name} will write the story. Models of 3B or larger give more coherent cases. On the CPU it takes 1–2 minutes.`
      : "Download or pick a model first.";
    $("setup-go").disabled = !model;
    $("setup-error").hidden = true;
    $("setup").hidden = false;
  }

  async generate(difficulty) {
    const model = this.getModel();
    if (!model) return;
    const go = $("setup-go");
    go.disabled = true;
    go.textContent = "Writing the case…";
    $("setup-error").hidden = true;
    try {
      const { case: c } = await api.newCase(difficulty, model.id);
      $("setup").hidden = true;
      this.set(c);
      this.openPanel();
    } catch (e) {
      $("setup-error").textContent = `The director couldn't write a case: ${e.message}`;
      $("setup-error").hidden = false;
    } finally {
      go.disabled = false;
      go.textContent = "Write the case";
    }
  }

  openPanel() {
    if (!this.current) return;
    this.renderPanel();
    $("case-panel").hidden = false;
  }

  // Called when the player presses E; returns text if they're at the crime scene.
  inspect(tiles) {
    const c = this.current;
    if (!c) return null;
    const [sx, sy] = c.sceneTile;
    if (!tiles.some(([x, y]) => x === sx && y === sy)) return null;
    return `The crime scene. ${c.evidence}`;
  }

  // The briefing: who died, where, when, how, and the leads to follow up on.
  renderPanel() {
    const c = this.current;
    if (!c) return;
    $("case-difficulty").textContent = `Case file · ${c.difficulty}`;
    $("case-title").textContent = c.title;
    $("case-discovery").textContent = c.discovery;
    setFact("case-victim", `${c.victim.name}, ${c.victim.title}`, c.victimBio);
    setFact("case-scene", cap(c.scene), "Marked with a red X on the map");
    setFact("case-window", cap(c.timeOfDeath), `Found at 6 AM by ${c.finder}`);
    setFact("case-weapon", cap(c.weapon));
    $("case-leads").replaceChildren(
      ...c.leads.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      })
    );
    $("case-source").textContent = c.storySource === "model" ? "" : `Story details: ${c.storySource}`;

    const list = $("case-suspects");
    list.replaceChildren();
    for (const s of c.suspects) {
      const li = document.createElement("li");
      li.innerHTML = `<span><b></b><small></small></span>`;
      li.querySelector("b").textContent = s.name;
      li.querySelector("small").textContent = s.title;
      if (!c.accused) {
        const btn = document.createElement("button");
        btn.className = this.armed === s.id ? "accuse armed" : "accuse";
        btn.textContent = this.armed === s.id ? `Yes, accuse ${s.name.split(" ")[0]}` : "Accuse";
        btn.addEventListener("click", () => this.accuse(s.id));
        li.append(btn);
      } else if (s.id === c.accused) {
        li.classList.add("accused");
      }
      list.append(li);
    }
    this.renderSolution();
  }

  async accuse(id) {
    if (this.armed !== id) {
      this.armed = id;
      this.renderPanel();
      return;
    }
    const { correct, case: c } = await api.accuse(id);
    this.set(c, false);
    this.toast(correct ? `You got it. ${c.solution.killer} did it.` : `Wrong. ${c.solution.killer} was the killer. Read the case file to see how it happened.`);
  }

  renderSolution() {
    const c = this.current;
    const box = $("case-solution");
    box.hidden = !c.solution;
    if (!c.solution) return;
    const s = c.solution;
    const accusedName = c.suspects.find((x) => x.id === c.accused)?.name;
    box.innerHTML = `
      <h3 class="${accusedName === s.killer ? "win" : "lose"}"></h3>
      <p class="motive"></p>
      <div class="liars"></div>
      <h4>Where everyone really was</h4>
      <div class="timeline"><table><tbody></tbody></table></div>`;
    box.querySelector("h3").textContent = accusedName === s.killer ? `Solved: ${s.killer} did it` : `Unsolved: you accused ${accusedName}, but it was ${s.killer}`;
    box.querySelector(".motive").textContent = `At ${s.murderTime}. ${s.motive}`;
    for (const l of s.liars) {
      const p = document.createElement("p");
      p.textContent = `${l.name} lied. They were really ${l.truth}. ${l.secret}`;
      box.querySelector(".liars").append(p);
    }
    const tbody = box.querySelector("tbody");
    for (const row of s.timeline) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<th></th>${row.slots.map(() => "<td></td>").join("")}`;
      tr.querySelector("th").textContent = row.name;
      row.slots.forEach((t, i) => (tr.querySelectorAll("td")[i].textContent = t));
      tbody.append(tr);
    }
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function setFact(id, main, note) {
  const dd = $(id);
  dd.textContent = main;
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    dd.append(small);
  }
}
