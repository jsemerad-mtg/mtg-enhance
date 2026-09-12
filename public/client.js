// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const screens = {
  home: $("#screen-home"),
  lobby: $("#screen-lobby"),
  game: $("#screen-game"),
};
function showScreen(name) {
  for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
}

// ---------- placeholder audio (synthesized — no sound files yet) ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function tone({ freq, duration, type = "sine", gain = 0.2, delay = 0 }) {
  const ctx = ensureAudio();
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  amp.gain.value = 0;
  osc.connect(amp).connect(ctx.destination);
  const start = ctx.currentTime + delay;
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(gain, start + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.001, start + duration);
  osc.start(start);
  osc.stop(start + duration + 0.05);
  return osc;
}

// Board wipe: a dramatic descending three-note chord.
function playBroadcast() {
  [523, 392, 262].forEach((freq, i) => tone({ freq, duration: 0.9, type: "sawtooth", gain: 0.15, delay: i * 0.12 }));
}

// Targeted damage: a short sharp hit.
function playTargeted() {
  tone({ freq: 140, duration: 0.25, type: "square", gain: 0.25 });
}

// Self taunt: a quick two-note blip.
function playTaunt() {
  tone({ freq: 660, duration: 0.12, type: "triangle", gain: 0.2 });
  tone({ freq: 880, duration: 0.15, type: "triangle", gain: 0.2, delay: 0.1 });
}

// Ambient: a low sustained drone, per color identity (root note shifts by color).
const AMBIENT_ROOT = { W: 261, U: 233, B: 196, R: 220, G: 246 };
let ambientOsc = null;
let ambientGain = null;
function playAmbientOn(colorIdentity) {
  stopAmbient();
  const ctx = ensureAudio();
  const root = AMBIENT_ROOT[colorIdentity?.[0]] || 220;
  ambientOsc = ctx.createOscillator();
  ambientGain = ctx.createGain();
  ambientOsc.type = "sine";
  ambientOsc.frequency.value = root;
  ambientGain.gain.value = 0;
  ambientOsc.connect(ambientGain).connect(ctx.destination);
  ambientOsc.start();
  ambientGain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 1.2);
}
function stopAmbient() {
  if (ambientOsc) {
    const ctx = ensureAudio();
    ambientGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
    ambientOsc.stop(ctx.currentTime + 0.9);
    ambientOsc = null;
    ambientGain = null;
  }
}

// ---------- session state ----------
let ws = null;
let code = null;
let selfId = null;
let session = { players: {}, hostId: null, ambientActivePlayerId: null };
let ambientIsMine = false;
let tauntTimer = null;

function storageKey(c) {
  return `mtge:${c}`;
}
function loadStored(c) {
  try {
    return JSON.parse(localStorage.getItem(storageKey(c)) || "null");
  } catch {
    return null;
  }
}
function saveStored(c, data) {
  localStorage.setItem(storageKey(c), JSON.stringify(data));
}

// ---------- rendering ----------
function render() {
  const self = session.players[selfId];
  if (!self) return;

  $("#game-code").textContent = code;
  $("#self-name").textContent = self.displayName;
  $("#self-life").textContent = self.lifeTotal;
  $("#host-badge").hidden = !self.isHost;

  const opponents = Object.values(session.players).filter((p) => p.id !== selfId);

  $("#opponents").innerHTML = opponents
    .map((p) => {
      const dots = (p.colorIdentity || []).map((c) => `<span class="color-dot color-${c.toLowerCase()}"></span>`).join("");
      const dead = p.lifeTotal <= 0 ? "dead" : "";
      return `<div class="opponent-row">
        <span class="opponent-name"><span class="${dead}">${escapeHtml(p.displayName)}</span> ${dots}</span>
        <span class="opponent-life">${p.lifeTotal}</span>
      </div>`;
    })
    .join("");

  const select = $("#select-target");
  const prevValue = select.value;
  select.innerHTML = opponents.map((p) => `<option value="${p.id}">${escapeHtml(p.displayName)}</option>`).join("");
  if (opponents.some((p) => p.id === prevValue)) select.value = prevValue;

  ambientIsMine = session.ambientActivePlayerId === selfId;
  $("#btn-ambient").classList.toggle("active", !!session.ambientActivePlayerId);
  $("#btn-ambient .sound-sub").textContent = session.ambientActivePlayerId
    ? `playing: ${session.players[session.ambientActivePlayerId]?.displayName || "—"}`
    : "toggle your soundscape";
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- WebSocket ----------
function connectAndJoin(joinCode, lobbyInfo) {
  code = joinCode.toUpperCase();
  const stored = loadStored(code) || {};
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws/${code}`);

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "join",
        playerId: stored.playerId || null,
        displayName: lobbyInfo.displayName ?? stored.displayName,
        commanderName: lobbyInfo.commanderName ?? stored.commanderName,
        colorIdentity: lobbyInfo.colorIdentity ?? stored.colorIdentity,
      })
    );
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "joined": {
        selfId = msg.playerId;
        saveStored(code, {
          playerId: selfId,
          displayName: lobbyInfo.displayName ?? stored.displayName,
          commanderName: lobbyInfo.commanderName ?? stored.commanderName,
          colorIdentity: lobbyInfo.colorIdentity ?? stored.colorIdentity,
        });
        showScreen("game");
        break;
      }
      case "state_sync": {
        session.players = msg.state.players;
        session.hostId = msg.state.hostId;
        session.ambientActivePlayerId = msg.state.ambientActivePlayerId;
        render();
        break;
      }
      case "life_update": {
        if (session.players[msg.playerId]) {
          session.players[msg.playerId].lifeTotal = msg.lifeTotal;
          render();
        }
        break;
      }
      case "ambient_changed": {
        session.ambientActivePlayerId = msg.playerId;
        render();
        break;
      }
      case "play_sound": {
        if (msg.soundId === "broadcast") playBroadcast();
        if (msg.soundId === "targeted") playTargeted();
        if (msg.soundId === "taunt") playTaunt();
        if (msg.soundId === "ambient_on") playAmbientOn(msg.colorIdentity);
        if (msg.soundId === "ambient_off") stopAmbient();
        break;
      }
      case "cooldown_rejected": {
        if (msg.soundId === "taunt") showTauntCooldown(msg.remainingMs);
        break;
      }
      case "error": {
        console.warn("Server error:", msg.message);
        break;
      }
    }
  });

  ws.addEventListener("close", () => {
    // Proof-of-concept: no auto-reconnect UI yet. Reloading the page with
    // the same join code will rejoin using the stored playerId.
  });
}

function showTauntCooldown(remainingMs) {
  const btn = $("#btn-taunt");
  const sub = $("#taunt-sub");
  btn.disabled = true;
  clearInterval(tauntTimer);
  const end = Date.now() + remainingMs;
  tauntTimer = setInterval(() => {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(tauntTimer);
      btn.disabled = false;
      sub.textContent = "8s cooldown";
    } else {
      sub.textContent = `wait ${left}s`;
    }
  }, 200);
}

// ---------- screen wiring ----------
let pendingCode = null;

$("#btn-host").addEventListener("click", async () => {
  ensureAudio();
  $("#home-error").hidden = true;
  try {
    const res = await fetch("/api/create", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create a game");
    enterLobby(data.code);
  } catch (err) {
    $("#home-error").textContent = err.message;
    $("#home-error").hidden = false;
  }
});

$("#form-join").addEventListener("submit", (e) => {
  e.preventDefault();
  ensureAudio();
  const value = $("#input-code").value.trim().toUpperCase();
  if (value.length !== 4) {
    $("#home-error").textContent = "Enter the 4-character table code.";
    $("#home-error").hidden = false;
    return;
  }
  enterLobby(value);
});

function enterLobby(joinCode) {
  pendingCode = joinCode;
  const stored = loadStored(joinCode);

  // Reconnect shortcut: if this device already has a seat at this table,
  // skip the form and rejoin directly.
  if (stored?.playerId) {
    showScreen("game");
    connectAndJoin(joinCode, {});
    return;
  }

  $("#lobby-code").textContent = joinCode;
  showScreen("lobby");
}

$("#form-lobby").addEventListener("submit", (e) => {
  e.preventDefault();
  const displayName = $("#input-name").value.trim();
  const commanderName = $("#input-commander").value.trim();
  const colorIdentity = Array.from(document.querySelectorAll(".color-toggle input:checked")).map((el) => el.value);

  showScreen("game");
  connectAndJoin(pendingCode, { displayName, commanderName, colorIdentity });
});

// Life total controls
document.querySelectorAll(".life-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    ws?.send(JSON.stringify({ type: "life_delta", delta: Number(btn.dataset.delta) }));
  });
});

$("#btn-broadcast").addEventListener("click", () => {
  ensureAudio();
  ws?.send(JSON.stringify({ type: "trigger_broadcast" }));
});

$("#btn-ambient").addEventListener("click", () => {
  ensureAudio();
  ws?.send(JSON.stringify({ type: "trigger_ambient", on: !ambientIsMine }));
});

$("#btn-taunt").addEventListener("click", () => {
  ensureAudio();
  ws?.send(JSON.stringify({ type: "trigger_taunt" }));
});

$("#btn-damage").addEventListener("click", () => {
  ensureAudio();
  const targetPlayerId = $("#select-target").value;
  const amount = Number($("#input-damage-amount").value) || 0;
  if (!targetPlayerId || amount <= 0) return;
  ws?.send(JSON.stringify({ type: "damage_player", targetPlayerId, amount }));
});
