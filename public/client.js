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

// Takes Damage: a short sharp hit.
function playDamage() {
  tone({ freq: 140, duration: 0.25, type: "square", gain: 0.25 });
}

// Loses Life: a softer, sadder descending tone — distinct from a damage hit.
function playLifeLoss() {
  tone({ freq: 300, duration: 0.3, type: "sine", gain: 0.15 });
}

// Gains Life: a brief bright ascending twinkle.
function playLifeGain() {
  tone({ freq: 660, duration: 0.18, type: "sine", gain: 0.18 });
  tone({ freq: 880, duration: 0.22, type: "sine", gain: 0.18, delay: 0.08 });
}

// Draw Card: a quick two-click card-flip placeholder.
function playDrawCard() {
  tone({ freq: 900, duration: 0.06, type: "square", gain: 0.12 });
  tone({ freq: 500, duration: 0.05, type: "square", gain: 0.1, delay: 0.05 });
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
const cooldownTimers = {}; // soundId -> interval handle

// Deal Damage selections: who it applies to, which of the three flavors,
// and how much — assembled into one "Apply" press rather than firing on
// every toggle tap.
let selectedTargetValue = "opponents";
let selectedKindValue = "damage";
let wheelAmount = 1;

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

  const allPlayers = Object.values(session.players);
  const opponents = allPlayers.filter((p) => p.id !== selfId);

  $("#opponents").innerHTML = opponents
    .map((p) => {
      const dots = (p.colorIdentity || []).map((c) => `<span class="color-dot color-${c.toLowerCase()}"></span>`).join("");
      const dead = p.lifeTotal <= 0 ? "dead" : "";
      const commander = p.commanderName
        ? `<span class="opponent-commander">${escapeHtml(p.commanderName)}</span>`
        : "";
      return `<div class="opponent-row">
        <div class="opponent-top">
          <span class="opponent-name"><span class="${dead}">${escapeHtml(p.displayName)}</span> ${dots}</span>
          <span class="opponent-life">${p.lifeTotal}</span>
        </div>
        ${commander}
      </div>`;
    })
    .join("");

  // Damage target options: everyone at once, every opponent at once, or one
  // specific player — including yourself, for self-inflicted damage (fetch
  // lands, painlands, etc).
  renderTargetToggles(opponents);

  ambientIsMine = session.ambientActivePlayerId === selfId;
  $("#btn-ambient").classList.toggle("active", !!session.ambientActivePlayerId);
}

function renderTargetToggles(opponents) {
  const options = [
    { value: "all", label: "All players" },
    { value: "opponents", label: "Each opponent" },
    { value: selfId, label: "Me" },
    ...opponents.map((p) => ({ value: p.id, label: p.displayName })),
  ];
  if (!options.some((o) => o.value === selectedTargetValue)) {
    selectedTargetValue = "opponents";
  }

  const container = $("#target-toggle-group");
  container.innerHTML = options
    .map(
      (o) =>
        `<button type="button" class="toggle-btn${o.value === selectedTargetValue ? " active" : ""}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`
    )
    .join("");
  container.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedTargetValue = btn.dataset.value;
      renderTargetToggles(opponents);
    });
  });
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
        if (msg.soundId === "damage") playDamage();
        if (msg.soundId === "life_loss") playLifeLoss();
        if (msg.soundId === "life_gain") playLifeGain();
        if (msg.soundId === "taunt") playTaunt();
        if (msg.soundId === "draw_card") playDrawCard();
        if (msg.soundId === "ambient_on") playAmbientOn(msg.colorIdentity);
        if (msg.soundId === "ambient_off") stopAmbient();
        break;
      }
      case "cooldown_rejected":
      case "cooldown_started": {
        // Both mean the same thing to the UI: show/refresh the countdown.
        // "_started" additionally reaches players who didn't press the
        // button themselves, for Board Wipe's shared cooldown.
        showCooldown(msg.soundId, msg.remainingMs);
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

const COOLDOWN_BUTTONS = {
  broadcast: { btn: "#btn-broadcast", sub: "#broadcast-sub" },
  taunt: { btn: "#btn-taunt", sub: "#taunt-sub" },
};

function showCooldown(soundId, remainingMs) {
  const refs = COOLDOWN_BUTTONS[soundId];
  if (!refs) return;
  const btn = $(refs.btn);
  const sub = $(refs.sub);
  btn.classList.add("on-cooldown");
  clearInterval(cooldownTimers[soundId]);
  const end = Date.now() + remainingMs;
  cooldownTimers[soundId] = setInterval(() => {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(cooldownTimers[soundId]);
      btn.classList.remove("on-cooldown");
      sub.textContent = "";
    } else {
      sub.textContent = `${left}s`;
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

$("#btn-draw").addEventListener("click", () => {
  ensureAudio();
  ws?.send(JSON.stringify({ type: "trigger_draw_card" }));
});

// Kind toggle group (Gains Life / Loses Life / Takes Damage) is static —
// unlike the target group, it doesn't depend on who's in the session.
document.querySelectorAll("#kind-toggle-group .toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedKindValue = btn.dataset.value;
    document.querySelectorAll("#kind-toggle-group .toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });
});

// Amount wheel: a scroll-snapping vertical list, 0–20, defaulting to 1.
const WHEEL_ITEM_HEIGHT = 44;
const WHEEL_MAX = 20;

function initWheel() {
  const wheel = $("#wheel-amount");
  let html = `<div class="wheel-pad"></div>`;
  for (let i = 0; i <= WHEEL_MAX; i++) html += `<div class="wheel-item" data-value="${i}">${i}</div>`;
  html += `<div class="wheel-pad"></div>`;
  wheel.innerHTML = html;

  wheel.querySelectorAll(".wheel-item").forEach((item) => {
    item.addEventListener("click", () => item.scrollIntoView({ block: "center", behavior: "smooth" }));
  });

  let scrollTimeout;
  wheel.addEventListener("scroll", () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const index = Math.round(wheel.scrollTop / WHEEL_ITEM_HEIGHT);
      wheelAmount = Math.min(WHEEL_MAX, Math.max(0, index));
      updateWheelSelection();
    }, 80);
  });

  wheel.scrollTop = wheelAmount * WHEEL_ITEM_HEIGHT; // jump to default (1), no animation
  updateWheelSelection();
}

function updateWheelSelection() {
  document.querySelectorAll(".wheel-item").forEach((item) => {
    item.classList.toggle("selected", Number(item.dataset.value) === wheelAmount);
  });
}

initWheel();

$("#btn-apply-life-event").addEventListener("click", () => {
  ensureAudio();
  if (wheelAmount <= 0) return; // 0 is a no-op amount
  const scope = selectedTargetValue === "all" || selectedTargetValue === "opponents" ? selectedTargetValue : "single";
  const payload = { type: "life_event", scope, kind: selectedKindValue, amount: wheelAmount };
  if (scope === "single") payload.targetPlayerId = selectedTargetValue;
  ws?.send(JSON.stringify(payload));
});
