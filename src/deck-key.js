// The string a deck is known by: in the records list, in game history, on the
// chips at the table. One helper, because the moment two places disagree about
// how a deck is named, a player's record silently splits in two.
//
// Why " + " and not " // "
// -----------------------
// A double-faced card's name already contains " // " — 141 of them are legal
// commanders, "Nicol Bolas, the Ravager // Nicol Bolas, the Arisen" among
// them. Using it for a partner pair would make a single card indistinguishable
// from two cards, so the pair separator is " + ", which appears in no card name
// at all. Parentheses don't either, which is what makes the label suffix safe
// to read back.
//
// The property that matters most: a deck with one commander and no label
// returns EXACTLY the commander's name, byte for byte. Every game already in
// game_history was written that way, so those rows keep matching.

export const PAIR = " + ";
export const NAME_MAX = 80;
export const LABEL_MAX = 24;
// 80 + " + " + 80 + " (" + 24 + ")" = 190. The seat field and every column that
// stores a key allow 200, so a key can never be the thing that truncates.
export const KEY_MAX = 200;

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// Alphabetical, so "Tymna and Thrasios" and "Thrasios and Tymna" are one deck
// rather than two. Compared lowercased on code points rather than with
// localeCompare, which is locale-dependent — the Worker and the browser must
// agree, and they do not always share a locale.
export function orderPair(a, b) {
  const x = clean(a).slice(0, NAME_MAX);
  const y = clean(b).slice(0, NAME_MAX);
  if (!x) return [y, ""];
  if (!y) return [x, ""];
  if (x.toLowerCase() === y.toLowerCase()) return [x, ""]; // the same card twice is one card
  return x.toLowerCase() < y.toLowerCase() ? [x, y] : [y, x];
}

export function deckKey(commander, commander2 = "", label = "") {
  const [first, second] = orderPair(commander, commander2);
  if (!first) return "";
  const names = second ? first + PAIR + second : first;
  const tag = clean(label).slice(0, LABEL_MAX);
  return tag ? `${names} (${tag})` : names;
}

// The inverse, for reading a stored key back apart. Only the label is taken
// from the end, and only when the parentheses close the string — a card name
// has none, so there is nothing to confuse it with.
export function parseDeckKey(key) {
  let rest = clean(key);
  let label = "";
  const m = rest.match(/^(.*\S)\s\(([^()]*)\)$/);
  if (m) { rest = m[1]; label = m[2]; }
  const at = rest.indexOf(PAIR);
  // indexOf, not split: a pair of double-faced cards contains " // " four
  // times and " + " exactly once, and only the first " + " separates them.
  return at === -1
    ? { commander: rest, commander2: "", label }
    : { commander: rest.slice(0, at), commander2: rest.slice(at + PAIR.length), label };
}

// True when these two cards are a legal pairing as far as we can tell from the
// card text. Deliberately permissive: it drives a note, never a refusal. The
// rules keep gaining new ways to run two commanders (Partner, Partner with,
// Friends forever, Choose a Background, Doctor's companion) and a validator
// that blocks a real deck is worse than one that stays quiet.
export function pairingNote(textA, textB) {
  const kind = (t) => {
    const s = String(t || "").toLowerCase();
    if (/\bpartner with\b/.test(s)) return "partner-with";
    if (/\bfriends forever\b/.test(s)) return "friends";
    if (/\bdoctor's companion\b/.test(s)) return "doctor";
    if (/\bchoose a background\b/.test(s)) return "chooser";
    if (/\bbackground\b/.test(s) && /enchantment/.test(s)) return "background";
    if (/\bpartner\b/.test(s)) return "partner";
    return "";
  };
  const a = kind(textA);
  const b = kind(textB);
  if (!a || !b) return "One of these doesn't look like it can have a partner — worth a check.";
  if (a === "chooser" && b === "background") return "";
  if (a === "background" && b === "chooser") return "";
  if (a === b && a !== "background" && a !== "chooser") return "";
  if (a === "partner-with" || b === "partner-with") return "";
  return "These two don't look like a legal pairing — worth a check.";
}
