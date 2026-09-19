import { GameSession } from "./game-session.js";
import { currentUser, unlockIdentity, canonicalIdentity } from "./shared-session.js";

// Records and history are read fresh every time. They change when a game ends,
// which is exactly when a stale answer would be most noticeable.
const noStore = { headers: { "Cache-Control": "no-store" } };

// A failed read returns nothing rather than throwing, and says why where
// `wrangler tail` can see it — but it also marks itself `failed`, because a
// log line nobody is watching is not a signal. Twice now a missing table has
// looked exactly like an empty account: `entitlements` for a few hours, then
// `game_history` for days. Both times the screen said something reassuring and
// false. Every endpoint below passes this flag on as `ok: false` so the client
// can tell "you have nothing" from "we couldn't find out".
const logAndEmpty = (what) => (e) => {
  console.error(`${what} read failed:`, e?.message || e);
  return { results: [], failed: true };
};

// Seats are written by us as JSON, but they are still a database value being
// handed to three other browsers. A malformed one is an empty table, never an
// exception mid-response.
function safeSeats(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 8) : null;
  } catch {
    return null;
  }
}

// Must match the cap Oracle enforces, so a question can't pass here and then
// be refused there after the allowance has already been spent.
const ORACLE_QUESTION_MAX = 400;
const ORACLE_API = "https://api.mtg-oracle.com";
export { GameSession };

// Excludes visually ambiguous characters: 0/O, 1/I/L.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(len = 4) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Host taps "Host a game" -> allocate an unused 4-char join code.
    // The DO for a code is created lazily by idFromName, so "unused"
    // means we probe it and it reports back empty/not-yet-created.
    if (url.pathname === "/api/create" && request.method === "POST") {
      // "colocated" = everyone round one table, "remote" = everyone on their
      // own screen. The difference is purely audio routing (see GameSession),
      // but it has to be fixed before anyone joins, so it's chosen by the host
      // at creation and claimed with the code.
      let mode = "colocated";
      let pin = null;
      try {
        const body = await request.json();
        if (body?.mode === "remote") mode = "remote";
        // Optional 4-digit PIN. A 4-character code alone is guessable enough
        // that a bored stranger can wander into a game; the PIN makes that
        // impractical without making the common case slower.
        if (typeof body?.pin === "string" && /^\d{4}$/.test(body.pin)) pin = body.pin;
      } catch {
        // No body — colocated is the safe default (sounds stay on one device).
      }

      let code = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = randomCode();
        const id = env.GAME_SESSION.idFromName(candidate);
        const stub = env.GAME_SESSION.get(id);
        // /claim initialises the session if the code is free, so the code is
        // taken the moment it's handed out — two hosts creating at the same
        // instant can no longer be handed the same code.
        const res = await stub.fetch("https://internal/claim", {
          method: "POST",
          body: JSON.stringify({ code: candidate, mode, pin }),
        });
        const { claimed } = await res.json();
        if (claimed) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        return Response.json(
          { error: "Could not allocate a join code — try again" },
          { status: 503 }
        );
      }
      return Response.json({ code, mode, pinRequired: pin !== null });
    }

    // Who is signed in, and what they own. The session comes from the shared
    // mtg-oracle.com cookie — this app has no sign-in of its own.
    //
    // Two paths, one handler. "/api/me" is a common enough endpoint name that
    // ad-blocker filter lists match it: AdBlock Plus returned a bare 403 for it
    // on this very domain (2026-09-13), with no error the page could see. Left
    // unhandled that fails in the worst possible way — a signed-in player looks
    // signed out, their purchase looks lost, and nothing in the app can tell
    // you why. "/api/player-state" is specific enough not to match those
    // lists. The old path stays for manual poking; the client must use the new
    // one.
    if (url.pathname === "/api/player-state" || url.pathname === "/api/me") {
      const me = await currentUser(request, env);
      return Response.json(me, {
        headers: { "Cache-Control": "no-store" },
      });
    }

    // Spend one palette slot. POST { identity: "WUBG" }.
    //
    // The client asks for confirmation first, but nothing here trusts that:
    // the slot count, the ownership check and the write all happen in
    // unlockIdentity() against the database. The response carries the fresh
    // entitlement state so the caller replaces its copy rather than
    // incrementing a local counter that could drift.
    if (url.pathname === "/api/unlock-identity" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const result = await unlockIdentity(request, env, body.identity);
      return Response.json(result, {
        status: result.ok ? 200 : result.signedIn === false ? 401 : 400,
        headers: { "Cache-Control": "no-store" },
      });
    }

    // ── Ask the Oracle ──────────────────────────────────────────────────────
    // The Worker fetches the answer and hands it to the Durable Object. The
    // browser never carries the answer text between players, because a client
    // that can put prose on three other screens can put anything there.
    //
    // Signing in is required. This is the one feature that spends real money
    // per use, and an account is what Oracle rate-limits against — a join code
    // is shareable, an account is not.
    if (url.pathname === "/api/oracle/ask" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      if (!me.signedIn) {
        return Response.json({ ok: false, error: "Sign in to ask the Oracle." }, { status: 401 });
      }

      const code = String(body.code || "").toUpperCase();
      const question = String(body.question || "").trim();
      if (code.length !== 4) return Response.json({ ok: false, error: "Bad join code." }, { status: 400 });
      if (!question) return Response.json({ ok: false, error: "Ask a rules question." }, { status: 400 });
      if (question.length > ORACLE_QUESTION_MAX) {
        return Response.json({
          ok: false,
          error: `Keep it under ${ORACLE_QUESTION_MAX} characters — the table is waiting.`,
        }, { status: 400 });
      }

      const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(code));

      // Spend the allowance BEFORE the model call. Two people tapping at the
      // same moment would otherwise both read "10 left" and both spend one.
      const reserved = await stub.fetch("https://internal/oracle/reserve", { method: "POST" })
        .then((r) => r.json())
        .catch(() => ({ ok: false, error: "Couldn't reach the table." }));
      if (!reserved.ok) return Response.json(reserved, { status: 429 });

      try {
        const res = await fetch(`${ORACLE_API}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Forwarded so Oracle attributes and rate-limits this against the
            // player's own account rather than our Worker's IP.
            Cookie: request.headers.get("Cookie") || "",
          },
          body: JSON.stringify({ mode: "rules", messages: [{ role: "user", content: question }] }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.message) throw new Error(data.error || `Oracle returned ${res.status}`);

        await stub.fetch("https://internal/oracle/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            askedBy: String(body.askedBy || "").slice(0, 20),
            question,
            answer: data.message,
            rulesCited: data.rules_cited || [],
          }),
        });
        return Response.json({ ok: true, asksLeft: reserved.asksLeft });
      } catch (err) {
        // Hand the slot back. A question that never got an answer should not
        // count against the table.
        await stub.fetch("https://internal/oracle/refund", { method: "POST" }).catch(() => {});
        return Response.json({ ok: false, error: "The Oracle couldn't answer that just now." }, { status: 502 });
      }
    }

    // ── Records, history and decks ──────────────────────────────────────────
    // All account-only. Guests get a signedIn:false shape rather than an empty
    // list, so the UI can say "sign in and these are kept" instead of showing
    // a blank table that reads like data went missing.
    if (url.pathname === "/api/records" && request.method === "GET") {
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      if (!me.signedIn || !env.DB) {
        return Response.json({ signedIn: false, ok: true, byCommander: [], byIdentity: [] }, noStore);
      }
      // Totals are derived, not stored. The log is the only source of truth,
      // which is what lets a manually-entered game count exactly like a played
      // one without a separate adjustment column.
      const byCommander = await env.DB
        .prepare(
          `SELECT commander, identity,
                  SUM(won) AS wins, SUM(1 - won) AS losses, MAX(played_at) AS last_played
             FROM game_history WHERE user_id = ?
            GROUP BY commander, identity
            ORDER BY (wins + losses) DESC, commander ASC LIMIT 200`
        )
        .bind(me.userId).all().catch(logAndEmpty("records byCommander"));

      // The same log, grouped the other way. A player with six mono-red decks
      // may care more about how red performs than how each build does.
      const byIdentity = await env.DB
        .prepare(
          `SELECT identity, SUM(won) AS wins, SUM(1 - won) AS losses
             FROM game_history WHERE user_id = ?
            GROUP BY identity ORDER BY (wins + losses) DESC LIMIT 40`
        )
        .bind(me.userId).all().catch(logAndEmpty("records byIdentity"));

      return Response.json({
        signedIn: true,
        // Either half failing makes the whole screen untrustworthy: the two
        // tabs are the same games counted two ways, so one of them silently
        // short is worse than neither of them showing.
        ok: !(byCommander.failed || byIdentity.failed),
        byCommander: byCommander.results || [],
        byIdentity: byIdentity.results || [],
      }, noStore);
    }

    // Past matches, newest first. `commander` narrows it to one deck.
    if (url.pathname === "/api/history" && request.method === "GET") {
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      if (!me.signedIn || !env.DB) return Response.json({ signedIn: false, ok: true, games: [] }, noStore);

      const commander = url.searchParams.get("commander");
      const stmt = commander
        ? env.DB.prepare(
            `SELECT id, game_id, commander, identity, bracket, won, source, seats, played_at
               FROM game_history WHERE user_id = ? AND commander = ?
              ORDER BY played_at DESC LIMIT 100`
          ).bind(me.userId, commander.slice(0, 80))
        : env.DB.prepare(
            `SELECT id, game_id, commander, identity, bracket, won, source, seats, played_at
               FROM game_history WHERE user_id = ? ORDER BY played_at DESC LIMIT 100`
          ).bind(me.userId);

      const out = await stmt.all().catch(logAndEmpty("history"));
      const games = (out.results || []).map((row) => ({
        ...row,
        // Parsed here so the client never runs JSON.parse on a database value
        // and never has to decide what a malformed one means.
        seats: safeSeats(row.seats),
      }));
      return Response.json({ signedIn: true, ok: !out.failed, games }, noStore);
    }

    // A game played away from the app. This is a first-class row, not an
    // adjustment: people play plenty of Commander without a phone on the table
    // and reasonably want it counted.
    if (url.pathname === "/api/history/manual" && request.method === "POST") {
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      if (!me.signedIn || !env.DB) {
        return Response.json({ ok: false, error: "Sign in to track games." }, { status: 401 });
      }
      const body = await request.json().catch(() => ({}));
      const commander = String(body.commander || "").trim().slice(0, 80);
      if (!commander) return Response.json({ ok: false, error: "Name the commander." }, { status: 400 });

      const bracket = Number.isInteger(body.bracket) && body.bracket >= 1 && body.bracket <= 5
        ? body.bracket : null;
      try {
        await env.DB.prepare(
          `INSERT INTO game_history (user_id, game_id, commander, identity, bracket, won, source, seats)
           VALUES (?, NULL, ?, ?, ?, ?, 'manual', NULL)`
        ).bind(me.userId, commander, canonicalIdentity(body.identity) || "C",
               bracket, body.won ? 1 : 0).run();
      } catch (e) {
        console.error("manual history write failed:", e?.message || e);
        return Response.json({ ok: false, error: "Could not record that." }, { status: 500 });
      }
      return Response.json({ ok: true }, noStore);
    }

    // Removing a recorded game. Kept deliberately simple — one row, by id,
    // and only your own.
    if (url.pathname.startsWith("/api/history/") && request.method === "DELETE") {
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      if (!me.signedIn || !env.DB) return Response.json({ ok: false }, { status: 401 });
      const id = Number(url.pathname.split("/")[3]);
      if (!Number.isInteger(id)) return Response.json({ ok: false }, { status: 400 });
      await env.DB.prepare("DELETE FROM game_history WHERE id = ? AND user_id = ?")
        .bind(id, me.userId).run().catch(() => {});
      return Response.json({ ok: true }, noStore);
    }

    // Decks — what "favorites" became once they could carry a bracket and a
    // decklist link.
    if (url.pathname === "/api/decks" && request.method === "GET") {
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      if (!me.signedIn || !env.DB) return Response.json({ signedIn: false, ok: true, decks: [] }, noStore);
      const out = await env.DB
        .prepare(
          `SELECT id, commander, identity, bracket, deck_url
             FROM decks WHERE user_id = ? ORDER BY commander ASC LIMIT 100`
        )
        .bind(me.userId).all().catch(logAndEmpty("decks"));
      return Response.json({ signedIn: true, ok: !out.failed, decks: out.results || [] }, noStore);
    }

    if (url.pathname === "/api/decks" && request.method === "POST") {
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      if (!me.signedIn || !env.DB) {
        return Response.json({ ok: false, error: "Sign in to save decks." }, { status: 401 });
      }
      const body = await request.json().catch(() => ({}));
      const commander = String(body.commander || "").trim().slice(0, 80);
      if (!commander) return Response.json({ ok: false, error: "Name the commander." }, { status: 400 });

      const bracket = Number.isInteger(body.bracket) && body.bracket >= 1 && body.bracket <= 5
        ? body.bracket : null;

      // A decklist link is shown to three other people, so only ordinary web
      // links are accepted: no javascript:, no data:, nothing that does
      // something when tapped other than open a page.
      let deckUrl = null;
      const raw = String(body.deckUrl || "").trim();
      if (raw) {
        try {
          const parsed = new URL(raw);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
          deckUrl = parsed.toString().slice(0, 500);
        } catch {
          return Response.json({ ok: false, error: "That doesn't look like a web link." }, { status: 400 });
        }
      }

      try {
        await env.DB.prepare(
          `INSERT INTO decks (user_id, commander, identity, bracket, deck_url)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, commander) DO UPDATE SET
             identity = excluded.identity,
             bracket = excluded.bracket,
             deck_url = excluded.deck_url,
             updated_at = datetime('now')`
        ).bind(me.userId, commander, canonicalIdentity(body.identity) || "C", bracket, deckUrl).run();
      } catch (e) {
        console.error("deck write failed:", e?.message || e);
        return Response.json({ ok: false, error: "Could not save that deck." }, { status: 500 });
      }
      return Response.json({ ok: true }, noStore);
    }

    if (url.pathname.startsWith("/api/decks/") && request.method === "DELETE") {
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      if (!me.signedIn || !env.DB) return Response.json({ ok: false }, { status: 401 });
      const id = Number(url.pathname.split("/")[3]);
      if (!Number.isInteger(id)) return Response.json({ ok: false }, { status: 400 });
      await env.DB.prepare("DELETE FROM decks WHERE id = ? AND user_id = ?")
        .bind(id, me.userId).run().catch(() => {});
      return Response.json({ ok: true }, noStore);
    }

    // Asked by the lobby before connecting, so a joiner is prompted for a PIN
    // up front rather than being bounced after a failed WebSocket join.
    if (url.pathname.startsWith("/api/session/")) {
      const code = url.pathname.split("/")[3]?.toUpperCase();
      if (!code || code.length !== 4) return Response.json({ exists: false }, { status: 400 });
      const stub = env.GAME_SESSION.get(env.GAME_SESSION.idFromName(code));
      return stub.fetch("https://internal/info");
    }

    // Player taps "Join" with a code, or the host's own client connects
    // right after /api/create -> upgrade to a WebSocket on that code's DO.
    if (url.pathname.startsWith("/ws/")) {
      const code = url.pathname.split("/")[2]?.toUpperCase();
      if (!code || code.length !== 4) {
        return new Response("Invalid join code", { status: 400 });
      }

      // The Durable Object is where sounds are authorised, but it can't read
      // the session cookie itself — it has no D1 binding and no business
      // holding one. So the Worker, which is already the trust boundary for
      // every other request, verifies here and hands the *result* down.
      //
      // This header is set by us on an internal request that never leaves
      // Cloudflare's network; the browser's own copy of it, if someone tried
      // to send one, is overwritten below rather than merged.
      const me = await currentUser(request, env).catch(() => ({ signedIn: false }));
      const entitlements = JSON.stringify({
        all: me.all === true,
        identities: Array.isArray(me.identities) ? me.identities : [],
        // Who this seat belongs to, so the Durable Object can record a result
        // against a real account when the game ends. Guests arrive as null and
        // are simply not recorded — there is nowhere to put the row.
        userId: me.signedIn ? me.userId || null : null,
      });

      const headers = new Headers(request.headers);
      headers.set("X-Entitlements", entitlements);

      const id = env.GAME_SESSION.idFromName(code);
      const stub = env.GAME_SESSION.get(id);
      return stub.fetch(new Request(request, { headers }));
    }

    // Everything else (index.html, client.js, style.css) is static.
    return env.ASSETS.fetch(request);
  },
};
