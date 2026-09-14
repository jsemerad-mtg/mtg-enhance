// Who may play which sound, and whether the server's catalog still agrees with
// the client's.
//
//   node tests/sound-auth.test.mjs     (or: npm test)
//
// The drift check at the bottom is the important one. The client's
// SOUND_LIBRARY carries labels and ordering; src/sound-catalog.js decides what
// costs money. Nothing but this test stops a sound being purchasable in one
// file and free in the other.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { SOUND_GROUPS, soundAllowed } = await import("../src/sound-catalog.js");

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}

const NOBODY = { all: false, identities: [] };
const OWNS_WUBG = { all: false, identities: ["WUBG"] };
const OWNS_ALL = { all: true, identities: [] };

console.log("\nuniversal sounds are free");
check("a guest may play combat damage", soundAllowed("combat_damage", NOBODY, "WUBG"));
check("a guest may play the eliminated sting", soundAllowed("eliminated", NOBODY, "C"));
check("entitlements of null don't throw", soundAllowed("attack", null, "WUBG") === true);

console.log("\npalette sounds need the palette");
check("guest refused a white sound", soundAllowed("w_wrath", NOBODY, "W") === false);
check("owner of WUBG may play white", soundAllowed("w_wrath", OWNS_WUBG, "WUBG"));
check("owner of WUBG may play green", soundAllowed("g_ramp", OWNS_WUBG, "WUBG"));
check("owner of WUBG refused red — not in the identity",
  soundAllowed("r_burn", OWNS_WUBG, "WUBG") === false);
check("enhance_all plays anything", soundAllowed("r_burn", OWNS_ALL, "R"));

console.log("\nowning a palette only helps while playing that deck");
// Bought WUBG, then switched to a mono-red commander. The board wouldn't offer
// red sounds either, so the server agreeing is what keeps the two consistent.
check("WUBG owner on a mono-red deck is refused red",
  soundAllowed("r_burn", OWNS_WUBG, "R") === false);
check("WUBG owner on a mono-white deck is refused white",
  soundAllowed("w_wrath", OWNS_WUBG, "W") === false);

console.log("\ncolorless");
check("colorless owner may play colorless", soundAllowed("c_equip", { all: false, identities: ["C"] }, "C"));
check("colorless owner refused a coloured sound",
  soundAllowed("w_wrath", { all: false, identities: ["C"] }, "C") === false);
check("a coloured deck can't reach colorless sounds without owning C",
  soundAllowed("c_equip", OWNS_WUBG, "WUBG") === false);

console.log("\nhostile input");
check("unknown sound id refused", soundAllowed("../../etc/passwd", OWNS_ALL, "WUBG") === false);
check("empty sound id refused", soundAllowed("", OWNS_ALL, "WUBG") === false);
check("undefined sound id refused", soundAllowed(undefined, OWNS_ALL, "WUBG") === false);
check("identities as a string, not an array, is refused not crashed",
  soundAllowed("w_wrath", { all: false, identities: "WUBG" }, "WUBG") === false);
check("a truthy non-true `all` does not unlock",
  soundAllowed("r_burn", { all: "yes", identities: [] }, "R") === false);
check("Scryfall-ordered identity does not match a canonical one",
  soundAllowed("w_wrath", OWNS_WUBG, "BGUW") === false);

console.log("\nserver catalog matches the client's SOUND_LIBRARY");
{
  // Parsed out of client.js rather than imported: it's a browser script, and
  // the point is to check the file that actually ships.
  const src = fs.readFileSync(path.join(here, "../public/client.js"), "utf8");
  const start = src.indexOf("const SOUND_LIBRARY = {");
  const end = src.indexOf("\n};", start);
  check("SOUND_LIBRARY found in client.js", start !== -1 && end !== -1);

  const block = src.slice(start, end);
  const clientGroups = {};
  let group = null;
  for (const line of block.split("\n")) {
    const header = line.match(/^\s{2}(universal|[WUBRGC]):\s*\[/);
    if (header) group = header[1];
    for (const [, id] of line.matchAll(/\["([a-z_]+)",/g)) clientGroups[id] = group;
  }

  const clientIds = Object.keys(clientGroups);
  const serverIds = Object.keys(SOUND_GROUPS);
  check("client has sounds to compare", clientIds.length > 30, String(clientIds.length));

  const missing = clientIds.filter((id) => !(id in SOUND_GROUPS));
  const extra = serverIds.filter((id) => !(id in clientGroups));
  const mismatched = clientIds.filter((id) => id in SOUND_GROUPS && SOUND_GROUPS[id] !== clientGroups[id]);

  check("every client sound is in the server catalog", missing.length === 0, missing.join(", "));
  check("no server sound is missing from the client", extra.length === 0, extra.join(", "));
  check("every sound is in the same group on both sides", mismatched.length === 0,
    mismatched.map((id) => `${id}: client=${clientGroups[id]} server=${SOUND_GROUPS[id]}`).join("; "));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
