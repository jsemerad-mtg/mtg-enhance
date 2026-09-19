-- MTG Enhance — partner commanders and deck labels, STEP 2 of 2 (Cloudflare D1)
--
--   npx wrangler d1 execute mtg_oracle_db --remote --file=tools/partners-and-labels-finish.sql
--
-- Run this AFTER `npm run deploy` has put the new Worker live. Safe to re-run,
-- and a no-op if the index is already gone.
--
-- Dropping this is what makes labels work: while it exists, a second deck for
-- the same commander is refused however it is labelled, because the old index
-- ignores the label column entirely.
--
-- It must not be dropped before the deploy. The old Worker's
-- `ON CONFLICT(user_id, commander)` names this index by its columns, and
-- SQLite rejects the whole statement when no unique constraint matches — so
-- every deck save fails for as long as the gap lasts.

DROP INDEX IF EXISTS idx_decks_user_commander;
