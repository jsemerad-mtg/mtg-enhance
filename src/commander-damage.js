// Commander damage, bucketed per commander CARD rather than per opposing
// player.
//
// The format's rule is 21 from any ONE commander, and a deck may have two
// (Partner, Partner with, Friends forever, Choose a Background, Doctor's
// companion). Bucketing by player was right while every deck had exactly one
// commander and quietly wrong the moment one didn't: two partners hitting you
// for 11 each is 22 across two separate clocks, and a per-player bucket would
// announce that as lethal.
//
// Pure, and in its own file, because the cost of getting it wrong is the app
// telling someone they lost a game they hadn't.

export const COMMANDER_DAMAGE_LETHAL = 21;

// Slot 0 is the first commander, slot 1 the partner. Anything else is slot 0,
// so a client that predates partners — or a malformed message — lands in the
// bucket it always used rather than inventing a new one.
export function damageKey(sourceId, slot) {
  return `${sourceId}:${slot === 1 || slot === "1" ? 1 : 0}`;
}

// The worst single clock. Max over the buckets, which is what makes 11 + 11
// from a partner pair read as 11 and not 22.
export function worstDamage(commanderDamage) {
  const values = Object.values(commanderDamage || {}).filter((n) => typeof n === "number");
  return values.length ? Math.max(0, ...values) : 0;
}

// What one opposing player has dealt in total, across both their commanders.
// Not a loss condition — it is what the stepper shows beside their name.
export function damageFrom(commanderDamage, sourceId, slot) {
  if (slot === undefined) {
    return (commanderDamage?.[damageKey(sourceId, 0)] ?? 0)
         + (commanderDamage?.[damageKey(sourceId, 1)] ?? 0);
  }
  return commanderDamage?.[damageKey(sourceId, slot)] ?? 0;
}

// Sessions survive a deploy, so a game already in progress still holds the old
// shapes: commanderDamage keyed by bare player id, commanderCasts a single
// number. Converting once on load beats teaching every reader both shapes.
export function migrateSeat(player) {
  if (!player) return player;
  const dmg = player.commanderDamage;
  if (dmg && typeof dmg === "object" && Object.keys(dmg).some((k) => !k.includes(":"))) {
    const moved = {};
    // Old damage belonged to whichever commander that player had, which was
    // their only one — slot 0.
    for (const [k, v] of Object.entries(dmg)) moved[k.includes(":") ? k : damageKey(k, 0)] = v;
    player.commanderDamage = moved;
  }
  if (typeof player.commanderCasts === "number") {
    player.commanderCasts = { 0: player.commanderCasts, 1: 0 };
  }
  return player;
}

// Twice the number of times THAT commander has been cast — each one is taxed
// on its own history, not on its partner's.
export function commanderTax(player, slot = 0) {
  const casts = player?.commanderCasts;
  const n = typeof casts === "number" ? (slot === 0 ? casts : 0) : (casts?.[slot] ?? 0);
  return n * 2;
}
