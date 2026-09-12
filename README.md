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

## The 4 sounds and their routing

| Button | Who can press it | Whose device plays it |
|---|---|---|
| Board Wipe | anyone | host only |
| Ambient | anyone (toggles their own) | host only |
| Deal Damage | anyone, targets another player | the targeted player only |
| Taunt | anyone, 8s per-player cooldown | the presser only |

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
