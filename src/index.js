import { GameSession } from "./game-session.js";
import { currentUser, unlockIdentity } from "./shared-session.js";

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
