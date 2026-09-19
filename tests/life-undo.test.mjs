// Who may undo a life change, and for how long. These are the rules that keep
// "undo" from becoming "edit anyone's life total whenever you like".

import { rememberLifeChange, undoDecision, UNDO_WINDOW_MS } from "../src/life-undo.js";

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}

const T = 1_000_000;

console.log("\nthe ordinary case");
{
  const map = new Map();
  const id = rememberLifeChange(map, "sam", -3, T);
  const v = undoDecision(map, id, "sam", T + 1000);
  check("the player whose number moved may put it back", v.ok === true, JSON.stringify(v));
  check("and gets the delta to reverse", v.entry.delta === -3, String(v.entry?.delta));
}

console.log("\nwho may not");
{
  const map = new Map();
  const id = rememberLifeChange(map, "sam", -3, T);
  // Without this, any seat could reach into any other player's life total
  // through an id it happened to see.
  const v = undoDecision(map, id, "ali", T + 1000);
  check("someone else's change is refused", v.ok === false && v.reason === "not-yours",
    JSON.stringify(v));
}
{
  const map = new Map();
  const v = undoDecision(map, "made-up-id", "sam", T);
  check("an id that never existed is refused", v.ok === false && v.reason === "unknown",
    JSON.stringify(v));
}
{
  const map = new Map();
  const v = undoDecision(map, undefined, "sam", T);
  check("and so is no id at all", v.ok === false && v.reason === "unknown", JSON.stringify(v));
}
{
  const map = new Map();
  const id = rememberLifeChange(map, "sam", -3, T);
  map.delete(id); // what the Durable Object does the moment it honours one
  const v = undoDecision(map, id, "sam", T + 500);
  // Single use is what stops a replayed message draining a life total in a
  // loop: three taps on Undo must not be +9.
  check("a spent undo cannot be spent again", v.ok === false && v.reason === "unknown",
    JSON.stringify(v));
}

console.log("\nthe window");
{
  const map = new Map();
  const id = rememberLifeChange(map, "sam", -3, T);
  check("inside the window it holds",
    undoDecision(map, id, "sam", T + UNDO_WINDOW_MS - 1).ok === true);
  check("a moment past it, it doesn't",
    undoDecision(map, id, "sam", T + UNDO_WINDOW_MS + 1).reason === "expired");
}
{
  // The clock is the server's. A client claiming an old change is recent gets
  // nowhere, because it never supplies the time.
  const map = new Map();
  const id = rememberLifeChange(map, "sam", -3, T);
  const v = undoDecision(map, id, "sam", T + 60_000);
  check("an hour later is still expired", v.reason === "expired", JSON.stringify(v));
}

console.log("\nthe map stays small");
{
  const map = new Map();
  for (let i = 0; i < 50; i++) rememberLifeChange(map, "sam", -1, T + i);
  check("fifty live entries are all kept", map.size === 50, String(map.size));
  rememberLifeChange(map, "sam", -1, T + UNDO_WINDOW_MS + 100);
  // Pruned on write rather than by a timer: nothing here is worth a timer.
  check("and are swept once they age out", map.size === 1, String(map.size));
}
{
  const map = new Map();
  const a = rememberLifeChange(map, "sam", -3, T);
  const b = rememberLifeChange(map, "ali", -3, T);
  check("two players hit by one effect get separate entries", a !== b);
  check("and each can only undo their own",
    undoDecision(map, a, "sam", T).ok && undoDecision(map, b, "ali", T).ok
    && !undoDecision(map, a, "ali", T).ok, "");
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
