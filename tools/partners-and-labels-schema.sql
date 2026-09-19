-- MTG Enhance — partner commanders and deck labels, STEP 1 of 2 (Cloudflare D1)
--
--   cd ~/Desktop/mtg-enhance-poc
--   npx wrangler d1 execute mtg_oracle_db --remote --file=tools/partners-and-labels-schema.sql
--   npm run deploy
--   npx wrangler d1 execute mtg_oracle_db --remote --file=tools/partners-and-labels-finish.sql
--
-- Expand, deploy, contract. This file only ADDS things, so the Worker that is
-- already running keeps working while it applies; the second file removes the
-- old index once the new Worker is live.
--
-- This was one file to begin with, and that was a mistake worth recording: it
-- dropped `idx_decks_user_commander` in the same breath, and the deployed
-- Worker's `ON CONFLICT(user_id, commander)` names that index by its columns.
-- With the index gone and the new Worker not yet live, SQLite answered every
-- deck insert with "ON CONFLICT clause does not match any PRIMARY KEY or
-- UNIQUE constraint" — a 102-deck import failed 102 times in a row. Nothing
-- was lost, but the window existed at all because a destructive step rode
-- along with an additive one.
--
-- NOT safe to re-run: SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- so a second run stops on "duplicate column name: commander2". Nothing is
-- damaged — the batch aborts — and the CREATE INDEX below is IF NOT EXISTS, so
-- it can be run on its own afterwards if you need to.
--
-- Two changes, one migration, because they widen the same key.
--
-- 1. commander2 — a deck may have two commanders (Partner, Partner with,
--    Friends forever, Choose a Background, Doctor's companion). At most two:
--    that is a rule of the format, not a guess, which is why this is a column
--    and not a join table.
--
-- 2. label — the old index allowed one deck per commander, on the reasoning
--    that "a player with two Krenko builds can rename one". In practice a
--    105-deck collection had three commanders running two decks each, and
--    renaming a real commander to dodge a unique index is the kind of advice
--    that sounds fine until someone takes it. A label is the honest version:
--    the commander stays correct and the decks stay apart.
--
-- Why NOT NULL DEFAULT '' and not nullable
-- ----------------------------------------
-- SQLite treats NULLs as distinct from each other in a unique index, so two
-- rows with the same commander and a NULL commander2 would BOTH be allowed —
-- the exact duplicate the index exists to prevent. Empty string compares
-- equal to empty string, so the constraint holds for the ordinary
-- one-commander, no-label deck that almost every row is.

ALTER TABLE decks ADD COLUMN commander2 TEXT NOT NULL DEFAULT '';
ALTER TABLE decks ADD COLUMN label      TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_user_deck
  ON decks (user_id, commander, commander2, label);

-- The old index is deliberately LEFT IN PLACE here. It still backs the running
-- Worker's ON CONFLICT, and while it exists a second deck for the same
-- commander is refused — so labels do not actually work until step 2. That is
-- the trade: a few minutes of the old behaviour instead of a few minutes of no
-- behaviour at all.

-- game_history deliberately gets NO new columns. It keys on `commander`, and
-- that column now holds the deck's KEY (see src/deck-key.js) rather than a
-- bare card name. A deck with one commander and no label produces exactly the
-- string it always did, so every row already written keeps matching — which
-- is the whole reason the key was built to be backwards compatible instead of
-- tidier.
