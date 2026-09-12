# MTG Enhance — Proof of Concept

Colocated-only slice of MTG Enhance: host a session, join via a 4-character
code, sync life totals, and trigger 4 sounds with the routing rules the
architecture calls for.

## What's here

- `src/index.js` — Worker entry: allocates join codes, routes WebSocket
  upgrades to the right session, serves the static client.
- `src/game-session.js` — the `GameSession` Durable Object. One instance
  per join code (`idFromName(code)`), holding players, life totals, and
  cooldowns in SQLite-backed storage so it survives hibernation.
- `public/` — the client: home (host/join) → lobby (name, commander,
  colors) → game (life totals + soundboard). Sounds are synthesized with
  the Web Audio API for now — no audio files yet, matching how the earlier
  MTG Enhance skeleton used placeholder tones.

## The soundboard and the Deal Damage panel

A single row of four icon buttons:

| Icon | Sound | Who can press it | Whose device plays it |
|---|---|---|---|
| Mushroom cloud | Board Wipe | anyone | host only — 60s **session-wide** cooldown (shared by everyone, not per-player) |
| Music notes | Ambient (toggle) | anyone (toggles their own) | host only |
| Laughing face | Taunt | anyone | presser only — 8s **per-player** cooldown |
| Card outline | Draw Card | anyone | presser only — no cooldown |

Below that, the Deal Damage panel is three columns plus an Apply button,
rather than one button per action:

1. **Target** — All players, Each opponent, Me, or one specific named
   opponent (the list is generated from whoever's actually in the session).
2. **Kind** — Gains Life, Loses Life, or Takes Damage. All three just change
   the sign of the life total, but each plays a different sound — mirroring
   the real rules distinction between losing life and taking damage.
3. **Amount** — a scroll-snapping number wheel, 0–20, defaulting to 1.

Pressing Apply sends one event that updates every affected life total and
plays the matching sound on each of their devices — e.g. "each opponent
loses 1" hits every opponent's total and their device in a single press,
instead of each player manually adjusting their own.

This matches the colocated-mode rule: ambient/broadcast sounds would echo
across phones sitting near each other, so only the host's device (the one
presumably closest to a speaker, or connected to one) plays those. Targeted
and self sounds are unaffected by mode, since only one device ever plays
them.

## Run it locally

```bash
npm install
npm run dev
```

Wrangler will print a local URL. Open it in two or more browser
tabs/devices on the same network to simulate multiple players — host in
one tab, join with the printed code in the others.

## Deploy

```bash
npm run deploy
```

This is a single Worker with one Durable Object class and static assets —
no D1, R2, or accounts yet, so there's nothing else to provision.

## Known simplifications (proof-of-concept scope)

- **No turn order / real ambient trigger.** Ambient is a manual per-player
  toggle rather than tied to whose turn it is. Fine for validating "commander
  color drives soundscape," not a real turn loop yet.
- **Join codes never expire or get reused.** A finished game's code stays
  "claimed" by its Durable Object forever. Not a practical problem at 4
  characters (1M+ combinations), but worth knowing.
- **No reconnect UI.** If a WebSocket drops, reloading the page with the
  same join code silently rejoins using the playerId stored in
  `localStorage` — there's no visible "reconnecting…" state.
- **Manual commander/color entry**, not the MTG Oracle card-data
  autocomplete — that's a fast-follow once this loop is validated.
- **No remote mode, accounts, or D1** — all explicitly deferred per the
  scope you set for this PoC.
