// Builds the messages sent to the model for villager dialogue and for the player's reply choices.

import { listNpcs, townLore } from "./npcs.js";

export function systemPrompt(npc, ctx = {}) {
  const others = listNpcs()
    .filter((n) => n.id !== npc.id)
    .map((n) => `- ${n.name}, ${n.title || "villager"}`)
    .join("\n");

  return `You are ${npc.name}, ${npc.title || "a villager"} in a cozy top-down farming RPG. You are talking face to face with the player: the newcomer who just took over the old Hollis farm east of town.

# The town
${townLore()}

# Other villagers
${others}

# Who you are
${npc.body}
${ctx.brief ? `\n${ctx.brief}\n` : ""}
# How to talk
- Stay in character as ${npc.name} at all times. Never mention being an AI, a model, a prompt or a game.
- Reply with 1 to 3 short sentences of spoken dialogue, like a villager in Pokemon or Harvest Moon.
- No narration, no stage directions, no asterisks, no emojis, no lists. Do not write the player's lines.
- Only share what ${npc.name} would know. Follow the rules in your secrets section about when to reveal things.
- Speak in your own voice as described above.${ctx.timeOfDay ? `\n- It is currently ${ctx.timeOfDay}.` : ""}`;
}

export const OPENER = "(The newcomer walks up to you and waits for you to speak.)";

export function optionsMessages(npc, history, mystery) {
  const transcript = history
    .slice(-8)
    .map((m) => (m.role === "user" ? (m.content === OPENER ? "(Player walks up.)" : `Player: ${m.content}`) : `${npc.name}: ${m.content}`))
    .join("\n");

  return [
    {
      role: "system",
      content:
        "You write reply choices for the player in a cozy RPG dialogue menu. Output JSON only: {\"options\": [three strings]}. Each option is something the player says out loud, under 10 words, in first person.",
    },
    {
      role: "user",
      content: `The player is talking to ${npc.name}, ${npc.title || "a villager"}.${mystery ? `\nThe player is a detective investigating the murder of ${mystery.victim} at ${mystery.scene} last night.` : ""}

Conversation so far:
${transcript}

Write three different things the player could say next to ${npc.name}:
${
  mystery
    ? `1. a question about where they were or who they saw last night
2. a follow-up that presses on something they just said, or checks it against another villager's story
3. a question about their relationship with ${mystery.victim}, or a polite goodbye`
    : `1. a friendly or curious follow-up to what was just said
2. a question about the town, the other villagers or anything odd going on
3. something playful, bold or a polite goodbye`
}`,
    },
  ];
}

export const OPTIONS_SCHEMA = {
  type: "object",
  properties: {
    options: { type: "array", items: { type: "string", maxLength: 80 }, minItems: 3, maxItems: 3 },
  },
  required: ["options"],
};

// Rough fit to the model's context window: drop the oldest turns first, keep the latest.
export function trimHistory(history, systemText, ctx, reserve) {
  const est = (s) => Math.ceil(s.length / 3.5) + 4;
  let budget = ctx - reserve - est(systemText);
  const kept = [];
  for (let i = history.length - 1; i >= 0; i--) {
    budget -= est(history[i].content);
    if (budget < 0) break;
    kept.unshift(history[i]);
  }
  // Most chat templates expect the first non-system message to be from the user.
  while (kept.length && kept[0].role !== "user") kept.shift();
  return kept;
}
