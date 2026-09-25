// Chat logs: everything said at the table, one file per case, in logs/discord/<case id>.jsonl.
// /log turns the current case's file into a readable Markdown transcript.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./store.js";

const DIR = path.join(ROOT, "logs", "discord");
const file = (caseId) => path.join(DIR, `${String(caseId || "no-case").replace(/[^\w-]/g, "")}.jsonl`);

// entry: {kind: "say" | "npc" | "event", who?, npc?, text}
export function record(caseId, entry) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(file(caseId), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) {
    console.error(`[discord] couldn't write the chat log: ${e.message}`);
  }
}

export function entries(caseId) {
  try {
    return fs
      .readFileSync(file(caseId), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// A Markdown transcript, optionally only the parts involving one villager.
export function markdown(caseId, { title, npc } = {}) {
  let list = entries(caseId);
  if (npc) list = list.filter((e) => e.npc === npc || (e.kind === "event" && !e.npc));
  if (!list.some((e) => e.kind !== "event")) return null;
  const out = [`# Bramblewick${title ? `: ${title}` : ""}`, ""];
  let day = "";
  for (const e of list) {
    const d = new Date(e.at);
    const date = d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    if (date !== day) {
      out.push(`## ${date}`, "");
      day = date;
    }
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    if (e.kind === "say") out.push(`\`${time}\` **${e.who}** to ${e.npc}: ${e.text}  `);
    else if (e.kind === "npc") out.push(`\`${time}\` **${e.npc}:** ${e.text}  `);
    else out.push(`\`${time}\` *${e.text}*  `);
  }
  return out.join("\n") + "\n";
}
