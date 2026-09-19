// The one string a deck is known by. If two places disagree about how a deck is
// named, a player's record quietly splits in half, so these are the rules.

import { deckKey, parseDeckKey, orderPair, pairingNote, PAIR } from "../src/deck-key.js";

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}

console.log("\nthe deck everyone already has");
{
  // The property the whole design rests on: every row already in game_history
  // was written as a bare commander name, and must keep matching.
  check("one commander, no label, is exactly its own name",
    deckKey("Krenko, Mob Boss") === "Krenko, Mob Boss", deckKey("Krenko, Mob Boss"));
  check("with nothing appended for an absent partner",
    deckKey("Krenko, Mob Boss", "") === "Krenko, Mob Boss");
  check("or an absent label",
    deckKey("Krenko, Mob Boss", "", "") === "Krenko, Mob Boss");
  check("and whitespace does not make a new deck",
    deckKey("  Krenko,   Mob Boss ") === "Krenko, Mob Boss", deckKey("  Krenko,   Mob Boss "));
}

console.log("\na pair is one deck however it was typed");
{
  const a = deckKey("Thrasios, Triton Hero", "Tymna the Weaver");
  const b = deckKey("Tymna the Weaver", "Thrasios, Triton Hero");
  check("order doesn't matter", a === b, `${a} vs ${b}`);
  check("and the pair reads alphabetically",
    a === "Thrasios, Triton Hero + Tymna the Weaver", a);
  check("the same card twice is one commander",
    deckKey("Tymna the Weaver", "tymna the weaver") === "Tymna the Weaver",
    deckKey("Tymna the Weaver", "tymna the weaver"));
}

console.log("\nthe separator, and why it isn't //");
{
  // 141 legal commanders are double-faced cards whose own name contains " // ".
  // Had the pair separator been " // ", one card would have been
  // indistinguishable from two, and this is the test that says so.
  const dfc = "Nicol Bolas, the Ravager // Nicol Bolas, the Arisen";
  check("a double-faced card is one commander", deckKey(dfc) === dfc, deckKey(dfc));
  const back = parseDeckKey(deckKey(dfc));
  check("and survives the round trip whole", back.commander === dfc, back.commander);
  check("with no second commander invented", back.commander2 === "", back.commander2);

  // The worst case: two double-faced cards partnered. Four " // " and one " + ".
  const pair = deckKey(dfc, "Aang, at the Crossroads // Aang, Destined Savior");
  const split = parseDeckKey(pair);
  check("two double-faced cards still split in the right place",
    split.commander2 === dfc || split.commander === dfc, JSON.stringify(split));
  check("into exactly two names",
    split.commander.includes(PAIR) === false && split.commander2.includes(PAIR) === false,
    JSON.stringify(split));
}

console.log("\nlabels, for the second deck with the same commander");
{
  check("a label is appended in brackets",
    deckKey("Ezuri, Claw of Progress", "", "Snakes") === "Ezuri, Claw of Progress (Snakes)",
    deckKey("Ezuri, Claw of Progress", "", "Snakes"));
  check("two labelled decks are different decks",
    deckKey("Ezuri, Claw of Progress", "", "Snakes")
      !== deckKey("Ezuri, Claw of Progress", "", "Counters"));
  check("and an unlabelled one is a third",
    deckKey("Ezuri, Claw of Progress") !== deckKey("Ezuri, Claw of Progress", "", "Snakes"));
  const r = parseDeckKey("Ezuri, Claw of Progress (Snakes)");
  check("the label comes back off", r.label === "Snakes" && r.commander === "Ezuri, Claw of Progress",
    JSON.stringify(r));
  const p = parseDeckKey("Thrasios, Triton Hero + Tymna the Weaver (cEDH)");
  check("alongside a pair", p.commander2 === "Tymna the Weaver" && p.label === "cEDH",
    JSON.stringify(p));
}

console.log("\nnothing in, nothing out");
{
  check("no commander is no key", deckKey("") === "", deckKey(""));
  check("a label alone is still no key", deckKey("", "", "Snakes") === "");
  check("a second commander with no first is promoted",
    deckKey("", "Tymna the Weaver") === "Tymna the Weaver", deckKey("", "Tymna the Weaver"));
  check("null and undefined are not the string 'null'",
    deckKey(null, undefined) === "", JSON.stringify(deckKey(null, undefined)));
}

console.log("\nlengths that can't blow past a column");
{
  const long = "x".repeat(300);
  check("a name is capped", deckKey(long).length === 80, String(deckKey(long).length));
  check("a label too", deckKey("A", "", long).length === 1 + 2 + 24 + 1,
    String(deckKey("A", "", long).length));
  // 80 + 3 + 80 + 2 + 24 + 1 = 190, comfortably inside the 200 the key column
  // and the seat field allow.
  check("and a full pair with a label stays under 200",
    deckKey(long, long + "y", long).length < 200, String(deckKey(long, long + "y", long).length));
}

console.log("\nordering on its own");
{
  check("orderPair drops an empty second", orderPair("A", "  ").join("|") === "A|");
  check("and sorts case-insensitively", orderPair("banana", "Apple").join("|") === "Apple|banana",
    orderPair("banana", "Apple").join("|"));
}

console.log("\nthe pairing note is advice, never a refusal");
{
  check("two Partner cards are fine",
    pairingNote("Partner (You can have two commanders if both have partner.)",
                "Partner (You can have two commanders if both have partner.)") === "");
  check("a Background chooser and a Background are fine",
    pairingNote("Choose a Background", "Legendary Enchantment — Background") === "");
  check("Partner with is always fine",
    pairingNote("Partner with Pir, Imaginative Rascal", "Partner with Toothy, Imaginary Friend") === "");
  check("two ordinary commanders get a note",
    pairingNote("Flying, vigilance", "Trample") !== "");
  // The note must never be phrased as a verdict: the rules keep adding ways to
  // run two commanders and this code will be out of date before the app is.
  check("and the note only says it's worth a check",
    /worth a check/.test(pairingNote("Flying", "Trample")), pairingNote("Flying", "Trample"));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
