// 21 is per commander, and a deck may have two. These are the rules that keep
// the app from telling someone they lost a game they hadn't.

import { damageKey, worstDamage, damageFrom, migrateSeat, commanderTax,
         COMMANDER_DAMAGE_LETHAL } from "../src/commander-damage.js";

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}

console.log("\nthe bug this exists to prevent");
{
  // Two partners, eleven each. Twenty-two total, and not lethal: the rule is
  // 21 from ONE commander. A bucket per player would have called this a loss.
  const dmg = { [damageKey("sam", 0)]: 11, [damageKey("sam", 1)]: 11 };
  check("two partners at 11 each is not lethal",
    worstDamage(dmg) < COMMANDER_DAMAGE_LETHAL, String(worstDamage(dmg)));
  check("the worst single clock is 11", worstDamage(dmg) === 11, String(worstDamage(dmg)));
  check("though the player has dealt 22 in total",
    damageFrom(dmg, "sam") === 22, String(damageFrom(dmg, "sam")));
}
{
  const dmg = { [damageKey("sam", 0)]: 21, [damageKey("sam", 1)]: 0 };
  check("one partner reaching 21 IS lethal",
    worstDamage(dmg) >= COMMANDER_DAMAGE_LETHAL, String(worstDamage(dmg)));
}
{
  // The other half of the same rule: damage from two DIFFERENT players never
  // added up either, and still doesn't.
  const dmg = { [damageKey("sam", 0)]: 14, [damageKey("ali", 0)]: 14 };
  check("two opponents at 14 each is not lethal",
    worstDamage(dmg) < COMMANDER_DAMAGE_LETHAL, String(worstDamage(dmg)));
}

console.log("\nthe bucket key");
{
  check("slot 0 and slot 1 are different buckets",
    damageKey("sam", 0) !== damageKey("sam", 1));
  check("two players are different buckets",
    damageKey("sam", 0) !== damageKey("ali", 0));
  // A client that predates partners sends no slot at all. It must land where
  // it always did rather than opening a third bucket.
  check("no slot means the first commander",
    damageKey("sam") === damageKey("sam", 0), damageKey("sam"));
  check("and so does anything unexpected",
    damageKey("sam", 7) === damageKey("sam", 0) && damageKey("sam", null) === damageKey("sam", 0));
  check("a stringy 1 still means the partner",
    damageKey("sam", "1") === damageKey("sam", 1));
}

console.log("\nreading one opponent's damage");
{
  const dmg = { [damageKey("sam", 0)]: 7, [damageKey("sam", 1)]: 5, [damageKey("ali", 0)]: 3 };
  check("a named slot reads that slot", damageFrom(dmg, "sam", 1) === 5, String(damageFrom(dmg, "sam", 1)));
  check("no slot sums the pair", damageFrom(dmg, "sam") === 12, String(damageFrom(dmg, "sam")));
  check("someone who hasn't hit you is zero, not undefined",
    damageFrom(dmg, "ros") === 0, JSON.stringify(damageFrom(dmg, "ros")));
  check("and an empty map is zero", worstDamage({}) === 0 && worstDamage(null) === 0);
}

console.log("\na game that was already running when this shipped");
{
  // Sessions persist across a deploy. This seat was written by the old code.
  const old = { commanderDamage: { sam: 13, ali: 4 }, commanderCasts: 3 };
  migrateSeat(old);
  check("old damage moves to the first commander's bucket",
    old.commanderDamage[damageKey("sam", 0)] === 13, JSON.stringify(old.commanderDamage));
  check("for every opponent", old.commanderDamage[damageKey("ali", 0)] === 4);
  check("and nothing is lost on the way", worstDamage(old.commanderDamage) === 13,
    String(worstDamage(old.commanderDamage)));
  check("the old bare keys are gone",
    Object.keys(old.commanderDamage).every((k) => k.includes(":")),
    JSON.stringify(Object.keys(old.commanderDamage)));
  check("a single cast count becomes the first commander's",
    old.commanderCasts[0] === 3 && old.commanderCasts[1] === 0, JSON.stringify(old.commanderCasts));
}
{
  // Idempotent: normalise runs on every load, not only the first.
  const seat = { commanderDamage: { [damageKey("sam", 1)]: 9 }, commanderCasts: { 0: 1, 1: 2 } };
  const before = JSON.stringify(seat);
  migrateSeat(seat);
  check("a seat already migrated is left alone", JSON.stringify(seat) === before, JSON.stringify(seat));
}
{
  const empty = { commanderDamage: {}, commanderCasts: 0 };
  migrateSeat(empty);
  check("an untouched seat migrates without inventing damage",
    Object.keys(empty.commanderDamage).length === 0);
  check("and its casts still become a pair", empty.commanderCasts[0] === 0);
  check("migrating nothing doesn't throw", migrateSeat(null) === null);
}

console.log("\ncommander tax");
{
  const seat = { commanderCasts: { 0: 2, 1: 0 } };
  check("twice the casts of that commander", commanderTax(seat, 0) === 4, String(commanderTax(seat, 0)));
  // The partner has its own history: casting one does not tax the other.
  check("and the partner is taxed on its own", commanderTax(seat, 1) === 0, String(commanderTax(seat, 1)));
  check("slot defaults to the first", commanderTax(seat) === 4, String(commanderTax(seat)));
  check("an old numeric count still reads",
    commanderTax({ commanderCasts: 3 }) === 6, String(commanderTax({ commanderCasts: 3 })));
  check("and an absent one is free", commanderTax({}) === 0 && commanderTax(null) === 0);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
