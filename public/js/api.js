// Thin client for the local-npc server.

async function json(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && JSON.stringify(opts.body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export const getModels = () => json("/api/models");
export const loadModel = (id) => json("/api/models/load", { method: "POST", body: { id } });
export const getNpcs = () => json("/api/npcs");
export const getNpc = (id) => json(`/api/npcs/${id}`);
export const getOptions = (body, signal) => json("/api/options", { method: "POST", body, signal });
export const getCase = () => json("/api/case");
export const newCase = (difficulty, model) => json("/api/case", { method: "POST", body: { difficulty, model } });
export const accuse = (suspect) => json("/api/case/accuse", { method: "POST", body: { suspect } });

// Streams a villager's reply. Yields {event, data} for status, token, done and error events.
export async function* talk(body, signal) {
  const r = await fetch("/api/talk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}
