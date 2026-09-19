-- MTG Enhance — partner commanders and deck labels (Cloudflare D1)
--
--   cd ~/Desktop/mtg-enhance-poc
--   npx wrangler d1 execute mtg_oracle_db --remote --file=tools/partners-and-labels-schema.sql
--
-- Safe to run more than once. Run it BEFORE deploying the Worker that uses
-- these columns: the new code writes commander2 and label on every deck save,
-- and a save against the old table fails outright.
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

-- The old index is a strict subset of the new one, so it is dropped rather
-- than left to enforce a rule the app no longer has.
DROP INDEX IF EXISTS idx_decks_user_commander;

CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_user_deck
  ON decks (user_id, commander, commander2, label);

-- game_history deliberately gets NO new columns. It keys on `commander`, and
-- that column now holds the deck's KEY (see src/deck-key.js) rather than a
-- bare card name. A deck with one commander and no label produces exactly the
-- string it always did, so every row already written keeps matching — which
-- is the whole reason the key was built to be backwards compatible instead of
-- tidier.
