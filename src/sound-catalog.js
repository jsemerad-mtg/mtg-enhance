// ─── Which palette each sound belongs to, and who may play it ────────────────
//
// The client has its own SOUND_LIBRARY with labels and ordering — that's a UI
// concern. This file is the *authority*, and it exists because the soundboard
// hiding a locked palette is not the same as the server refusing to play it.
// A locked button the client never renders is still a `trigger_library_sound`
// message anyone can send down an open WebSocket.
//
// The two lists have to agree, so `npm test` compares them and fails on drift
// rather than leaving a sound that's purchasable in one place and free in the
// other.

export const SOUND_GROUPS = {
  // Universal — the table events. Free for everyone, signed in or not.
  combat_damage: "universal",
  commander_damage: "universal",
  attack: "universal",
  block: "universal",
  land_drop: "universal",
  counter_stack: "universal",
  shuffle: "universal",
  eliminated: "universal",

  w_wrath: "W", w_lifegain: "W", w_exile: "W",
  w_tokens: "W", w_protect: "W", w_anthem: "W",

  u_counter: "U", u_draw: "U", u_scry: "U",
  u_bounce: "U", u_mill: "U", u_steal: "U", u_extra_turn: "U",

  b_sacrifice: "B", b_destroy: "B", b_drain: "B",
  b_reanimate: "B", b_discard: "B", b_tutor: "B", b_surveil: "B",

  r_burn: "R", r_impulse: "R", r_haste: "R",
  r_treasure: "R", r_goad: "R", r_extra_combat: "R",

  g_ramp: "G", g_counters: "G", g_fight: "G",
  g_trample: "G", g_bigmana: "G", g_stampede: "G",

  c_equip: "C", c_manarock: "C", c_eldrazi: "C",
  c_annihilator: "C", c_artifact_token: "C",
};

/**
 * May this player play this sound right now?
 *
 * @param soundId        as sent by the client
 * @param entitlements   {all, identities} — verified by the Worker at the
 *                       WebSocket handshake, never taken from the client
 * @param identityKey    the player's CURRENT commander identity, canonical
 *                       WUBRG order, "C" for colorless
 *
 * Unknown ids are refused rather than waved through: a sound this file has
 * never heard of is either a typo or someone probing, and neither should make
 * noise on three other people's phones.
 */
export function soundAllowed(soundId, entitlements, identityKey) {
  const group = SOUND_GROUPS[soundId];
  if (!group) return false;
  if (group === "universal") return true;

  const ent = entitlements || {};
  if (ent.all === true) return true;

  // Owning a palette only helps while you're actually playing that deck —
  // which is the same rule the board renders by, so the UI and the server
  // can't disagree about what's playable.
  const owned = Array.isArray(ent.identities) ? ent.identities : [];
  if (!owned.includes(identityKey)) return false;
  return identityKey === "C" ? group === "C" : identityKey.includes(group);
}
