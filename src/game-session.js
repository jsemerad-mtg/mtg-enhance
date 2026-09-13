import { DurableObject } from "cloudflare:workers";

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

function initialState(sessionId, mode = "colocated") {
  return {
    sessionId,
    mode: mode === "remote" ? "remote" : "colocated",
    players: {}, // playerId -> PlayerState
    hostId: null,
    ambientActivePlayerId: null,
    cooldowns: {}, // "playerId:soundId" -> last-triggered timestamp (ms)
    status: "lobby", // lobby | active
  };
}

export class GameSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sessionState = null;
    // Rehydrate from storage before handling any request — the DO may
    // have hibernated and lost its in-memory state between messages.
    ctx.blockConcurrencyWhile(async () => {
      this.sessionState = (await ctx.storage.get("state")) ?? null;
    });
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
    if (url.pathname === "/claim") {
      if (this.sessionState) return Response.json({ claimed: false });
      const body = await request.json().catch(() => ({}));
      this.sessionState = initialState(body.code || this.ctx.id.toString(), body.mode);
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
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null });

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

    switch (msg.type) {
      case "join": {
        const existing = msg.playerId ? this.sessionState.players[msg.playerId] : null;
        let playerId;

        if (existing) {
          // Reconnect: same device rejoining after a dropped socket.
          playerId = existing.id;
          existing.connected = true;
          if (msg.displayName) existing.displayName = msg.displayName.slice(0, 20);
          if (msg.commanderName !== undefined) existing.commanderName = msg.commanderName.slice(0, 40);
          if (Array.isArray(msg.colorIdentity)) existing.colorIdentity = msg.colorIdentity.slice(0, 5);
        } else {
          playerId = crypto.randomUUID();
          const isFirstPlayer = Object.keys(this.sessionState.players).length === 0;
          this.sessionState.players[playerId] = {
            id: playerId,
            displayName: (msg.displayName || "Player").slice(0, 20),
            commanderName: (msg.commanderName || "").slice(0, 40),
            colorIdentity: Array.isArray(msg.colorIdentity) ? msg.colorIdentity.slice(0, 5) : [],
            lifeTotal: 40,
            isHost: isFirstPlayer,
            connected: true,
          };
          if (isFirstPlayer) this.sessionState.hostId = playerId;
        }

        this.sessionState.status = "active";
        ws.serializeAttachment({ playerId });
        await this.persist();

        // Tell this client its assigned playerId (new joins only need
        // this, but sending it on reconnect too keeps the client simple).
        ws.send(JSON.stringify({ type: "joined", playerId }));
        this.broadcast({ type: "state_sync", state: this.sessionState });
        break;
      }

      case "life_delta": {
        const player = this.sessionState.players[att.playerId];
        if (!player || typeof msg.delta !== "number") return;
        player.lifeTotal += msg.delta;
        await this.persist();
        this.broadcast({ type: "life_update", playerId: player.id, lifeTotal: player.lifeTotal });
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

        for (const target of targets) {
          this.broadcast({ type: "life_update", playerId: target.id, lifeTotal: target.lifeTotal });
          // Only the affected player's own device plays the sound,
          // regardless of colocated/remote mode — true whether this is a
          // single target or one of a group hit by the same event.
          this.sendToPlayer(target.id, {
            type: "play_sound",
            soundId,
            fromPlayerId: att.playerId,
          });
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
      await this.persist();
      this.broadcast({ type: "state_sync", state: this.sessionState });
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
