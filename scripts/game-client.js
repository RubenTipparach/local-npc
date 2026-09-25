// Shared by the text mode (scripts/cli.js) and the Discord bot (discord/): the HTTP client for the
// game server's API, plus the small text helpers both front ends need to present a villager's reply.

// Models tried in this order when nothing has been picked yet.
export const PREFERRED = ["qwen3-8b", "llama-3.1-8b", "qwen3-4b-2507", "llama-3.2-3b", "gemma-3-4b", "tinyllama-1.1b"];

export function client(base) {
  const req = async (method, p, body, signal) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body), signal });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  };
  return {
    get: (p, signal) => req("GET", p, undefined, signal),
    post: (p, body, signal) => req("POST", p, body || {}, signal),
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

// A villager by list number (1-based) or by the start of any word of their name or id.
export function findNpc(npcs, text) {
  const n = Number(text);
  if (n >= 1 && n <= npcs.length) return npcs[n - 1];
  const t = text.toLowerCase();
  return npcs.find((p) => p.name.toLowerCase().split(" ").some((w) => w.startsWith(t)) || p.id.startsWith(t));
}

// The history as the server wants it: the silent "player walks up" turn is sent as {opener: true}.
export const wire = (history) => history.map((m) => (m.opener ? { role: "user", opener: true } : { role: m.role, content: m.content }));

// Small models sometimes prefix their own name, add (stage directions) or *actions*, or wrap the
// line in quotes. The trailing quote is only dropped once the reply is complete.
export function tidy(text, name, final) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const t = text
    .replace(/^\s+/, "")
    .replace(new RegExp(`^(${esc(name)}|${esc(first({ name }))})\\s*:\\s*`, "i"), "")
    .replace(/\s*(\([^)\n]{1,80}\)|\*[^*\n]{1,80}\*)/g, "")
    .replace(/^"/, "");
  return final ? t.replace(/"\s*$/, "").trim() : t;
}

// The part of a reply that's still streaming that is safe to show: any unfinished (stage direction)
// or closing quote is held back, so nothing shown ever has to be taken back.
export const partial = (raw, name) => tidy(raw, name, false).replace(/[(*][^)*]*$/, "").replace(/"$/, "");

// Before anything is shown, wait for a few characters so a leading "Name:" can still be dropped.
export const holdBack = (text, raw) => text.length < 24 && !raw.includes("\n");

export const first = (npc) => npc.name.split(" ")[0];

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
