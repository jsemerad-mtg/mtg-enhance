#!/usr/bin/env node
// Builds public/commanders.json — every Commander-legal commander, with its
// color identity, as a compact "Name|WUBG" list.
//
//   node scripts/build-commanders.js
//
// Re-run after each new set release. Nothing breaks if you forget: the client
// falls back to a live Scryfall lookup for any name not in the snapshot.
//
// Must run on a machine that can reach api.scryfall.com — the Cloudflare
// Worker can't (Scryfall blocks Worker IPs) and neither can Claude's sandbox.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "commanders.json");
const QUERY = "is:commander legal:commander";
const PAGE_PAUSE_MS = 120; // Scryfall asks for 50–100ms between requests
const WUBRG = ["W", "U", "B", "R", "G"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let url =
    "https://api.scryfall.com/cards/search?q=" +
    encodeURIComponent(QUERY) +
    "&unique=cards&order=name";
  const entries = [];
  let page = 0;

  while (url) {
    page++;
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "MTGEnhance/0.1" },
    });
    if (!res.ok) throw new Error(`Scryfall returned ${res.status} on page ${page}`);
    const json = await res.json();

    for (const card of json.data) {
      // Scryfall gives color_identity alphabetically (["B","G","U","W"]);
      // store it in WUBRG order so the string is a stable key.
      const ci = WUBRG.filter((c) => card.color_identity.includes(c)).join("");
      entries.push(`${card.name}|${ci}`);
    }
    process.stdout.write(`\rpage ${page} — ${entries.length} commanders`);

    url = json.has_more ? json.next_page : null;
    if (url) await sleep(PAGE_PAUSE_MS);
  }

  // Guard against writing a truncated file over a good one.
  if (entries.length < 2000) {
    throw new Error(`Only ${entries.length} commanders found — refusing to write a short file.`);
  }

  entries.sort((a, b) => a.localeCompare(b));
  const payload = { built: new Date().toISOString().slice(0, 10), commanders: entries };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload));

  const kb = (Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0);
  console.log(`\n✓ ${entries.length} commanders → public/commanders.json (${kb} KB)`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
});
