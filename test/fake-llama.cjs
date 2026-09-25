// Stands in for llama-server in tests, so the real game server runs without a model: answers
// /health, streams a canned villager line that repeats back what the player said (proving the
// conversation reached the model), and returns JSON for reply suggestions and the director.
// FAKE_LLAMA_MS sets the delay between streamed words.

const http = require("node:http");

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const delay = Number(process.env.FAKE_LLAMA_MS || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STORY = {
  title: "The Millpond Affair",
  weapon: "a fishing gaff",
  discovery: "The body lay face down beside the mill wheel, boots still wet.",
  victimBio: "Everyone owed them a favour or a grudge.",
  motive: "The victim was about to tell the whole town a secret that would have ruined the killer.",
  evidence: "A torn scrap of cloth is caught on a nail by the door.",
  relations: [],
  secrets: [],
};

http
  .createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"status":"ok"}');
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const json = (obj) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
    };
    const schema = body.response_format?.json_schema?.name;
    if (schema === "options") return json({ options: ["Where were you at ten?", "Who did you see by the mill?", "Thanks, I'll be off."] });
    if (schema === "case") return json(STORY);

    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user")?.content || "";
    const answer = lastUser.startsWith("(The newcomer walks up")
      ? "Well now, a newcomer. What brings you down to the river?"
      : `You ask me "${lastUser}"? The river remembers, young sprout.`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const words = answer.split(/(?<= )/);
    for (const w of words) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      await sleep(delay);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], timings: { predicted_per_second: 12.5, prompt_n: 100, predicted_n: words.length } })}\n\n`);
    res.end("data: [DONE]\n\n");
  })
  .listen(port, "127.0.0.1");
