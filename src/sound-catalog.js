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
//
// A group is a colour combination in canonical WUBRG order, or "universal" or
// "C". Groups used to be single letters only; guilds and shards were added so
// a two- or three-colour board has something that is specifically ITS, rather
// than its parent colours' lists merged. Four- and five-colour decks get every
// group their identity contains, which is plenty without authoring more.

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
  win_game: "universal",

  // White
  w_wrath: "W",
  w_lifegain: "W",
  w_exile: "W",
  w_tokens: "W",
  w_protect: "W",
  w_anthem: "W",
  w_tax: "W",
  w_lifelink: "W",
  w_disenchant: "W",

  // Blue
  u_counter: "U",
  u_draw: "U",
  u_scry: "U",
  u_bounce: "U",
  u_mill: "U",
  u_steal: "U",
  u_extra_turn: "U",
  u_copy: "U",
  u_tap: "U",

  // Black
  b_sacrifice: "B",
  b_destroy: "B",
  b_drain: "B",
  b_reanimate: "B",
  b_discard: "B",
  b_tutor: "B",
  b_paylife: "B",
  b_dies: "B",
  b_edict: "B",

  // Red
  r_burn: "R",
  r_impulse: "R",
  r_haste: "R",
  r_treasure: "R",
  r_goad: "R",
  r_extra_combat: "R",
  r_chaos: "R",
  r_double_damage: "R",
  r_landkill: "R",

  // Green
  g_ramp: "G",
  g_counters: "G",
  g_fight: "G",
  g_trample: "G",
  g_bigmana: "G",
  g_stampede: "G",
  g_draw_power: "G",
  g_regenerate: "G",
  g_fatty: "G",

  // Colourless and artifact. Only a colourless board may play these — an
  // artifact deck in colours uses its own colours' sounds.
  c_equip: "C",
  c_manarock: "C",
  c_eldrazi: "C",
  c_annihilator: "C",
  c_artifact_token: "C",
  c_graveyard_exile: "C",
  c_proliferate: "C",
  c_ultimate: "C",

  // Guilds — one apiece, so a two-colour board isn't just its two mono
  // lists side by side.
  wu_flicker: "WU",
  wb_afterlife: "WB",
  wr_boast: "WR",
  wg_populate: "WG",
  ub_surveil: "UB",
  ur_storm: "UR",
  ug_explore: "UG",
  br_aristocrat: "BR",
  bg_graveyard: "BG",
  rg_riot: "RG",

  // Shards and wedges, named for the keyword each one actually shipped
  // with in Alara and Khans — a word the table already knows.
  wub_artifice: "WUB",
  wur_prowess: "WUR",
  wug_exalted: "WUG",
  wbr_raid: "WBR",
  wbg_outlast: "WBG",
  wrg_behemoth: "WRG",
  ubr_unearth: "UBR",
  ubg_delve: "UBG",
  urg_ferocious: "URG",
  brg_devour: "BRG",
};

// A sound may be recorded several times over — combat_damage_1, _2, _3 — so the
// same event doesn't play an identical clip forty times in an evening. Which
// sounds get variants is a decision for whoever records them; nothing here
// requires any, and a sound with none is just its bare id.
//
// The cap is one digit because ten recordings of one event is not a thing
// anyone will do, and an unbounded suffix is an unbounded thing to validate.
export const MAX_VARIANTS = 9;
const VARIANT = /^(.*)_([1-9])$/;

// The id a variant belongs to, or the id itself. Everything that decides
// anything — what it costs, which palette it needs — asks this first, so a
// suffix can never be used to slip past a check that the base id wouldn't pass.
export function baseSoundId(id) {
  const raw = String(id || "");
  if (SOUND_GROUPS[raw]) return raw;
  const m = raw.match(VARIANT);
  return m && SOUND_GROUPS[m[1]] ? m[1] : raw;
}

// Does an identity contain every colour a group needs? Colourless is a state
// rather than a colour, so it matches only itself.
function covers(identity, group) {
  const id = String(identity || "");
  if (group === "C" || id === "C" || id === "") return group === "C" && (id === "C" || id === "");
  for (const c of group) if (!id.includes(c)) return false;
  return true;
}

// A board is the deck's whole identity plus the identity of each commander on
// its own. They differ only for a partner pair, and that difference is the
// point: someone playing a Gruul commander beside a Dimir one has a four-colour
// deck, and should have the Gruul set and the Dimir set — not nothing, which is
// what requiring them to own "UBRG" amounted to.
function boardIdentities(board) {
  if (typeof board === "string" || board == null) {
    const key = String(board || "") || "C";
    return { deck: key, parts: [key] };
  }
  const deck = String(board.identity || "") || "C";
  const parts = (board.commanders || [])
    .map((c) => String(c || ""))
    .filter((c, i, a) => c && a.indexOf(c) === i);
  return { deck, parts: parts.length ? parts : [deck] };
}

/**
 * May this player play this sound right now?
 *
 * @param soundId       as sent by the client
 * @param entitlements  {all, identities} — verified by the Worker at the
 *                      WebSocket handshake, never taken from the client
 * @param board         the identity string of the deck being played, or
 *                      {identity, commanders:[...]} when it has two commanders
 *
 * Unknown ids are refused rather than waved through: a sound this file has
 * never heard of is either a typo or someone probing, and neither should make
 * noise on three other people's phones.
 */
export function soundAllowed(soundId, entitlements, board) {
  // A variant costs what its base costs. Resolving here rather than at the
  // call sites means there is one place to get this wrong instead of several.
  const group = SOUND_GROUPS[baseSoundId(soundId)];
  if (!group) return false;
  if (group === "universal") return true;

  const { deck, parts } = boardIdentities(board);
  // Even a player who owns everything can't use a sound their deck has no
  // business making — a mono-red deck has no Simic sounds to play.
  if (!covers(deck, group)) return false;

  const ent = entitlements || {};
  if (ent.all === true) return true;

  // Owning a palette only helps while you're actually playing that deck, and
  // the deck you own has to be one of THIS deck's own identities. Without that
  // second half, five mono slots would quietly unlock every colour in every
  // deck and the palettes would stop being worth buying.
  const owned = Array.isArray(ent.identities) ? ent.identities : [];
  return parts.some((p) => owned.includes(p) && covers(p, group));
}
