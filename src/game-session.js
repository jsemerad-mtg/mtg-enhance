import { DurableObject } from "cloudflare:workers";

// Colocated-only for this proof of concept: ambient + broadcast sounds
// always route to the host's device only. A `mode` field is kept on
// state now so remote mode (everyone hears ambient/broadcast) is a
// routing-logic change later, not a schema change.
const TAUNT_COOLDOWN_MS = 8000;

function initialState(sessionId) {
  return {
    sessionId,
    mode: "colocated",
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

      case "damage_player": {
        const target = this.sessionState.players[msg.targetPlayerId];
        if (!target || typeof msg.amount !== "number") return;
        target.lifeTotal -= msg.amount;
        await this.persist();
        this.broadcast({ type: "life_update", playerId: target.id, lifeTotal: target.lifeTotal });
        // Targeted sound: only the damaged player's own device plays it,
        // regardless of colocated/remote mode.
        this.sendToPlayer(target.id, {
          type: "play_sound",
          soundId: "targeted",
          fromPlayerId: att.playerId,
        });
        break;
      }

      case "trigger_broadcast": {
        // Any player can press "Wrath" — colocated rule means only the
        // host's device actually plays it, so it doesn't double up
        // across phones sitting a foot apart on the table.
        this.sendToPlayer(this.sessionState.hostId, {
          type: "play_sound",
          soundId: "broadcast",
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
        this.sendToPlayer(this.sessionState.hostId, {
          type: "play_sound",
          soundId: msg.on ? "ambient_on" : "ambient_off",
          fromPlayerId: player.id,
          colorIdentity: player.colorIdentity,
        });
        break;
      }

      case "trigger_taunt": {
        const key = `${att.playerId}:taunt`;
        const last = this.sessionState.cooldowns[key] ?? 0;
        const now = Date.now();
        if (now - last < TAUNT_COOLDOWN_MS) {
          ws.send(
            JSON.stringify({
              type: "cooldown_rejected",
              soundId: "taunt",
              remainingMs: TAUNT_COOLDOWN_MS - (now - last),
            })
          );
          return;
        }
        this.sessionState.cooldowns[key] = now;
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
