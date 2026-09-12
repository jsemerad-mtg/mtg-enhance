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
      let code = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = randomCode();
        const id = env.GAME_SESSION.idFromName(candidate);
        const stub = env.GAME_SESSION.get(id);
        const res = await stub.fetch("https://internal/status");
        const { status } = await res.json();
        if (status === "empty") {
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
      return Response.json({ code });
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
