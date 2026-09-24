// Director mode: a new murder mystery each game.
//
// The code decides the facts so every case is solvable: who died, who did it, where everyone really
// was, who lies, and which witness can expose each lie. The model only writes the story around those
// facts (weapon, motive, secrets, relationships). If the model's JSON is unusable, stock text fills in.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";
import { listNpcs } from "./npcs.js";
import * as llama from "./llama.js";
import { getModel } from "./registry.js";

const SAVE = path.join(ROOT, "data", "case.json");
const SLOTS = ["9 PM", "10 PM", "11 PM"];

// Places people can be at night, with the map tile the crime-scene marker sits on.
export const PLACES = {
  "the Old Mill": [27, 28],
  "the Riverbank": [34, 16],
  "the Bakery": [5, 10],
  "the Smithy": [30, 10],
  "the Library": [30, 22],
  "the General Store": [6, 22],
  "the plaza": [23, 16],
  "Rosa's fields": [11, 26],
  "the bridge": [36, 14],
};
const SCENES = ["the Old Mill", "the Riverbank", "the Smithy", "the Library", "the General Store", "Rosa's fields"];

export const DIFFICULTY = {
  easy: { liars: 0, killerClaim: "with", sighting: "name", evidence: "trade" },
  normal: { liars: 1, killerClaim: "home", sighting: "name", evidence: "trait" },
  hard: { liars: 2, killerClaim: "home", sighting: "trait", evidence: "ambiguous" },
};

let current = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(SAVE, "utf8"));
  } catch {
    return null;
  }
}

function save() {
  fs.mkdirSync(path.dirname(SAVE), { recursive: true });
  if (current) fs.writeFileSync(SAVE, JSON.stringify(current, null, 2));
  else fs.rmSync(SAVE, { force: true });
}

export const activeCase = () => current;

export function endCase() {
  current = null;
  save();
}

// ---- the facts ------------------------------------------------------------------------------

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
const sentence = (t) => (t ? t.trim().replace(/([^.!?])$/, "$1.") : t);
const lowerArticle = (t) => t.replace(/^(A|An|The) /, (m) => m.toLowerCase());

function trait(npc) {
  if (npc.hat === "straw") return "someone in a straw hat";
  if (npc.hat === "cap") return "someone in a flat cap";
  if (npc.hat === "bonnet") return "someone in a white bonnet";
  if (npc.accessory === "beard") return "someone with a beard";
  if (npc.accessory === "glasses") return "someone whose glasses caught the lamplight";
  return "a figure in a dark coat";
}

function buildFacts(npcs, difficulty) {
  const cfg = DIFFICULTY[difficulty];
  const adults = npcs.filter((n) => n.size !== "small");
  const victim = pick(adults);
  const killer = pick(adults.filter((n) => n !== victim));
  const innocents = shuffle(npcs.filter((n) => n !== victim && n !== killer));
  const scene = pick(SCENES);
  const murderSlot = Math.floor(Math.random() * SLOTS.length);

  // where[id][slot] = { place, with: [ids] }
  const where = Object.fromEntries(npcs.map((n) => [n.id, SLOTS.map(() => ({ place: "home", with: [] }))]));

  // At the time of the murder, innocents are in pairs (a trio if odd) so each has someone to vouch for them.
  const groups = [];
  for (let i = 0; i < innocents.length; i += 2) groups.push(innocents.slice(i, i + 2));
  if (groups.length > 1 && groups.at(-1).length === 1) groups.at(-2).push(groups.pop()[0]);
  const freePlaces = shuffle(Object.keys(PLACES).filter((p) => p !== scene));
  groups.forEach((g, i) => {
    const place = freePlaces[i % freePlaces.length];
    for (const n of g) where[n.id][murderSlot] = { place, with: g.filter((o) => o !== n).map((o) => o.id) };
  });
  where[killer.id][murderSlot] = { place: scene, with: [victim.id] };
  where[victim.id][murderSlot] = { place: scene, with: [killer.id] };

  // Other hours: people wander; anyone sharing a place saw each other.
  SLOTS.forEach((_, s) => {
    if (s === murderSlot) return;
    const byPlace = {};
    for (const n of npcs) {
      if (s > murderSlot && n === victim) continue;
      const place = Math.random() < 0.35 ? "home" : pick(Object.keys(PLACES));
      where[n.id][s] = { place, with: [] };
      if (place !== "home") (byPlace[place] ||= []).push(n.id);
    }
    for (const ids of Object.values(byPlace)) for (const id of ids) where[id][s].with = ids.filter((o) => o !== id);
  });
  if (murderSlot < SLOTS.length - 1) for (let s = murderSlot + 1; s < SLOTS.length; s++) where[victim.id][s] = { place: "dead", with: [] };

  // Innocent liars: at most one per group, so an honest group-mate can always contradict them.
  const liars = groups.slice(0, cfg.liars).map((g) => g[0].id);

  // The killer's cover story.
  const alibiPartner = innocents.find((n) => !liars.includes(n.id));
  const killerClaim =
    cfg.killerClaim === "with" && alibiPartner
      ? { place: where[alibiPartner.id][murderSlot].place, with: alibiPartner.id }
      : { place: "home", with: null };

  // One honest witness glimpsed the killer heading toward the scene.
  const honest = innocents.filter((n) => !liars.includes(n.id));
  const witness = pick(honest);
  const finder = pick(honest.filter((n) => n !== witness).length ? honest.filter((n) => n !== witness) : honest);
  const scapegoat = pick(innocents);
  const who = cfg.sighting === "name" ? `${killer.name} (you're fairly sure)` : trait(killer);

  return {
    victim: victim.id,
    killer: killer.id,
    scene,
    murderSlot,
    where,
    liars,
    killerClaim,
    witness: witness.id,
    sighting: `Around ${SLOTS[murderSlot]}, on your way from ${where[witness.id][murderSlot].place}, you saw ${who} hurrying toward ${scene}.`,
    finder: finder.id,
    scapegoat: scapegoat.id,
    evidenceKind: cfg.evidence,
    killerTrait: trait(killer),
  };
}

// ---- the story ------------------------------------------------------------------------------

const FALLBACK = {
  weapons: ["a heavy iron poker", "a length of rope", "a cast-iron skillet", "a fishing gaff", "a pair of shears"],
  motives: [
    "the victim had discovered a secret that would have ruined them",
    "a long-buried quarrel over money finally boiled over",
    "the victim threatened to tell the whole town about their past",
  ],
  secrets: [
    "were secretly gambling and did not want anyone to know",
    "were meeting someone to buy back a family heirloom they had pawned",
    "were out after promising your family they would stay in",
  ],
};

async function writeStory(facts, npcs, modelId) {
  const byId = Object.fromEntries(npcs.map((n) => [n.id, n]));
  const victim = byId[facts.victim], killer = byId[facts.killer];
  const suspects = npcs.filter((n) => n.id !== facts.victim);
  const evidenceGuide = {
    trade: `an object at the scene clearly tied to ${killer.name}'s work or habits (${killer.title}), without naming them`,
    trait: `a small physical clue that points to ${facts.killerTrait}, without naming anyone`,
    ambiguous: `an ambiguous clue that could fit two or three different villagers`,
  }[facts.evidenceKind];

  const prompt = `You are the director of a cozy-but-dark village murder mystery. The facts below are fixed; do not change who did it. Write the story details as JSON.

Village: Bramblewick, a small farming town. Villagers, with what is going on in their lives (use this for motives and suspicions):
${npcs.map((n) => `- ${n.id}: ${n.name}, ${n.title}.${n.hook ? ` ${n.hook}` : ""}`).join("\n")}

Fixed facts:
- Victim: ${victim.name} (${victim.title})
- Killer: ${killer.name} (${killer.title})
- Scene: ${facts.scene}, at about ${SLOTS[facts.murderSlot]} last night
- Body found at 6 AM by ${byId[facts.finder].name}
${facts.liars.map((id) => `- ${byId[id].name} was really at ${facts.where[id][facts.murderSlot].place} at ${SLOTS[facts.murderSlot]} and will lie about it. They are innocent but hiding a secret.`).join("\n")}

Write:
- title: a short case name
- weapon: what killed the victim (something found in a farming village)
- discovery: 1-2 sentences on how the body was found and what the scene looked like
- victimBio: 1 sentence on who the victim was to the town
- motive: 1-2 sentences on why ${killer.name} did it, grounded in what is going on in their life or the victim's
- evidence: 1-2 sentences describing ${evidenceGuide}
- relations: for each suspect id, 1 sentence on their relationship with ${victim.name}, including a reason they might look suspicious
- secrets: for each lying villager id listed above, 1 sentence on the embarrassing but innocent reason they were at that place and are hiding it, written in second person ("You were ...")`;

  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      weapon: { type: "string" },
      discovery: { type: "string" },
      victimBio: { type: "string" },
      motive: { type: "string" },
      evidence: { type: "string" },
      relations: {
        type: "array",
        items: { type: "object", properties: { id: { enum: suspects.map((n) => n.id) }, relation: { type: "string" } }, required: ["id", "relation"] },
      },
      secrets: {
        type: "array",
        items: { type: "object", properties: { id: { enum: facts.liars.length ? facts.liars : ["none"] }, secret: { type: "string" } }, required: ["id", "secret"] },
      },
    },
    required: ["title", "weapon", "discovery", "victimBio", "motive", "evidence", "relations", "secrets"],
  };

  let story = {};
  let source = "model";
  try {
    const model = getModel(modelId);
    await llama.ensure(model.id);
    const r = await fetch(`${llama.upstream()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1400,
        temperature: 0.9,
        response_format: { type: "json_schema", json_schema: { name: "case", schema } },
        chat_template_kwargs: model.chatTemplateKwargs,
      }),
    });
    story = JSON.parse((await r.json()).choices[0].message.content);
  } catch (e) {
    source = `stock text (model failed: ${e.message})`;
  }

  const relations = Object.fromEntries((story.relations || []).map((r) => [r.id, r.relation]));
  const secrets = Object.fromEntries((story.secrets || []).map((s) => [s.id, s.secret]));
  return {
    source,
    title: story.title || `The ${facts.scene.replace(/^the /, "")} Affair`,
    weapon: lowerArticle((story.weapon || pick(FALLBACK.weapons)).replace(/[.]$/, "")),
    discovery: sentence(story.discovery) || `${byId[facts.finder].name} found ${victim.name} at ${facts.scene} at dawn.`,
    victimBio: sentence(story.victimBio) || "",
    motive: sentence(story.motive) || pick(FALLBACK.motives),
    evidence: sentence(story.evidence) || `Near the body you find a scrap of cloth snagged on a nail. It could belong to ${facts.killerTrait}.`,
    relations: Object.fromEntries(suspects.map((n) => [n.id, sentence(relations[n.id]) || `You knew ${victim.name} the way everyone in a small town does.`])),
    secrets: Object.fromEntries(facts.liars.map((id) => [id, sentence(secrets[id]) || `You ${pick(FALLBACK.secrets)}.`])),
  };
}

export async function newCase({ difficulty = "normal", model }) {
  if (!DIFFICULTY[difficulty]) throw Object.assign(new Error(`Unknown difficulty "${difficulty}"`), { status: 400 });
  const npcs = listNpcs();
  if (npcs.filter((n) => n.size !== "small").length < 3) throw new Error("Need at least three adult villagers for a mystery");
  const facts = buildFacts(npcs, difficulty);
  const story = await writeStory(facts, npcs, model);
  current = { id: Date.now().toString(36), difficulty, createdAt: new Date().toISOString(), ...facts, story, accused: null };
  save();
  return current;
}

// ---- what each side gets to see ------------------------------------------------------------

export function publicView(c = current) {
  if (!c) return null;
  const byId = Object.fromEntries(listNpcs().map((n) => [n.id, n]));
  return {
    id: c.id,
    difficulty: c.difficulty,
    title: c.story.title,
    victim: { id: c.victim, name: byId[c.victim]?.name, title: byId[c.victim]?.title },
    scene: c.scene,
    sceneTile: PLACES[c.scene],
    window: `${SLOTS[0]} to ${SLOTS.at(-1)}`,
    timeOfDeath: c.difficulty === "easy" ? `around ${SLOTS[c.murderSlot]} last night` : `between ${SLOTS[0]} and ${SLOTS.at(-1)} last night`,
    leads: leads(c, byId),
    weapon: c.story.weapon,
    discovery: c.story.discovery,
    victimBio: c.story.victimBio,
    evidence: c.story.evidence,
    finder: byId[c.finder]?.name,
    suspects: Object.keys(c.where).filter((id) => id !== c.victim).map((id) => ({ id, name: byId[id]?.name, title: byId[id]?.title })),
    liarCount: c.liars.length,
    storySource: c.story.source,
    accused: c.accused,
    solution: c.accused ? solution(c) : undefined,
  };
}

// The briefing's list of things the player can follow up on. Never gives away the killer.
function leads(c, byId) {
  const name = (id) => byId[id]?.name || id;
  const liars = c.liars.length;
  return [
    `At the scene: ${c.story.evidence}`,
    `${name(c.finder)} found the body at 6 AM. Ask what they saw.`,
    c.difficulty === "easy"
      ? `${name(c.witness)} was out late and saw someone heading toward ${c.scene}.`
      : `Someone was out late and saw a figure heading toward ${c.scene}. Find out who.`,
    `Everyone was somewhere between ${SLOTS[0]} and ${SLOTS.at(-1)}. Ask each villager where they were at ${SLOTS.slice(0, -1).join(", ")} and ${SLOTS.at(-1)}, and who they were with. Stories that don't line up are your best lead.`,
    liars === 0
      ? "Only the killer is lying."
      : `Besides the killer, ${liars} innocent ${liars === 1 ? "villager is" : "villagers are"} lying to protect a secret. A lie alone doesn't make someone the killer.`,
  ];
}

export function accuse(id) {
  if (!current) throw Object.assign(new Error("No case is running"), { status: 409 });
  current.accused = id;
  save();
  return { correct: id === current.killer, case: publicView() };
}

function solution(c) {
  const byId = Object.fromEntries(listNpcs().map((n) => [n.id, n]));
  const name = (id) => byId[id]?.name || id;
  return {
    killer: name(c.killer),
    motive: c.story.motive,
    murderTime: SLOTS[c.murderSlot],
    liars: c.liars.map((id) => ({ name: name(id), truth: describeSlot(c, id, c.murderSlot, name), secret: c.story.secrets[id] })),
    timeline: Object.keys(c.where).map((id) => ({
      name: name(id),
      slots: SLOTS.map((t, s) => `${t}: ${describeSlot(c, id, s, name)}`),
    })),
  };
}

function describeSlot(c, id, s, name) {
  const w = c.where[id][s];
  if (w.place === "dead") return "dead";
  const place = w.place === "home" ? "at home" : `at ${w.place}`;
  return w.with.length ? `${place} with ${w.with.map(name).join(" and ")}` : place;
}

// The part of a villager's system prompt that tells them their role in the current case.
export function briefFor(npcId) {
  const c = current;
  if (!c || npcId === c.victim) return "";
  const byId = Object.fromEntries(listNpcs().map((n) => [n.id, n]));
  const name = (id) => byId[id]?.name || id;
  const victim = byId[c.victim];
  const t = SLOTS[c.murderSlot];

  const truth = SLOTS.map((slot, s) => `- ${slot}: ${describeSlot(c, npcId, s, name)}`).join("\n");
  const seen = [];
  SLOTS.forEach((slot, s) => {
    const w = c.where[npcId][s];
    if (w.place !== "home") for (const o of w.with) seen.push(`- At ${slot} at ${w.place} you were with ${name(o)}.`);
  });
  if (npcId === c.witness) seen.push(`- ${c.sighting}`);

  let role;
  if (npcId === c.killer) {
    const claim = c.killerClaim.with ? `at ${c.killerClaim.place} with ${name(c.killerClaim.with)}` : "at home, asleep early";
    role = `You killed ${victim.name} at ${c.scene} at ${t} with ${c.story.weapon}. Why: ${c.story.motive}
Never admit it. Your cover story: at ${t} you were ${claim}. Tell it calmly and consistently. Be truthful about the other hours. If someone's account contradicts you, get defensive and suggest the newcomer look harder at ${name(c.scapegoat)}. Only confess if the newcomer names you as the killer AND points to a specific contradiction or piece of evidence against you.`;
  } else if (c.liars.includes(npcId)) {
    const w = c.where[npcId][c.murderSlot];
    role = `You are innocent, but you are hiding something. At ${t} you claim you were at home asleep. The truth: you were at ${w.place}${w.with.length ? ` with ${w.with.map(name).join(" and ")}` : ""}.
Why you are hiding it: ${c.story.secrets[npcId]}
Keep up the lie at first. If the newcomer tells you someone saw you at ${w.place}, or presses you twice, admit the truth, explain your secret with embarrassment, and swear you did not hurt ${victim.name}.`;
  } else {
    role = `You are innocent and have nothing to hide about last night. Answer honestly about where you were and who you saw. You do not know who did it, but you may share suspicions, gossip or worries.`;
  }

  return `# Last night's murder
This is all anyone in town can think about today. Everyone is shaken.
${victim.name}, ${victim.title}, was found dead at ${c.scene} at 6 AM by ${name(c.finder)}. ${c.story.discovery} ${victim.name} was killed with ${c.story.weapon} some time between ${SLOTS[0]} and ${SLOTS.at(-1)}. The newcomer is asking everyone questions.
${c.story.victimBio}

Your relationship with ${victim.name}: ${c.story.relations[npcId]}

## Where you really were last night
${truth}

## What you noticed
${seen.length ? seen.join("\n") : "- Nothing unusual."}

## Your role
${role}`;
}
