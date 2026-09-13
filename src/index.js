import { GameSession } from "./game-session.js";
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
      try {
        const body = await request.json();
        if (body?.mode === "remote") mode = "remote";
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
          body: JSON.stringify({ code: candidate, mode }),
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
      return Response.json({ code, mode });
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
