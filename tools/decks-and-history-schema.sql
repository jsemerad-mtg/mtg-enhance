-- MTG Enhance — decks and game history (Cloudflare D1)
--
--   cd ~/Desktop/mtg-enhance-poc
--   npx wrangler d1 execute mtg_oracle_db --remote --file=tools/decks-and-history-schema.sql
--
-- These are Enhance's tables, so this file belongs in Enhance's repo: it used
-- to live only in MTG-Oracle/tools/, which has no version control at all. The
-- database is shared (one users table across both apps), so it can be applied
-- from either project's wrangler config; run it from here.
--
-- Safe to run more than once: every statement is IF NOT EXISTS or IF EXISTS.
--
-- Why a log and not running totals
-- --------------------------------
-- The first draft of this file kept `commander_records` with `wins` and
-- `losses` columns, on the reasoning that a log is "a row per player per game
-- forever, for a feature whose entire UI is two numbers next to a card name."
-- That held right up until the feature became "tap a commander and see every
-- past match, with all four players and who won" — which is a log by
-- definition. Totals can be derived from a log with GROUP BY; a log cannot be
-- derived from totals.
--
-- Deriving also means a manually-entered game (played away from the app) is a
-- real row rather than a fudge column that history can't explain.

-- ── Decks ────────────────────────────────────────────────────────────────────
-- What used to be "favorites" in browser localStorage. Moving it here is what
-- lets a deck carry a bracket and a decklist URL, and lets it follow a player
-- between devices.
--
-- Bracket is Wizards' 1–5 scale (1 Exhibition … 5 cEDH). Nullable, because
-- plenty of people won't know or care, and a required field would just get a
-- wrong answer.
--
-- deck_url is stored but nothing fetches it. It's a link a player chose to
-- share with their own table, so it is rendered as a link and never loaded,
-- previewed or scraped by us.
CREATE TABLE IF NOT EXISTS decks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  commander  TEXT NOT NULL,
  identity   TEXT NOT NULL DEFAULT '',   -- canonical WUBRG, 'C' for colorless
  bracket    INTEGER,                    -- 1-5, or NULL for unset
  deck_url   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One deck per commander per account. A player with two Krenko builds can
-- rename one; letting the same name exist twice makes every history lookup
-- ambiguous for no real gain.
CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_user_commander ON decks (user_id, commander);
CREATE INDEX IF NOT EXISTS idx_decks_user ON decks (user_id);

-- ── Game history ─────────────────────────────────────────────────────────────
-- One row per PARTICIPATING ACCOUNT per game, not one row per game. The same
-- game therefore appears once for each signed-in player, each row holding that
-- player's own commander and result.
--
-- `seats` duplicates the whole table into every row: names, commanders,
-- colours, who won. Denormalised deliberately.
--   - "my games with Atraxa" is one indexed read, no join.
--   - Guests at the table appear in the snapshot even though they have no row
--     of their own — which is the only way history can show a full table while
--     only accounts get records.
--   - A game's record stays true even if a deck is later renamed or deleted.
--
-- source: 'game'   — recorded from a real session, winner confirmed
--         'manual' — typed in afterwards for a game played away from the app.
--                    Carries no seats, because there is nobody to name.
CREATE TABLE IF NOT EXISTS game_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  game_id    TEXT,                       -- join code + timestamp; NULL when manual
  commander  TEXT NOT NULL,
  identity   TEXT NOT NULL DEFAULT '',
  bracket    INTEGER,
  won        INTEGER NOT NULL,           -- 1 or 0
  source     TEXT NOT NULL DEFAULT 'game',
  seats      TEXT,                       -- JSON array of {name, commander, identity, won}
  played_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_user ON game_history (user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_user_commander ON game_history (user_id, commander);
CREATE INDEX IF NOT EXISTS idx_history_user_identity ON game_history (user_id, identity);

-- The same account must not be written twice for one game — a rejoin, a retry,
-- or two sockets for one seat would otherwise double-count. Partial, so the
-- many manual rows (all with game_id NULL) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_once_per_game
  ON game_history (user_id, game_id) WHERE game_id IS NOT NULL;

-- The aggregate table from the first draft, if it was ever created, is now
-- redundant: totals come from game_history. Dropped rather than left behind to
-- be read by mistake later.
DROP TABLE IF EXISTS commander_records;
