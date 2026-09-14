import { GameSession } from "./game-session.js";
import { currentUser, unlockIdentity } from "./shared-session.js";
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
      const id = env.GAME_SESSION.idFromName(code);
      const stub = env.GAME_SESSION.get(id);
      return stub.fetch(request);
    }

    // Everything else (index.html, client.js, style.css) is static.
    return env.ASSETS.fetch(request);
  },
};
