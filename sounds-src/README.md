# Source audio

Drop raw recordings in here, named by sound id, then run:

    npm run build:sounds

Any format ffmpeg reads works — .wav, .aiff, .flac. Do NOT normalize or
trim them yourself; the script measures and corrects loudness, and
pre-normalized input just gets corrected twice.

A filename that is not one of the ids below fails the build rather than
being quietly transcoded into a file nothing plays.

Audition the result at /sounds.html.

## Universal (free for everyone)

- `combat_damage` — Combat Damage
- `commander_damage` — Commander Damage
- `attack` — Attack!
- `block` — Blockers
- `land_drop` — Land Drop
- `counter_stack` — In Response
- `shuffle` — Shuffle
- `eliminated` — Eliminated

## White

- `w_wrath` — Wrath
- `w_lifegain` — Gain Life
- `w_exile` — Exile
- `w_tokens` — Token Swarm
- `w_protect` — Protection
- `w_anthem` — Anthem

## Blue

- `u_counter` — Counterspell
- `u_draw` — Draw Extra
- `u_scry` — Scry
- `u_bounce` — Bounce
- `u_mill` — Mill
- `u_steal` — Steal
- `u_extra_turn` — Extra Turn

## Black

- `b_sacrifice` — Sacrifice
- `b_destroy` — Destroy
- `b_drain` — Drain
- `b_reanimate` — Reanimate
- `b_discard` — Discard
- `b_tutor` — Tutor
- `b_surveil` — Surveil

## Red

- `r_burn` — Burn
- `r_impulse` — Impulse Draw
- `r_haste` — Haste
- `r_treasure` — Treasure
- `r_goad` — Goad
- `r_extra_combat` — Extra Combat

## Green

- `g_ramp` — Ramp
- `g_counters` — +1/+1 Counters
- `g_fight` — Fight
- `g_trample` — Trample
- `g_bigmana` — Big Mana
- `g_stampede` — Stampede

## Colorless

- `c_equip` — Equip
- `c_manarock` — Mana Rock
- `c_eldrazi` — Eldrazi
- `c_annihilator` — Annihilator
- `c_artifact_token` — Artifact Token

Total: 45 sounds.
