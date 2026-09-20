# MTG Enhance — the sound list to author against

Generated 2026-09-19 from `src/sound-catalog.js`, which is the authority. The
build script refuses any filename not on this list, so this is the list.

## How to record

Drop files into `sounds-src/` named **exactly** the id in the first column,
any of `.wav .aiff .flac .mp3 .m4a`. Then:

```
npm run build:sounds     # transcodes, loudness-normalises, writes the manifest
open public/sounds.html  # audition them
```

Loudness is handled for you — two-pass LUFS normalisation, so a sparse sound
and a dense one end up equally loud rather than equally peaked. Don't
pre-normalise.

## Variants

Any sound can have up to nine takes, chosen at random each time it fires:

```
sounds-src/combat_damage_1.wav
sounds-src/combat_damage_2.wav
sounds-src/combat_damage_3.wav
```

Nothing needs them, and most sounds won't want them — it's worth the effort
where a sound fires constantly and a single clip starts to grate. Combat
damage, land drop and attack are the obvious candidates; Victory fires once a
game and never needs a second take.

Rules the build enforces:

- `_1` to `_9` only. `_0`, `_10` and `combat_damage_a` are rejected by name.
- **Either a plain file or variants, never both.** `combat_damage.wav`
  alongside `combat_damage_1.wav` fails the build rather than guessing which
  take you meant.
- A sound counts as authored once any one of its takes exists, so three
  variants of combat damage doesn't leave it on the "still to author" list.

Variants are normalised individually, which matters more here than anywhere
else: three takes recorded at different levels would otherwise be a random
volume jump every time the sound fired.

A variant costs exactly what its base costs — `w_wrath_2` needs the White
palette the same as `w_wrath` does — so a numbered suffix is never a way to
reach a sound you haven't unlocked.

## What to make first

The order below is the order of usefulness per sound authored:

1. **Universal (9)** — on every board, whatever anyone is playing.
2. **Mono colours (45)** — nine each. Every coloured board draws on these.
3. **Colourless (8)** — completes the colourless board, which has no other source.
4. **Guilds (10)** — one each. Gives a two-colour board something that isn't
   just its two parents' lists side by side.
5. **Shards and wedges (10)** — one each, named for the keyword the
   combination actually shipped with, so the word already means something.

**82 in total**, before any variants. Stopping after any numbered group leaves a coherent set: stop
after 1 and every table has working sounds; after 2 and every coloured deck
does; after 3 and every deck does.

## A note on length

These play over four people talking. Under a second for anything that fires
often (damage, land drop), up to two for the theatrical ones (extra turn, an
Eldrazi landing). Only Victory gets to run long.

## 1. Universal — 9

On every board, free for everyone, signed in or not.

### Table events

| id | button | note |
|---|---|---|
| `combat_damage` | Combat Damage | A hit landing. Gets played more than anything else, so it has to bear repetition — short, no long tail. |
| `commander_damage` | Commander Damage | The same hit, but it matters: distinct enough to hear across a table mid-conversation. |
| `attack` | Attack! | Declaring. A call to arms rather than an impact. |
| `block` | Blockers | The wall going up. The answer to Attack, and should sound like one. |
| `land_drop` | Land Drop | Small and dry. Played every turn by four people; anything characterful becomes unbearable by turn six. |
| `counter_stack` | In Response | The hand going up. Interruption, not resolution. |
| `shuffle` | Shuffle | Cards. Literal is fine here. |
| `eliminated` | Eliminated | Someone is out. Final, not cruel — they are still at the table. |
| `win_game` | Victory | The game is over. The only sound allowed to be long. |

## 2. Mono colours — 45

### White — 9

| id | button | note |
|---|---|---|
| `w_wrath` | Wrath |  |
| `w_lifegain` | Gain Life |  |
| `w_exile` | Exile |  |
| `w_tokens` | Token Swarm |  |
| `w_protect` | Protection |  |
| `w_anthem` | Anthem |  |
| `w_tax` | Tax |  |
| `w_lifelink` | Lifelink |  |
| `w_disenchant` | Disenchant |  |

### Blue — 9

| id | button | note |
|---|---|---|
| `u_counter` | Counterspell |  |
| `u_draw` | Draw Extra |  |
| `u_scry` | Scry |  |
| `u_bounce` | Bounce |  |
| `u_mill` | Mill |  |
| `u_steal` | Steal |  |
| `u_extra_turn` | Extra Turn |  |
| `u_copy` | Copy |  |
| `u_tap` | Tap Down |  |

### Black — 9

| id | button | note |
|---|---|---|
| `b_sacrifice` | Sacrifice |  |
| `b_destroy` | Destroy |  |
| `b_drain` | Drain |  |
| `b_reanimate` | Reanimate |  |
| `b_discard` | Discard |  |
| `b_tutor` | Tutor |  |
| `b_paylife` | Pay Life |  |
| `b_dies` | Death Trigger |  |
| `b_edict` | Edict |  |

### Red — 9

| id | button | note |
|---|---|---|
| `r_burn` | Burn |  |
| `r_impulse` | Impulse Draw |  |
| `r_haste` | Haste |  |
| `r_treasure` | Treasure |  |
| `r_goad` | Goad |  |
| `r_extra_combat` | Extra Combat |  |
| `r_chaos` | Chaos |  |
| `r_double_damage` | Double Damage |  |
| `r_landkill` | Land Destruction |  |

### Green — 9

| id | button | note |
|---|---|---|
| `g_ramp` | Ramp |  |
| `g_counters` | +1/+1 Counters |  |
| `g_fight` | Fight |  |
| `g_trample` | Trample |  |
| `g_bigmana` | Big Mana |  |
| `g_stampede` | Stampede |  |
| `g_draw_power` | Draw off Power |  |
| `g_regenerate` | Regenerate |  |
| `g_fatty` | Cast a Fatty |  |

## 3. Colourless and artifact — 8

Only a colourless board plays these; an artifact deck in colours uses its own colours.

### Colourless — 8

| id | button | note |
|---|---|---|
| `c_equip` | Equip |  |
| `c_manarock` | Mana Rock |  |
| `c_eldrazi` | Eldrazi |  |
| `c_annihilator` | Annihilator |  |
| `c_artifact_token` | Artifact Token |  |
| `c_graveyard_exile` | Exile a Graveyard |  |
| `c_proliferate` | Proliferate |  |
| `c_ultimate` | Ultimate |  |

## 4. Guilds — 10

One apiece. It should be something neither parent colour owns alone.

| id | button | guild | colours |
|---|---|---|---|
| `wu_flicker` | Flicker | Azorius | White · Blue |
| `wb_afterlife` | Afterlife | Orzhov | White · Black |
| `wr_boast` | Boast | Boros | White · Red |
| `wg_populate` | Populate | Selesnya | White · Green |
| `ub_surveil` | Surveil | Dimir | Blue · Black |
| `ur_storm` | Storm | Izzet | Blue · Red |
| `ug_explore` | Explore | Simic | Blue · Green |
| `br_aristocrat` | Aristocrats | Rakdos | Black · Red |
| `bg_graveyard` | Graveyard Value | Golgari | Black · Green |
| `rg_riot` | Riot | Gruul | Red · Green |

## 5. Shards and wedges — 10

One apiece, named for the keyword the combination shipped with in Alara or Khans.

| id | button | shard/wedge | colours |
|---|---|---|---|
| `wub_artifice` | Artifice | Esper | White · Blue · Black |
| `wur_prowess` | Prowess | Jeskai | White · Blue · Red |
| `wug_exalted` | Exalted | Bant | White · Blue · Green |
| `wbr_raid` | Raid | Mardu | White · Black · Red |
| `wbg_outlast` | Outlast | Abzan | White · Black · Green |
| `wrg_behemoth` | Behemoth | Naya | White · Red · Green |
| `ubr_unearth` | Unearth | Grixis | Blue · Black · Red |
| `ubg_delve` | Delve | Sultai | Blue · Black · Green |
| `urg_ferocious` | Ferocious | Temur | Blue · Red · Green |
| `brg_devour` | Devour | Jund | Black · Red · Green |

## What a board actually shows

A sound's *group* is a colour combination. A board may use a group when the
group's colours are all in the deck's identity, and the player owns a palette
covering it.

- A **Simic** deck sees Blue, Green and Simic.
- A **Grixis** deck sees Blue, Black, Red, Dimir, Izzet, Rakdos and Grixis.
- A **Gruul + Dimir partner pair** sees all four colours, Gruul and Dimir —
  and nothing that straddles the two commanders, because no such palette was
  bought. Four-colour decks get plenty without anything being authored for
  them, which is why there are no four-colour sounds on this list.

## Four-colour and five-colour

Deliberately not authored. A four-colour deck already reaches four mono sets
and several guilds; a five-colour deck reaches everything. Adding a specific
sound for each of the five nephilim combinations would be five more recordings
for the rarest decks in the format.
