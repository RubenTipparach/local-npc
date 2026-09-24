// One-step setup: llama.cpp runtime plus a choice of models.
//
//   node scripts/install.js              asks which model set to download
//   node scripts/install.js starter      ~5 GB   three small models, enough to play
//   node scripts/install.js recommended  ~31 GB  everything up to 8B
//   node scripts/install.js all          ~83 GB  every model in config/models.json

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { runtime, models, registry, activeDownload, MODELS_DIR } from "./download.js";

const STARTER = ["tinyllama-1.1b", "llama-3.2-3b", "qwen3-4b-2507"];
const SETS = {
  starter: { label: "Starter", ids: STARTER, blurb: "three small models, enough to play" },
  recommended: { label: "Recommended", ids: registry.models.filter((m) => m.sizeGB <= 5.1).map((m) => m.id), blurb: "every model up to 8B" },
  all: { label: "Everything", ids: registry.models.map((m) => m.id), blurb: "includes 12B–30B models that need CPU offload" },
};

const missingGB = (ids) =>
  registry.models
    .filter((m) => ids.includes(m.id) && !fs.existsSync(path.join(MODELS_DIR, m.file)))
    .reduce((s, m) => s + m.sizeGB, 0);

async function chooseSet() {
  const arg = process.argv[2];
  if (arg) {
    if (!SETS[arg]) throw new Error(`Unknown model set "${arg}". Use starter, recommended or all.`);
    return arg;
  }
  const keys = Object.keys(SETS);
  console.log("\nWhich models should I download?");
  keys.forEach((k, i) => {
    const s = SETS[k];
    const left = missingGB(s.ids);
    console.log(`  ${i + 1}) ${s.label.padEnd(12)} ${s.ids.length} models, ${s.blurb}. ${left ? `${left.toFixed(1)} GB left to download` : "already downloaded"}`);
  });
  if (!process.stdin.isTTY) return "starter";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Choose 1, 2 or 3 [2]: ")).trim() || "2";
  rl.close();
  return keys[Number(answer) - 1] || "recommended";
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node ${process.versions.node} is too old. Install Node 20 or newer from https://nodejs.org`);

  console.log("== local-npc setup ==\n");
  console.log("Step 1 of 2: llama.cpp (the program that runs the models)");
  await runtime();

  console.log("\nStep 2 of 2: models");
  const running = activeDownload();
  if (running) {
    console.log(`A model download is already running in the background (process ${running}).`);
    console.log("It will keep going on its own. Progress: logs/download.log");
  } else {
    const set = await chooseSet();
    const left = missingGB(SETS[set].ids);
    console.log(`\nDownloading ${SETS[set].label.toLowerCase()} set (${left.toFixed(1)} GB). Smallest models come first.`);
    console.log("You can press Ctrl+C at any time and run install again later; downloads resume where they stopped.\n");
    await models(SETS[set].ids);
  }

  const have = registry.models.filter((m) => fs.existsSync(path.join(MODELS_DIR, m.file)));
  console.log(`\nReady: ${have.length} model(s) downloaded.`);
  console.log(have.length ? "Start the game with play.bat (or: npm run play)." : "No models yet. Run install again once the download finishes.");
}

main().catch((e) => {
  console.error(`\nSetup failed: ${e.message}`);
  process.exitCode = 1;
});
