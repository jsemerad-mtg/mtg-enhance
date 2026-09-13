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
  };
}

// Poke is a "hurry up" nudge, so it's only allowed against the player who is
// actually holding the table up: the active player, one minute into their turn.
const POKE_MIN_TURN_MS = 60000;

// The two non-life loss conditions. 21 combat damage from a single commander,
// or 10 poison counters, and you're out.
const COMMANDER_DAMAGE_LETHAL = 21;
const POISON_LETHAL = 10;

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
    if (typeof state.activePlayerIndex !== "number") state.activePlayerIndex = 0;
    if (typeof state.turnStartedAt !== "number") state.turnStartedAt = Date.now();
    for (const player of Object.values(state.players || {})) {
      if (typeof player.muted !== "boolean") player.muted = false;
      if (!player.commanderDamage || typeof player.commanderDamage !== "object") player.commanderDamage = {};
      if (typeof player.poison !== "number") player.poison = 0;
    }
  }

  // state_sync goes to every connected client, so the PIN has to be stripped
  // before it ever goes out on the wire.
  publicState() {
    const { pin, ...rest } = this.sessionState;
    return { ...rest, pinRequired: pin !== null };
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
            muted: false,
            // Keyed by the id of the player whose commander dealt it, since
            // the 21 threshold is per-commander, not cumulative.
            commanderDamage: {},
            poison: 0,
          };
          if (isFirstPlayer) this.sessionState.hostId = playerId;
          this.sessionState.turnOrder.push(playerId);
          if (isFirstPlayer) this.sessionState.turnStartedAt = Date.now();
        }

        this.sessionState.status = "active";
        ws.serializeAttachment({ playerId });
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

        const current = target.commanderDamage[source.id] ?? 0;
        const next = Math.max(0, current + delta);
        const applied = next - current; // clamped at zero, so life matches
        if (applied === 0) return;

        target.commanderDamage[source.id] = next;
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
        if (next >= COMMANDER_DAMAGE_LETHAL) {
          this.broadcast({
            type: "lethal",
            playerId: target.id,
            reason: "commander",
            sourcePlayerId: source.id,
          });
        }
        break;
      }

      case "poison": {
        const target = this.sessionState.players[msg.targetPlayerId] ?? this.sessionState.players[att.playerId];
        const delta = Number(msg.delta);
        if (!target || !Number.isFinite(delta) || delta === 0) return;
        target.poison = Math.max(0, Math.min(POISON_LETHAL, (target.poison ?? 0) + delta));
        await this.persist();
        this.broadcast({ type: "state_sync", state: this.publicState() });
        if (target.poison >= POISON_LETHAL) {
          this.broadcast({ type: "lethal", playerId: target.id, reason: "poison" });
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
        const result = checkCooldown(this.sessionState, soundId, `${att.playerId}:${soundId}`);
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "cooldown_rejected", soundId, remainingMs: result.remainingMs }));
          return;
        }
        this.playShared({ soundId, fromPlayerId: att.playerId });
        this.announceActivity(att.playerId, "library");
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
        this.sessionState.activePlayerIndex =
          (order.indexOf(fromId) + 1) % order.length;
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
