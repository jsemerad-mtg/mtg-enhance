// A stand-in for the Worker: serves public/ and answers the two endpoints the
// account layer talks to. The mock state is swappable at runtime via
// POST /__mock so one browser session can walk through signed-out, signed-in
// and unreachable without restarting anything.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
                ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

// "down" reproduces the AdBlock Plus case: a 403 with no body.
let mock = { mode: "out", state: null };
// This process outlives any one suite, so decks written by an earlier run were
// still here when the next one started — which read as a phantom POST erasing a
// decklist. POST /__reset puts them back.
const INITIAL_DECKS = [
  { id: 1, commander: "Krenko, Mob Boss", identity: "R", bracket: 4, deck_url: null },
  { id: 2, commander: "Shorikai, Genesis Engine", identity: "WU", bracket: 2,
    deck_url: "https://moxfield.com/decks/abc" },
];
let mockDecks = INITIAL_DECKS.map((d) => ({ ...d }));
let lastDeckPost = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/__mock" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    mock = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end("{}");
  }

  if (url.pathname === "/api/player-state") {
    if (mock.mode === "down") { res.writeHead(403); return res.end(); }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (mock.mode === "out") return res.end(JSON.stringify({ signedIn: false }));
    return res.end(JSON.stringify({ signedIn: true, ...mock.state }));
  }

  // Tables the mock knows about. ABCD wants no PIN, PINX does, anything else
  // doesn't exist — which is the case the home screen now has to handle.
  if (url.pathname.startsWith("/api/session/")) {
    const code = url.pathname.split("/")[3]?.toUpperCase();
    const tables = { ABCD: { exists: true, pinRequired: false, mode: "colocated" },
                     PINX: { exists: true, pinRequired: true, mode: "remote" } };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(tables[code] || { exists: false, pinRequired: false, mode: null }));
  }

  if (url.pathname === "/api/records") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (mock.mode !== "in") return res.end(JSON.stringify({ signedIn: false, byCommander: [], byIdentity: [] }));
    // A brand-new account: decks saved, no game ever finished. This is the
    // shape that made the colours tab render nothing.
    if (mock.emptyRecords) {
      return res.end(JSON.stringify({ signedIn: true, byCommander: [], byIdentity: [] }));
    }
    return res.end(JSON.stringify({
      signedIn: true,
      byCommander: [
        { commander: "Atraxa, Grand Unifier", identity: "WUBG", wins: 4, losses: 3, last_played: "2026-09-12" },
        { commander: "Krenko, Mob Boss", identity: "R", wins: 1, losses: 5, last_played: "2026-09-01" },
      ],
      byIdentity: [{ identity: "WUBG", wins: 4, losses: 3 }, { identity: "R", wins: 1, losses: 5 }],
    }));
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (mock.mode !== "in") return res.end(JSON.stringify({ signedIn: false, games: [] }));
    if (mock.emptyRecords) return res.end(JSON.stringify({ signedIn: true, games: [] }));
    // ?commander= narrows it to one deck, the same way the Worker does. Without
    // this the mock hands back every game for every commander, which hides the
    // exact regression the filter exists to prevent.
    const only = url.searchParams.get("commander");
    const all = [
      { id: 11, game_id: "K4TM:1", commander: "Atraxa, Grand Unifier", identity: "WUBG",
        bracket: 3, won: 1, source: "game", played_at: "2026-09-12 20:10:00",
        seats: [
          { name: "Jay", commander: "Atraxa, Grand Unifier", identity: "WUBG", won: 1 },
          { name: "Sam", commander: "Krenko, Mob Boss", identity: "R", won: 0 },
          { name: "Ali", commander: "Yuriko, the Tiger's Shadow", identity: "UB", won: 0 },
        ] },
      { id: 12, game_id: null, commander: "Atraxa, Grand Unifier", identity: "WUBG",
        bracket: null, won: 0, source: "manual", played_at: "2026-09-05 00:00:00", seats: null },
    ];
    return res.end(JSON.stringify({
      signedIn: true,
      games: only ? all.filter((g) => g.commander === only) : all,
    }));
  }

  if (url.pathname === "/api/history/manual" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    const b = JSON.parse(body || "{}");
    res.writeHead(b.commander ? 200 : 400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(b.commander ? { ok: true } : { ok: false, error: "Name the commander." }));
  }

  if (url.pathname.startsWith("/api/history/") && req.method === "DELETE") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Deck rows the mock remembers between requests, so a save can be observed.
  if (url.pathname === "/api/decks" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (mock.mode !== "in") return res.end(JSON.stringify({ signedIn: false, decks: [] }));
    return res.end(JSON.stringify({ signedIn: true, decks: mockDecks }));
  }

  if (url.pathname === "/api/decks" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    const b = JSON.parse(body || "{}");
    if (b.deckUrl && !/^https?:\/\//.test(b.deckUrl)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "That doesn't look like a web link." }));
    }
    const i = mockDecks.findIndex((d) => d.commander === b.commander);
    const row = { id: i >= 0 ? mockDecks[i].id : mockDecks.length + 1, commander: b.commander,
                  identity: b.identity || "", bracket: b.bracket ?? null, deck_url: b.deckUrl || null };
    if (i >= 0) mockDecks[i] = row; else mockDecks.push(row);
    lastDeckPost = b;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname.startsWith("/api/decks/") && req.method === "DELETE") {
    const id = Number(url.pathname.split("/")[3]);
    mockDecks = mockDecks.filter((d) => d.id !== id);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (url.pathname === "/__reset" && req.method === "POST") {
    mockDecks = INITIAL_DECKS.map((d) => ({ ...d }));
    lastDeckPost = null;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end("{}");
  }

  if (url.pathname === "/__decks") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ decks: mockDecks, lastDeckPost }));
  }

  if (url.pathname === "/api/unlock-identity" && req.method === "POST") {
    let body = ""; for await (const c of req) body += c;
    const { identity } = JSON.parse(body || "{}");
    if (mock.mode !== "in") { res.writeHead(401); return res.end(JSON.stringify({ ok: false, signedIn: false, error: "Sign in first." })); }
    if ((mock.state.slotsLeft || 0) <= 0) {
      res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "No palette slots left." }));
    }
    mock.state.identities = [...new Set([...(mock.state.identities || []), identity])];
    mock.state.slotsUsed = mock.state.identities.length;
    mock.state.slotsLeft = Math.max(0, mock.state.slotsTotal - mock.state.slotsUsed);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ...mock.state }));
  }

  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end("nope"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

const PORT = Number(process.env.MTGE_TEST_PORT || 8232);
server.listen(PORT, () => console.log(`mock worker on http://127.0.0.1:${PORT}`));
