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
const owns = (...ids) => ({ all: false, identities: ids });

console.log("\nuniversal sounds are free");
check("a guest may play combat damage", soundAllowed("combat_damage", NOBODY, "WUBG"));
check("a guest may play the eliminated sting", soundAllowed("eliminated", NOBODY, "C"));
check("and the win sting", soundAllowed("win_game", NOBODY, "R"));
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
// The rule that keeps the palettes worth buying: five cheap mono slots must not
// add up to every colour in every deck.
check("owning mono-U alone does not unlock blue in a Simic deck",
  soundAllowed("u_counter", owns("U"), "UG") === false);
check("owning the Simic palette does",
  soundAllowed("u_counter", owns("UG"), "UG") === true);

console.log("\nguilds and shards");
check("a Simic deck with the Simic palette gets the Simic sound",
  soundAllowed("ug_explore", owns("UG"), "UG"));
check("a Simic deck cannot reach a Grixis sound at all",
  soundAllowed("ubr_unearth", owns("UG"), "UG") === false);
check("even owning everything", soundAllowed("ubr_unearth", OWNS_ALL, "UG") === false);
check("a Grixis deck gets its shard sound", soundAllowed("ubr_unearth", owns("UBR"), "UBR"));
// A shard palette contains the guilds inside it, because those colours are all
// in the deck and all in the thing that was bought.
check("and the guild sounds inside it", soundAllowed("ub_surveil", owns("UBR"), "UBR"));
check("and the mono sounds inside it", soundAllowed("b_drain", owns("UBR"), "UBR"));
check("a mono-red deck has no guild sound to play",
  soundAllowed("rg_riot", owns("R"), "R") === false);

console.log("\ntwo commanders, two palettes");
// The case this rule exists for: a Gruul commander beside a Dimir one. The deck
// is four colours, and requiring its owner to have bought "UBRG" for it gave
// them nothing at all.
const partners = { identity: "UBRG", commanders: ["RG", "UB"] };
check("the Gruul half plays its own sound", soundAllowed("rg_riot", owns("RG"), partners));
check("and its colours", soundAllowed("g_ramp", owns("RG"), partners));
check("the Dimir half plays its own", soundAllowed("ub_surveil", owns("UB"), partners));
check("owning both halves covers both",
  soundAllowed("rg_riot", owns("RG", "UB"), partners)
    && soundAllowed("ub_surveil", owns("RG", "UB"), partners));
// What owning half does NOT buy.
check("the Gruul half alone does not unlock Dimir",
  soundAllowed("ub_surveil", owns("RG"), partners) === false);
check("nor blue", soundAllowed("u_counter", owns("RG"), partners) === false);
// Nothing spans the two commanders: a shard sitting inside the deck's union is
// still not a palette anybody bought.
check("nor a shard that merely fits inside the union",
  soundAllowed("ubr_unearth", owns("RG", "UB"), partners) === false);
// And owning that shard outright does not help either, which is the boundary
// worth being deliberate about. A palette belongs to a DECK — one of its
// commanders' identities — not to any subset of colours the deck happens to
// contain. The looser rule would mean one Simic purchase worked in every deck
// with blue and green in it, and the palettes would stop being worth buying.
check("owning a shard no commander is doesn't reach into this deck",
  soundAllowed("ubr_unearth", owns("UBR"), partners) === false);
check("the same purchase still works in an actual Grixis deck",
  soundAllowed("ubr_unearth", owns("UBR"), "UBR") === true);
// A four-colour SINGLE commander is one deck and one palette, as before.
const breya = { identity: "WUBR", commanders: ["WUBR"] };
check("a four-colour commander needs its own palette",
  soundAllowed("ub_surveil", owns("UB"), breya) === false);
check("and gets everything inside it when owned",
  soundAllowed("ub_surveil", owns("WUBR"), breya) === true);
check("a board with no commander identities falls back to the deck's",
  soundAllowed("u_counter", owns("UG"), { identity: "UG", commanders: [] }) === true);
check("and a bare string still works, as it always did",
  soundAllowed("u_counter", owns("UG"), "UG") === true);

console.log("\ncolorless");
check("colorless owner may play colorless", soundAllowed("c_equip", owns("C"), "C"));
check("colorless owner refused a coloured sound",
  soundAllowed("w_wrath", owns("C"), "C") === false);
check("a coloured deck can't reach colorless sounds without owning C",
  soundAllowed("c_equip", OWNS_WUBG, "WUBG") === false);
check("nor with it — colorless is a state, not a colour",
  soundAllowed("c_equip", owns("C", "WUBG"), "WUBG") === false);

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
// commanderIdentities arrives over the socket, so it must not be able to buy
// anything on its own.
check("claiming a commander identity you don't own buys nothing",
  soundAllowed("rg_riot", NOBODY, { identity: "UBRG", commanders: ["RG"] }) === false);
check("nor one outside the deck's own colours",
  soundAllowed("w_wrath", owns("W"), { identity: "UG", commanders: ["W", "UG"] }) === false);
check("a commanders list of junk doesn't throw",
  soundAllowed("u_counter", owns("UG"), { identity: "UG", commanders: [null, 7, {}] }) === false);

console.log("\nthe catalog covers every combination it claims to");
{
  const groups = new Set(Object.values(SOUND_GROUPS));
  const GUILDS = ["WU", "WB", "WR", "WG", "UB", "UR", "UG", "BR", "BG", "RG"];
  const SHARDS = ["WUB", "WUR", "WUG", "WBR", "WBG", "WRG", "UBR", "UBG", "URG", "BRG"];
  check("all five mono colours", ["W", "U", "B", "R", "G"].every((c) => groups.has(c)));
  check("all ten guilds", GUILDS.every((g) => groups.has(g)),
    GUILDS.filter((g) => !groups.has(g)).join(", "));
  check("all ten shards and wedges", SHARDS.every((g) => groups.has(g)),
    SHARDS.filter((g) => !groups.has(g)).join(", "));
  // Written in canonical WUBRG order, or an identity computed one way would
  // never match a group written the other.
  const WUBRG = "WUBRG";
  const canonical = (k) => WUBRG.split("").filter((c) => k.includes(c)).join("");
  const wrong = [...groups].filter((g) => g !== "universal" && g !== "C" && canonical(g) !== g);
  check("every group key is in canonical order", wrong.length === 0, wrong.join(", "));
}

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
    // Group keys are combinations now, not single letters.
    const header = line.match(/^\s{2}(universal|[WUBRGC]{1,5}):\s*\[/);
    if (header) group = header[1];
    for (const [, id] of line.matchAll(/\["([a-z_0-9]+)",/g)) clientGroups[id] = group;
  }

  const clientIds = Object.keys(clientGroups);
  const serverIds = Object.keys(SOUND_GROUPS);
  check("client has sounds to compare", clientIds.length > 60, String(clientIds.length));

  const missing = clientIds.filter((id) => !(id in SOUND_GROUPS));
  const extra = serverIds.filter((id) => !(id in clientGroups));
  const mismatched = clientIds.filter((id) => id in SOUND_GROUPS && SOUND_GROUPS[id] !== clientGroups[id]);

  check("every client sound is in the server catalog", missing.length === 0, missing.join(", "));
  check("no server sound is missing from the client", extra.length === 0, extra.join(", "));
  check("every sound is in the same group on both sides", mismatched.length === 0,
    mismatched.map((id) => `${id}: client=${clientGroups[id]} server=${SOUND_GROUPS[id]}`).join("; "));
  check("and the two agree on how many there are",
    clientIds.length === serverIds.length, `${clientIds.length} vs ${serverIds.length}`);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
