import { DurableObject } from "cloudflare:workers";
import { soundAllowed } from "./sound-catalog.js";
import { rememberLifeChange, undoDecision } from "./life-undo.js";
import { canonicalIdentity } from "./shared-session.js";
import { deckKey, NAME_MAX, LABEL_MAX } from "./deck-key.js";
import { damageKey, worstDamage, migrateSeat, COMMANDER_DAMAGE_LETHAL } from "./commander-damage.js";

// Session audio routing depends on `state.mode`, chosen by the host at
// creation:
//   colocated — everyone round one table, so ambient music and board wipes
//               play on the host's device only; four phones playing the same
//               sound a few feet apart phases and echoes.
//   remote    — everyone on their own screen, so those play for all players.
// Targeted and self-triggered sounds (damage, taunt, draw) always play on the
// relevant player's own device in both modes.
const COOLDOWNS_MS = {
  taunt: 8000,
  poke: 30000,
  // Board Wipe is a shared, session-wide cooldown (see checkCooldown's
  // `key` argument below) rather than per-player — one board wipe at a
  // time makes more sense thematically than each player having their own.
  broadcast: 60000,
};

// Looks up remainingMs for `soundId` against `key` in state.cooldowns,
// recording a fresh trigger time when the cooldown has cleared. A soundId
// with no entry in COOLDOWNS_MS is always allowed (e.g. Draw Card, which
// has no cooldown for now but can get one later just by adding an entry).
function checkCooldown(state, soundId, key) {
  const cooldownMs = COOLDOWNS_MS[soundId];
  if (!cooldownMs) return { ok: true };
  const last = state.cooldowns[key] ?? 0;
  const now = Date.now();
  if (now - last < cooldownMs) {
    return { ok: false, remainingMs: cooldownMs - (now - last) };
  }
  state.cooldowns[key] = now;
  return { ok: true };
}

// Anything that isn't 1-5 becomes null rather than being stored as-is: the
// column feeds a stat, and a bracket of 0 or 99 is noise, not data.
function validBracket(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

function initialState(sessionId, mode = "colocated", pin = null) {
  return {
    sessionId,
    mode: mode === "remote" ? "remote" : "colocated",
    // Never leaves the Durable Object — see publicState().
    pin: typeof pin === "string" && /^\d{4}$/.test(pin) ? pin : null,
    players: {}, // playerId -> PlayerState
    hostId: null,
    ambientActivePlayerId: null,
    cooldowns: {}, // "playerId:soundId" -> last-triggered timestamp (ms)
    status: "lobby", // lobby | active
    // Turn order defaults to the order people sat down; the host can reorder.
    turnOrder: [],
    activePlayerIndex: 0,
    turnStartedAt: Date.now(),
    // Table-wide states with a single holder. A playmat gives every player a
    // box for these because it needs somewhere to put the token; only one
    // player can hold each, so one field apiece is the honest shape.
    monarchPlayerId: null,
    initiativePlayerId: null,
    // Ask the Oracle. The allowance is per TABLE, not per player, because a
    // per-player one would have to trust the client's word about who is
    // asking — and burning someone else's allowance is a nastier prank than
    // burning the table's. It's also the honest thing to show: "this table has
    // 7 questions left" is a sentence four people can reason about together.
    oracleAsked: 0,
    // Set once, when one player is left standing. Guards against a second
    // write if someone toggles an elimination off and on again.
    resultsRecorded: false,
    // Set when the last player standing has been asked. Without it, every
    // subsequent elimination toggle would re-prompt them.
    winOffered: false,
  };
}

// Generous enough that a real game never notices, small enough that a
// shared join code can't run up a bill. Oracle's own per-user rate limit
// (120/min signed in) is the backstop behind this, not the front line.
export const ORACLE_ASKS_PER_GAME = 10;

// Poke is a "hurry up" nudge, so it's only allowed against the player who is
// actually holding the table up: the active player, one minute into their turn.
const POKE_MIN_TURN_MS = 60000;

// The two non-life loss conditions. 21 combat damage from a single commander,
// or 10 poison counters, and you're out.
const POISON_LETHAL = 10;

// A player is out on any of the three loss conditions. Announced once on the
// transition, not on every life change afterwards, so a player sitting at 0
// doesn't re-trigger the sound each time anything else moves.
// Client-supplied, so it is scrubbed to canonical WUBRG before it can decide
// anything: at most two entries, each at most five letters, nothing else.
function cleanIdentities(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 2)
    .map((c) => canonicalIdentity(String(c || "")))
    .filter((c, i, a) => a.indexOf(c) === i);
}

function lethalReason(player) {
  if (!player) return null;
  if ((player.lifeTotal ?? 1) <= 0) return "life";
  if ((player.poison ?? 0) >= POISON_LETHAL) return "poison";
  if (worstDamage(player.commanderDamage) >= COMMANDER_DAMAGE_LETHAL) return "commander";
  return null;
}

// Walks the rotation past anyone who has been marked out. Falls back to the
// immediate next seat if everyone else is eliminated, so the turn can never
// get stuck with nowhere to go.
function nextSeat(order, fromId, players) {
  if (order.length === 0) return 0;
  const at = order.indexOf(fromId);
  for (let step = 1; step <= order.length; step++) {
    const index = (at + step) % order.length;
    if (!players[order[index]]?.eliminated) return index;
  }
  return (at + 1) % order.length;
}

function activePlayerId(state) {
  return state.turnOrder[state.activePlayerIndex] ?? null;
}

function canPoke(state, targetPlayerId) {
  if (targetPlayerId !== activePlayerId(state)) return false;
  return Date.now() - (state.turnStartedAt ?? 0) >= POKE_MIN_TURN_MS;
}

export class GameSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sessionState = null;
    // Life changes someone else made to you, undoable for a few seconds.
    // Deliberately NOT in sessionState and never persisted: the window is
    // twelve seconds, and a DO that hibernated and came back has already
    // outlived it. If the map is gone the undo simply fails, which is the
    // honest answer rather than a resurrected button that does nothing.
    this.recentLife = new Map();
    // Rehydrate from storage before handling any request — the DO may
    // have hibernated and lost its in-memory state between messages.
    ctx.blockConcurrencyWhile(async () => {
      this.sessionState = (await ctx.storage.get("state")) ?? null;
    });
  }

  // Sessions created before turn order and mute existed rehydrate without
  // those fields; fill them in rather than throwing on the first message.
  ensureShape() {
    const state = this.sessionState;
    if (!state) return;
    if (!Array.isArray(state.turnOrder)) state.turnOrder = Object.keys(state.players || {});
    if (state.monarchPlayerId === undefined) state.monarchPlayerId = null;
    if (state.initiativePlayerId === undefined) state.initiativePlayerId = null;
    if (typeof state.activePlayerIndex !== "number") state.activePlayerIndex = 0;
    if (typeof state.turnStartedAt !== "number") state.turnStartedAt = Date.now();
    if (typeof state.oracleAsked !== "number") state.oracleAsked = 0;
    if (typeof state.resultsRecorded !== "boolean") state.resultsRecorded = false;
    if (typeof state.winOffered !== "boolean") state.winOffered = false;
    for (const player of Object.values(state.players || {})) {
      if (typeof player.muted !== "boolean") player.muted = false;
      if (!player.commanderDamage || typeof player.commanderDamage !== "object") player.commanderDamage = {};
      if (typeof player.poison !== "number") player.poison = 0;
      if (typeof player.lethalAnnounced !== "boolean") player.lethalAnnounced = false;
      if (typeof player.eliminated !== "boolean") player.eliminated = false;
      if (typeof player.commanderName2 !== "string") player.commanderName2 = "";
      if (!Array.isArray(player.commanderIdentities)) player.commanderIdentities = [];
      if (typeof player.deckLabel !== "string") player.deckLabel = "";
      migrateSeat(player);
      if (!player.commanderCasts || typeof player.commanderCasts !== "object") {
        player.commanderCasts = { 0: 0, 1: 0 };
      }
      if (player.bracket === undefined) player.bracket = null;
    }
  }

  // state_sync goes to every connected client, so anything the table has no
  // business seeing is stripped here: the PIN, and each seat's account id.
  //
  // The account id matters more than it looks. It isn't a secret exactly, but
  // it's the key every entitlement and every game record hangs off, and there
  // is no reason three strangers who joined with a four-character code should
  // be handed it. It's needed on the seat so a result can be recorded at game
  // end; it is not needed by anyone's browser.
  publicState() {
    const { pin, players, ...rest } = this.sessionState;
    const publicPlayers = {};
    for (const [id, seat] of Object.entries(players || {})) {
      const { userId, ...safe } = seat;
      publicPlayers[id] = safe;
    }
    return { ...rest, players: publicPlayers, pinRequired: pin !== null };
  }

  // One player left standing ends the game — but it does not record it. It
  // asks.
  //
  // The trigger is reliable; the conclusion isn't. Eliminations get toggled by
  // mistake, a table can break up mid-game, and the last player standing has
  // no reason to touch their phone. So the last player is asked to confirm,
  // and if they decline or never answer, NOTHING is written — not even the
  // losses the eliminated players already implied.
  //
  // A half-recorded game is worse than an unrecorded one: three losses and no
  // win quietly drags every win rate down, and nobody can tell it happened.
  // Manual entry exists precisely so the gap has an honest fix.
  async offerWinIfOver() {
    const state = this.sessionState;
    if (!state || state.resultsRecorded || state.winOffered) return;

    const seats = Object.values(state.players || {});
    // Two is the smallest thing that can be won. One person eliminating
    // themselves in an empty lobby is not a game.
    if (seats.length < 2) return;

    const alive = seats.filter((p) => !p.eliminated);
    if (alive.length !== 1) return;

    state.winOffered = true;
    this.sendTo(alive[0].id, {
      type: "confirm_win",
      opponents: seats.filter((p) => p.id !== alive[0].id).map((p) => p.displayName || "Player"),
    });
  }

  sendTo(playerId, message) {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.playerId !== playerId) continue;
      try { ws.send(payload); } catch { /* the socket went away */ }
    }
  }

  // Called only when the last player standing says yes.
  //
  // Writes straight to D1 from here. The entitlement check deliberately does
  // NOT live in this class — verification belongs at the Worker, which is the
  // trust boundary — but a result is different in kind: the outcome is
  // something only this object knows, and passing it out to be written
  // elsewhere would just add a hop where it could be forged.
  async recordResult(claimantId) {
    const state = this.sessionState;
    if (!state || state.resultsRecorded) return { ok: false, error: "Already recorded." };

    const seats = Object.values(state.players || {});
    const alive = seats.filter((p) => !p.eliminated);
    // Re-checked rather than trusted: the client was asked, but the answer
    // arrives over a socket and the board may have moved since.
    if (alive.length !== 1 || alive[0].id !== claimantId) {
      return { ok: false, error: "The board changed — nothing recorded." };
    }

    // Set before the writes. A failed write must not leave the game eligible
    // to record itself a second time.
    state.resultsRecorded = true;
    const winnerId = alive[0].id;
    const gameId = `${state.sessionId}:${Date.now()}`;

    // The snapshot every row carries. Guests are in here by name even though
    // no row is written for them — it is the only way history can show a full
    // table while only accounts get records.
    const snapshot = JSON.stringify(
      seats.map((p) => ({
        name: (p.displayName || "Player").slice(0, 20),
        commander: deckKey(p.commanderName, p.commanderName2, p.deckLabel),
        identity: canonicalIdentity((p.colorIdentity || []).join("")) || "C",
        won: p.id === winnerId ? 1 : 0,
      }))
    );

    if (this.env?.DB) {
      for (const seat of seats) {
        const commander = deckKey(seat.commanderName, seat.commanderName2, seat.deckLabel);
        // Guests, and anyone who never named a commander, have nothing to
        // record against.
        if (!seat.userId || !commander) continue;
        try {
          await this.env.DB.prepare(
            `INSERT OR IGNORE INTO game_history
               (user_id, game_id, commander, identity, bracket, won, source, seats)
             VALUES (?, ?, ?, ?, ?, ?, 'game', ?)`
          )
            .bind(
              seat.userId, gameId, commander,
              canonicalIdentity((seat.colorIdentity || []).join("")) || "C",
              Number.isInteger(seat.bracket) ? seat.bracket : null,
              seat.id === winnerId ? 1 : 0, snapshot
            )
            .run();
        } catch (e) {
          // A stat is not worth failing a game over.
          console.error("history write failed:", e?.message || e);
        }
      }
    }

    this.broadcast({ type: "game_over", winnerPlayerId: winnerId });
    await this.persist();
    return { ok: true };
  }

  announceLethal(player) {
    const reason = lethalReason(player);
    if (!reason) {
      // Recovered — a mistyped total or a life-gain trigger. Let it announce
      // again if they go back under.
      player.lethalAnnounced = false;
      return;
    }
    if (player.lethalAnnounced) return;
    player.lethalAnnounced = true;
    this.broadcast({ type: "lethal", playerId: player.id, reason });
  }

  async persist() {
    await this.ctx.storage.put("state", this.sessionState);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Probed by the Worker's /api/create to check whether a randomly
    // generated join code is already taken by a live session.
    if (url.pathname === "/status") {
      const status = this.sessionState ? this.sessionState.status : "empty";
      return Response.json({ status });
    }

    // Take this join code if nothing holds it yet, recording the host's
    // chosen mode. Returns claimed:false when the code is already in use so
    // the Worker can try another one.
    if (url.pathname === "/info") {
      return Response.json({
        exists: !!this.sessionState,
        pinRequired: !!this.sessionState?.pin,
        mode: this.sessionState?.mode ?? null,
      });
    }

    // ── Ask the Oracle: reserve / answer / refund ───────────────────────────
    // Three small steps rather than one, because the allowance has to be spent
    // BEFORE the model call, not after — otherwise two people tapping at once
    // both see "10 left" and both spend. Reserve first, then call Oracle, then
    // either deliver the answer or hand the slot back.
    //
    // Only Enhance's own Worker reaches these paths. The browser cannot: the
    // Durable Object is not addressable from outside, and the Worker is what
    // holds the verified session.
    if (url.pathname === "/oracle/reserve") {
      if (!this.sessionState) return Response.json({ ok: false, error: "No such game." }, { status: 404 });
      this.ensureShape();
      const left = ORACLE_ASKS_PER_GAME - this.sessionState.oracleAsked;
      if (left <= 0) {
        return Response.json({ ok: false, error: "This table has used all its Oracle questions." });
      }
      this.sessionState.oracleAsked += 1;
      await this.persist();
      return Response.json({ ok: true, asksLeft: left - 1 });
    }

    if (url.pathname === "/oracle/refund") {
      if (this.sessionState) {
        this.ensureShape();
        this.sessionState.oracleAsked = Math.max(0, this.sessionState.oracleAsked - 1);
        await this.persist();
      }
      return Response.json({ ok: true });
    }

    // The broadcast. Everything in the payload was obtained by the Worker —
    // the question came from a player, but the ANSWER text is fetched from
    // Oracle server-side and never passes through a client. That's the whole
    // reason this is an HTTP hop instead of a WebSocket message: a client that
    // could hand the table arbitrary prose could hand it anything.
    if (url.pathname === "/oracle/answer") {
      if (!this.sessionState) return Response.json({ ok: false }, { status: 404 });
      const body = await request.json().catch(() => ({}));
      this.broadcast({
        type: "oracle_event",
        kind: "rules",
        askedBy: String(body.askedBy || "").slice(0, 40),
        question: String(body.question || "").slice(0, 400),
        answer: String(body.answer || "").slice(0, 4000),
        rulesCited: Array.isArray(body.rulesCited) ? body.rulesCited.slice(0, 8) : [],
        at: Date.now(),
      });
      this.broadcast({ type: "state_sync", state: this.publicState() });
      return Response.json({ ok: true });
    }

    // The Worker posts a decklist link here after reading it out of D1 and
    // checking the scheme. The DO never takes a URL from a player's socket:
    // the same rule as the Oracle answer and the card lookup — a client can
    // ask for something to be shared, but cannot choose the text that lands
    // on three other people's screens.
    if (url.pathname === "/deck/share") {
      if (!this.sessionState) return Response.json({ ok: false }, { status: 404 });
      const body = await request.json().catch(() => ({}));
      const player = this.sessionState.players[String(body.playerId || "")];
      if (!player) return Response.json({ ok: false, error: "Not at this table." }, { status: 403 });

      let href = "";
      try {
        const parsed = new URL(String(body.url || ""));
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
        href = parsed.toString().slice(0, 500);
      } catch {
        return Response.json({ ok: false, error: "That isn't a web link." }, { status: 400 });
      }

      this.broadcast({
        type: "deck_shared",
        byPlayerId: player.id,
        // From the seat, not from the request — the name on a shared link
        // should be the one the table can see at that seat.
        byName: String(player.displayName || "Someone").slice(0, 20),
        commander: deckKey(player.commanderName, player.commanderName2, player.deckLabel)
          || String(body.commander || "").slice(0, 200),
        url: href,
        at: Date.now(),
      });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/claim") {
      if (this.sessionState) return Response.json({ claimed: false });
      const body = await request.json().catch(() => ({}));
      this.sessionState = initialState(body.code || this.ctx.id.toString(), body.mode, body.pin);
      await this.persist();
      return Response.json({ claimed: true, mode: this.sessionState.mode });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const codeMatch = url.pathname.match(/\/ws\/([A-Z0-9]{4})/i);
    const sessionId = codeMatch ? codeMatch[1].toUpperCase() : this.ctx.id.toString();
    if (!this.sessionState) {
      this.sessionState = initialState(sessionId);
      await this.persist();
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable accept: the DO can be evicted from memory between
    // messages and Cloudflare will wake it on the next inbound frame.
    // Entitlements are read once, here, from the header the Worker set after
    // verifying the session cookie — never from a client message. They ride on
    // the socket's attachment so they survive hibernation along with playerId.
    //
    // A player who buys a palette mid-game reconnects rather than being
    // upgraded in place: the handshake is the only point where anything is
    // verified, so it's also the only honest place to change the answer.
    let entitlements = { all: false, identities: [] };
    try {
      const raw = request.headers.get("X-Entitlements");
      if (raw) {
        const parsed = JSON.parse(raw);
        entitlements = {
          all: parsed.all === true,
          identities: Array.isArray(parsed.identities) ? parsed.identities : [],
        };
      }
    } catch {
      // Malformed header: fall through as owning nothing. Universal sounds
      // still work, so a bad parse costs a palette, never the whole game.
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null, entitlements });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(message, filterFn) {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (filterFn && !filterFn(ws)) continue;
      try {
        ws.send(payload);
      } catch {
        // Socket is dead; webSocketClose will clean up the player state.
      }
    }
  }

  // Every client needs to see WHO triggered WHAT so it can light up that
  // player and that control — independent of which devices actually play the
  // audio, which is why this can't ride along with play_sound.
  announceActivity(playerId, soundId) {
    this.broadcast({ type: "sound_activity", playerId, soundId });
  }

  // Table-wide sounds (ambient music, board wipe): one device in colocated
  // mode, every device in remote mode. The single place that decision lives.
  playShared(message) {
    const payload = { type: "play_sound", ...message };
    if (this.sessionState.mode === "remote") this.broadcast(payload);
    else this.sendToPlayer(this.sessionState.hostId, payload);
  }

  sendToPlayer(playerId, message) {
    if (!playerId) return;
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.playerId === playerId) {
        try {
          ws.send(payload);
        } catch {
          // ignore
        }
      }
    }
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    const att = ws.deserializeAttachment() || {};
    this.ensureShape();

    switch (msg.type) {
      case "join": {
        const existing = msg.playerId ? this.sessionState.players[msg.playerId] : null;

        // Someone already holding a seat is reconnecting, not joining, so
        // they aren't asked for the PIN again — their player id is a UUID
        // they can only have got by being let in once already.
        if (this.sessionState.pin && !existing && msg.pin !== this.sessionState.pin) {
          ws.send(JSON.stringify({ type: "error", code: "bad_pin", message: "That PIN doesn't match." }));
          return;
        }

        let playerId;

        if (existing) {
          // Reconnect: same device rejoining after a dropped socket.
          playerId = existing.id;
          existing.connected = true;
          if (msg.displayName) existing.displayName = msg.displayName.slice(0, 20);
          // 40 used to be the cap here. A double-faced card's own name runs to
          // 47 characters, so the first Aang deck to sit down would have been
          // cut in half by it.
          if (msg.commanderName !== undefined) existing.commanderName = msg.commanderName.slice(0, NAME_MAX);
          if (msg.commanderName2 !== undefined) existing.commanderName2 = String(msg.commanderName2 || "").slice(0, NAME_MAX);
          if (msg.deckLabel !== undefined) existing.deckLabel = String(msg.deckLabel || "").slice(0, LABEL_MAX);
          if (msg.commanderIdentities !== undefined) {
            existing.commanderIdentities = cleanIdentities(msg.commanderIdentities);
          }
          if (Array.isArray(msg.colorIdentity)) existing.colorIdentity = msg.colorIdentity.slice(0, 5);
          existing.bracket = validBracket(msg.bracket);
        } else {
          playerId = crypto.randomUUID();
          const isFirstPlayer = Object.keys(this.sessionState.players).length === 0;
          this.sessionState.players[playerId] = {
            id: playerId,
            displayName: (msg.displayName || "Player").slice(0, 20),
            commanderName: (msg.commanderName || "").slice(0, NAME_MAX),
            // Partner, Partner with, Friends forever, Choose a Background,
            // Doctor's companion — the format allows two, and never more.
            commanderName2: String(msg.commanderName2 || "").slice(0, NAME_MAX),
            deckLabel: String(msg.deckLabel || "").slice(0, LABEL_MAX),
            // Each commander's OWN colours. The union is in colorIdentity;
            // these are what decide which palettes a partner deck may use, so
            // a Gruul commander beside a Dimir one gets both rather than
            // needing its owner to have bought "UBRG".
            commanderIdentities: cleanIdentities(msg.commanderIdentities),
            colorIdentity: Array.isArray(msg.colorIdentity) ? msg.colorIdentity.slice(0, 5) : [],
            // 1-5, or null for "didn't say". Recorded with the game result.
            bracket: validBracket(msg.bracket),
            lifeTotal: 40,
            isHost: isFirstPlayer,
            connected: true,
            muted: false,
            // Keyed "<playerId>:<slot>" — by the COMMANDER that dealt it, not
            // by the player, since the 21 threshold is per-commander and a
            // player may have two.
            commanderDamage: {},
            poison: 0,
            // Times cast from the command zone, per commander: each one has
            // its own tax. The tax is twice its own count.
            commanderCasts: { 0: 0, 1: 0 },
            lethalAnnounced: false,
            // Explicit, never inferred: a player at 0 life may still be in the
            // game, and a player at 40 may have decked out or conceded.
            eliminated: false,
          };
          if (isFirstPlayer) this.sessionState.hostId = playerId;
          this.sessionState.turnOrder.push(playerId);
          if (isFirstPlayer) this.sessionState.turnStartedAt = Date.now();
        }

        this.sessionState.status = "active";
        // Spread the existing attachment, don't replace it: entitlements were
        // put there at the handshake and a bare { playerId } would erase them,
        // quietly turning every paying player into a free one on join.
        ws.serializeAttachment({ ...att, playerId });
        // Copied onto the seat so the result can be recorded at game end,
        // when the socket that carried it may be long gone. Guests carry null
        // and are simply not recorded.
        this.sessionState.players[playerId].userId = att.entitlements?.userId || null;
        await this.persist();

        // Tell this client its assigned playerId (new joins only need
        // this, but sending it on reconnect too keeps the client simple).
        ws.send(JSON.stringify({ type: "joined", playerId }));
        this.broadcast({ type: "state_sync", state: this.publicState() });
        break;
      }

      case "life_delta": {
        const player = this.sessionState.players[att.playerId];
        if (!player || typeof msg.delta !== "number") return;
        player.lifeTotal += msg.delta;
        await this.persist();
        this.broadcast({ type: "life_update", playerId: player.id, lifeTotal: player.lifeTotal });
        this.announceLethal(player);
        break;
      }

      case "undo_life": {
        // The guards live in src/life-undo.js so they can be tested without a
        // live Durable Object: unknown or already-used, someone else's change,
        // or past the window.
        const verdict = undoDecision(this.recentLife, msg.eventId, att.playerId);
        if (!verdict.ok) {
          // An expired entry is dropped on the way past; a rejection is
          // otherwise silent, because the button is already gone on their
          // screen and there is nothing for them to do about it.
          if (verdict.reason === "expired") this.recentLife.delete(String(msg.eventId));
          return;
        }
        const entry = verdict.entry;
        // Single use: spent the moment it is honoured, so a replayed message
        // cannot drain a life total in a loop.
        this.recentLife.delete(String(msg.eventId));

        const undoTarget = this.sessionState.players[entry.targetId];
        if (!undoTarget) return;
        undoTarget.lifeTotal -= entry.delta;
        await this.persist();

        this.broadcast({ type: "life_update", playerId: undoTarget.id, lifeTotal: undoTarget.lifeTotal });
        // The table is told, because a number moving twice with no explanation
        // is how four people end up disagreeing about the board.
        this.broadcast({
          type: "life_undone",
          playerId: undoTarget.id,
          name: String(undoTarget.displayName || "Someone").slice(0, 20),
          delta: entry.delta,
        });
        this.announceLethal(undoTarget);
        break;
      }

      case "life_event": {
        // Covers Deal Damage's three flavors — gaining life, losing life,
        // and taking damage — since they only differ in the delta's sign
        // and which sound plays, not in how targets are resolved.
        const amount = Number(msg.amount);
        if (!amount || amount <= 0) return;
        const kind = msg.kind === "gain" ? "gain" : msg.kind === "loss" ? "loss" : "damage";
        const delta = kind === "gain" ? amount : -amount;
        const soundId = kind === "gain" ? "life_gain" : kind === "loss" ? "life_loss" : "damage";

        let targets = [];
        if (msg.scope === "all") {
          // Everyone at the table, including whoever pressed it — for
          // board-wide effects like "each player takes 1 damage".
          targets = Object.values(this.sessionState.players);
        } else if (msg.scope === "opponents") {
          targets = Object.values(this.sessionState.players).filter((p) => p.id !== att.playerId);
        } else if (msg.scope === "single" && msg.targetPlayerId) {
          // Deliberately allowed to target yourself — fetch lands,
          // painlands, and other self-inflicted life loss need this.
          const target = this.sessionState.players[msg.targetPlayerId];
          if (target) targets = [target];
        }
        if (targets.length === 0) return;

        for (const target of targets) {
          target.lifeTotal += delta;
        }
        await this.persist();

        this.announceActivity(att.playerId, "life_event");

        // Whoever pressed Apply gets a confirmation sound even when they
        // aren't one of the targets — otherwise dealing damage to three
        // opponents is completely silent on your own device.
        if (!targets.some((t) => t.id === att.playerId)) {
          this.sendToPlayer(att.playerId, { type: "play_sound", soundId, fromPlayerId: att.playerId });
        }

        const actorName = String(
          this.sessionState.players[att.playerId]?.displayName || "Someone"
        ).slice(0, 20);

        for (const target of targets) {
          this.broadcast({ type: "life_update", playerId: target.id, lifeTotal: target.lifeTotal });
          this.announceLethal(target);
          // Only the affected player's own device plays the sound,
          // regardless of colocated/remote mode — true whether this is a
          // single target or one of a group hit by the same event.
          this.sendToPlayer(target.id, {
            type: "play_sound",
            soundId,
            fromPlayerId: att.playerId,
          });
          this.announceLethal(target);

          // Somebody else moved your number. You get a few seconds to put it
          // back — no acknowledgement required, nothing blocked, and the table
          // carries on either way. A change you made to yourself needs no undo
          // button: the other arrow is right there.
          if (target.id !== att.playerId) {
            const eventId = rememberLifeChange(this.recentLife, target.id, delta);
            this.sendToPlayer(target.id, {
              type: "life_changed_by",
              eventId,
              byPlayerId: att.playerId,
              byName: actorName,
              delta,
            });
          }
        }
        break;
      }

      case "trigger_broadcast": {
        // Any player can press Board Wipe — colocated rule means only the
        // host's device actually plays it, and the cooldown is session-wide
        // (not per-player) so it doesn't fire repeatedly in quick succession.
        const result = checkCooldown(this.sessionState, "broadcast", "broadcast");
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "cooldown_rejected", soundId: "broadcast", remainingMs: result.remainingMs }));
          return;
        }
        await this.persist();
        // Broadcast the cooldown to everyone, not just the presser — since
        // it's shared, every screen should grey out the button together.
        this.broadcast({ type: "cooldown_started", soundId: "broadcast", remainingMs: COOLDOWNS_MS.broadcast });
        this.playShared({ soundId: "broadcast", fromPlayerId: att.playerId });
        this.announceActivity(att.playerId, "broadcast");
        break;
      }

      case "trigger_draw_card": {
        // Self-triggered, no cooldown — drawing happens too often per turn
        // to gate it the way Taunt or Board Wipe are gated.
        this.sendToPlayer(att.playerId, {
          type: "play_sound",
          soundId: "draw_card",
          fromPlayerId: att.playerId,
        });
        this.announceActivity(att.playerId, "draw_card");
        break;
      }

      case "trigger_ambient": {
        const player = this.sessionState.players[att.playerId];
        if (!player) return;
        this.sessionState.ambientActivePlayerId = msg.on ? player.id : null;
        await this.persist();
        // Broadcast the change to everyone so all screens show whose
        // ambient is live, even though only the host's device plays it.
        this.broadcast({ type: "ambient_changed", playerId: this.sessionState.ambientActivePlayerId });
        this.playShared({
          soundId: msg.on ? "ambient_on" : "ambient_off",
          fromPlayerId: player.id,
          colorIdentity: player.colorIdentity,
        });
        this.announceActivity(player.id, "ambient");
        break;
      }

      case "trigger_taunt": {
        const result = checkCooldown(this.sessionState, "taunt", `${att.playerId}:taunt`);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "cooldown_rejected", soundId: "taunt", remainingMs: result.remainingMs }));
          return;
        }
        await this.persist();
        // Self-triggered: only your own device plays it.
        this.sendToPlayer(att.playerId, {
          type: "play_sound",
          soundId: "taunt",
          fromPlayerId: att.playerId,
        });
        this.announceActivity(att.playerId, "taunt");
        break;
      }

      case "commander_damage": {
        // Recorded on the player taking it, keyed by the commander's
        // controller. Combat damage from a commander also costs life, so this
        // moves both together rather than making players do it twice.
        const target = this.sessionState.players[msg.targetPlayerId];
        const source = this.sessionState.players[msg.sourcePlayerId];
        const delta = Number(msg.delta);
        if (!target || !source || !Number.isFinite(delta) || delta === 0) return;

        // Which of the source player's commanders dealt it. Absent means the
        // first, so a client that predates partners keeps working unchanged.
        const slot = msg.sourceSlot === 1 && source.commanderName2 ? 1 : 0;
        const bucket = damageKey(source.id, slot);

        const current = target.commanderDamage[bucket] ?? 0;
        const next = Math.max(0, current + delta);
        const applied = next - current; // clamped at zero, so life matches
        if (applied === 0) return;

        target.commanderDamage[bucket] = next;
        target.lifeTotal -= applied;
        await this.persist();

        this.broadcast({ type: "life_update", playerId: target.id, lifeTotal: target.lifeTotal });
        this.broadcast({ type: "state_sync", state: this.publicState() });
        if (applied > 0) {
          this.sendToPlayer(target.id, {
            type: "play_sound",
            soundId: "damage",
            fromPlayerId: att.playerId,
          });
          this.announceActivity(att.playerId, "commander_damage");
        }
        this.announceLethal(target);
        break;
      }

      case "commander_casts": {
        const target = this.sessionState.players[msg.targetPlayerId] ?? this.sessionState.players[att.playerId];
        const delta = Number(msg.delta);
        if (!target || !Number.isFinite(delta) || delta === 0) return;
        const slot = msg.slot === 1 && target.commanderName2 ? 1 : 0;
        const casts = target.commanderCasts || (target.commanderCasts = { 0: 0, 1: 0 });
        casts[slot] = Math.max(0, (casts[slot] ?? 0) + delta);
        await this.persist();
        this.broadcast({ type: "state_sync", state: this.publicState() });
        break;
      }

      case "set_table_state": {
        // Monarch and initiative move around the table; passing them to
        // whoever already holds it hands it back to nobody.
        const field = msg.which === "initiative" ? "initiativePlayerId" : "monarchPlayerId";
        const wanted = msg.playerId && this.sessionState.players[msg.playerId] ? msg.playerId : null;
        this.sessionState[field] = this.sessionState[field] === wanted ? null : wanted;
        await this.persist();
        this.broadcast({ type: "state_sync", state: this.publicState() });
        break;
      }

      case "poison": {
        const target = this.sessionState.players[msg.targetPlayerId] ?? this.sessionState.players[att.playerId];
        const delta = Number(msg.delta);
        if (!target || !Number.isFinite(delta) || delta === 0) return;
        target.poison = Math.max(0, Math.min(POISON_LETHAL, (target.poison ?? 0) + delta));
        await this.persist();
        this.broadcast({ type: "state_sync", state: this.publicState() });
        this.announceLethal(target);
        break;
      }

      case "set_eliminated": {
        const target = this.sessionState.players[msg.targetPlayerId];
        if (!target) return;
        const next = !!msg.eliminated;
        if (target.eliminated === next) return;
        target.eliminated = next;

        // Their seat stays in turnOrder so bringing them back needs no
        // reshuffle; passing simply steps over them while they're out.
        if (next && activePlayerId(this.sessionState) === target.id) {
          const order = this.sessionState.turnOrder.filter((id) => this.sessionState.players[id]);
          this.sessionState.turnOrder = order;
          this.sessionState.activePlayerIndex = nextSeat(order, target.id, this.sessionState.players);
          this.sessionState.turnStartedAt = Date.now();
          this.broadcast({
            type: "turn_changed",
            activePlayerId: activePlayerId(this.sessionState),
            turnStartedAt: this.sessionState.turnStartedAt,
          });
        }
        await this.offerWinIfOver();
        await this.persist();
        this.broadcast({ type: "state_sync", state: this.publicState() });

        // If they already crossed a lethal threshold they just heard this a
        // moment ago, so don't play it twice for the same exit.
        if (next && !target.lethalAnnounced) {
          target.lethalAnnounced = true;
          this.broadcast({ type: "lethal", playerId: target.id, reason: "eliminated" });
        } else if (!next) {
          target.lethalAnnounced = false;
        }
        break;
      }

      case "trigger_targeted": {
        // Taunt and poke aimed at one player: it plays on their device and on
        // the sender's, so both ends of the exchange hear it.
        const target = this.sessionState.players[msg.targetPlayerId];
        if (!target) return;
        const soundId = msg.soundId === "poke" ? "poke" : "taunt";

        if (soundId === "poke" && !canPoke(this.sessionState, target.id)) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Poke is only available once the active player has been on their turn a minute.",
          }));
          return;
        }

        const result = checkCooldown(this.sessionState, soundId, `${att.playerId}:${soundId}:${target.id}`);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "cooldown_rejected", soundId, remainingMs: result.remainingMs }));
          return;
        }
        await this.persist();

        const payload = { type: "play_sound", soundId, fromPlayerId: att.playerId, targetPlayerId: target.id };
        this.sendToPlayer(target.id, payload);
        if (target.id !== att.playerId) this.sendToPlayer(att.playerId, payload);
        this.announceActivity(att.playerId, soundId);
        break;
      }

      case "trigger_library_sound": {
        // Sounds chosen from the full board. Table-wide, like the board wipe:
        // one device in a local game, every device in a remote one.
        const soundId = String(msg.soundId || "").slice(0, 40);
        if (!soundId) return;

        // The board hides locked palettes, but hiding a button is not a
        // control — this message can be sent by hand down an open socket. The
        // entitlements consulted here came from the Worker's verification at
        // the handshake, and the identity comes from this session's own player
        // record, so nothing in this decision is client-supplied except the
        // sound id itself.
        const player = this.sessionState.players[att.playerId];
        // The deck's whole identity decides what the board could use; each
        // commander's own identity decides which palettes the player must own.
        const board = {
          identity: canonicalIdentity((player?.colorIdentity || []).join("")) || "C",
          commanders: player?.commanderIdentities || [],
        };
        if (!soundAllowed(soundId, att.entitlements, board)) {
          ws.send(JSON.stringify({ type: "sound_locked", soundId }));
          return;
        }

        const result = checkCooldown(this.sessionState, soundId, `${att.playerId}:${soundId}`);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "cooldown_rejected", soundId, remainingMs: result.remainingMs }));
          return;
        }
        this.playShared({ soundId, fromPlayerId: att.playerId });
        this.announceActivity(att.playerId, "library");
        break;
      }

      // "What's that card do?" — the question people currently answer by
      // holding a card up to a webcam.
      //
      // Only a Scryfall id crosses the wire. Not the name, not the oracle
      // text, not the image: every client fetches the card from Scryfall
      // itself and renders what Scryfall returns. That makes it impossible to
      // put arbitrary text on another player's screen through this path — the
      // worst a forged id can do is fail to resolve — and it costs no model
      // tokens at all, because no model is involved.
      //
      // Scryfall blocks Cloudflare Worker IPs, which is why the lookup happens
      // in the browser and not here.
      case "oracle_card": {
        const id = String(msg.scryfallId || "");
        // Scryfall ids are UUIDs. Anything else never reaches another client.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
        const asker = this.sessionState.players[att.playerId];
        this.broadcast({
          type: "oracle_event",
          kind: "card",
          scryfallId: id,
          askedBy: (asker?.displayName || "").slice(0, 20),
          at: Date.now(),
        });
        break;
      }

      // The last player standing answering the confirm_win prompt. "No" is a
      // real answer: it leaves the game unrecorded rather than guessing, and
      // closes the offer so they aren't asked again every time someone toggles
      // an elimination.
      case "claim_win": {
        if (!msg.won) {
          this.sessionState.resultsRecorded = true;
          await this.persist();
          break;
        }
        const result = await this.recordResult(att.playerId);
        if (!result.ok) ws.send(JSON.stringify({ type: "error", message: result.error }));
        break;
      }

      case "set_muted": {
        const player = this.sessionState.players[att.playerId];
        if (!player) return;
        // Muting is local to the device, but it's shared so the rest of the
        // table can see who won't hear their sound effects.
        player.muted = !!msg.muted;
        await this.persist();
        this.broadcast({ type: "state_sync", state: this.publicState() });
        break;
      }

      case "pass_turn": {
        const order = this.sessionState.turnOrder.filter((id) => this.sessionState.players[id]);
        if (order.length === 0) return;
        // Only the active player may pass, so two people tapping at once
        // can't skip someone.
        if (activePlayerId(this.sessionState) !== att.playerId) return;

        const fromId = att.playerId;
        this.sessionState.turnOrder = order;

        // The passer may name who they're passing to, so a player who is out
        // can be skipped. Deliberately never automatic: a player at 0 life may
        // still be in the game (Platinum Angel, Phyrexian Unlife, Lich's
        // Mastery), so skipping is a human decision, not an inference.
        const explicit = msg.toPlayerId && order.includes(msg.toPlayerId) ? msg.toPlayerId : null;
        this.sessionState.activePlayerIndex = explicit
          ? order.indexOf(explicit)
          : nextSeat(order, fromId, this.sessionState.players);
        this.sessionState.turnStartedAt = Date.now();
        await this.persist();

        const toId = activePlayerId(this.sessionState);
        this.broadcast({
          type: "turn_changed",
          activePlayerId: toId,
          turnStartedAt: this.sessionState.turnStartedAt,
        });
        // The handoff is heard by the two people it concerns, not the table.
        const payload = { type: "play_sound", soundId: "pass_turn", fromPlayerId: fromId };
        this.sendToPlayer(fromId, payload);
        if (toId && toId !== fromId) this.sendToPlayer(toId, payload);
        this.announceActivity(fromId, "pass_turn");
        break;
      }

      case "set_turn_order": {
        if (att.playerId !== this.sessionState.hostId) return;
        if (!Array.isArray(msg.order)) return;
        // Keep only real players, then append anyone the client left out, so
        // a stale client can never drop someone from the rotation.
        const seen = new Set();
        const order = msg.order.filter((id) => {
          if (!this.sessionState.players[id] || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        for (const id of Object.keys(this.sessionState.players)) {
          if (!seen.has(id)) order.push(id);
        }
        const stayActive = activePlayerId(this.sessionState);
        this.sessionState.turnOrder = order;
        const idx = order.indexOf(stayActive);
        this.sessionState.activePlayerIndex = idx === -1 ? 0 : idx;
        await this.persist();
        this.broadcast({ type: "state_sync", state: this.publicState() });
        break;
      }

      default:
        ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    const player = att?.playerId ? this.sessionState?.players[att.playerId] : null;
    if (player) {
      player.connected = false;
      // Their seat, life total, commander and place in the rotation all stay —
      // closing a browser is a disconnect, not leaving the table.
      await this.persist();
      this.broadcast({ type: "state_sync", state: this.publicState() });
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
