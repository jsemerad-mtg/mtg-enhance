// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const screens = {
  home: $("#screen-home"),
  lobby: $("#screen-lobby"),
  game: $("#screen-game"),
};
function showScreen(name) {
  for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
  // The wheel can only be positioned once its screen is actually rendered.
  if (name === "game" && typeof positionWheel === "function") positionWheel();
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
const AMBIENT_ROOT = { W: 261, U: 233, B: 196, R: 220, G: 246, C: 185 };
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
let session = { players: {}, hostId: null, ambientActivePlayerId: null, mode: "colocated",
                turnOrder: [], activePlayerId: null, turnStartedAt: Date.now(),
                monarchPlayerId: null, initiativePlayerId: null };
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
  $("#self-name").innerHTML = `${escapeHtml(self.displayName)}${tableStateMarks(selfId)}`;
  $("#self-life").textContent = self.lifeTotal;

  $("#self-panel").classList.toggle("active-turn", session.activePlayerId === selfId);
  $("#self-panel").classList.toggle("lethal-row", !self.eliminated && isLethal(self));
  $("#self-panel").classList.toggle("eliminated-row", !!self.eliminated);

  const selfCommander = $("#self-commander");
  selfCommander.textContent = self.commanderName || "";
  selfCommander.hidden = !self.commanderName;
  if (self.commanderName) selfCommander.dataset.commander = self.commanderName;
  // The mode now reads off the code label instead of a separate badge, and
  // it shows for everyone rather than only the host.
  $("#code-label").textContent = session.mode === "remote" ? "Remote game code" : "Local game code";

  const allPlayers = Object.values(session.players);
  const opponents = allPlayers.filter((p) => p.id !== selfId);

  $("#opponents").innerHTML = opponents
    .map((p) => {
      const dots = (p.colorIdentity || []).map((c) => `<span class="color-dot color-${c.toLowerCase()}"></span>`).join("");
      const dead = p.eliminated || p.lifeTotal <= 0 ? "dead" : "";
      const active = p.id === session.activePlayerId ? " active-turn" : "";
      const doomed = p.eliminated ? " eliminated-row" : isLethal(p) ? " lethal-row" : "";
      const outTag = p.eliminated ? '<span class="out-tag">OUT</span>' : "";
      const mutedIcon = p.muted ? '<span class="muted-pip" title="Sounds muted">\u{1F507}</span>' : "";
      const tableMarks = tableStateMarks(p.id);
      const commander = p.commanderName
        ? `<span class="opponent-commander" data-commander="${escapeHtml(p.commanderName)}">${escapeHtml(p.commanderName)}</span>`
        : "";
      return `<div class="opponent-row${active}${doomed}" data-player-id="${escapeHtml(p.id)}" role="button" tabindex="0">
        <div class="opponent-top">
          <span class="opponent-name"><span class="${dead}">${escapeHtml(p.displayName)}</span> ${dots}${mutedIcon}${tableMarks}${outTag}</span>
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
  renderSoundboard();
  renderTurnControls();
  renderCounterChips();
  refreshOpenModal();
}

function renderTargetToggles(opponents) {
  // Two columns rather than one long list: the group options, then a seat per
  // opponent. Splitting them keeps the panel three rows tall instead of six,
  // which is what makes the whole screen fit a small phone — and it puts the
  // single-opponent targets somewhere obvious.
  const groups = [
    { value: "all", label: "All players" },
    { value: "opponents", label: "Each opp" },
    { value: selfId, label: "Me" },
  ];
  const seats = opponents.map((p) => ({ value: p.id, label: p.displayName.split(" ")[0] }));
  // Empty seats keep the column a constant height as people join and leave.
  for (let i = seats.length; i < 3; i++) {
    seats.push({ value: `empty-${i}`, label: `Player ${i + 2}`, empty: true });
  }

  if (![...groups, ...seats].some((o) => o.value === selectedTargetValue && !o.empty)) {
    selectedTargetValue = "opponents";
  }

  const button = (o) =>
    `<button type="button" class="toggle-btn${o.value === selectedTargetValue ? " active" : ""}` +
    `${o.empty ? " is-empty" : ""}" data-value="${escapeHtml(o.value)}"${o.empty ? " disabled" : ""}>` +
    `${escapeHtml(o.label)}</button>`;

  $("#target-toggle-group").innerHTML = groups.map(button).join("");
  $("#player-toggle-group").innerHTML = seats.map(button).join("");

  document.querySelectorAll("#target-toggle-group .toggle-btn, #player-toggle-group .toggle-btn")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTargetValue = btn.dataset.value;
        renderTargetToggles(opponents);
      });
    });
  updateKindLabels();
}

// "All players take damage" and "Me" (→ "I take damage") want the bare verb;
// "Each opponent takes damage" and "Dave takes damage" want the -s form.
// Each is grammatically singular even though it covers several people.
const KIND_LABELS = {
  gain: { plural: "Gain Life", singular: "Gains Life" },
  loss: { plural: "Lose Life", singular: "Loses Life" },
  damage: { plural: "Take Damage", singular: "Takes Damage" },
};

function updateKindLabels() {
  const plural = selectedTargetValue === "all" || selectedTargetValue === selfId;
  const form = plural ? "plural" : "singular";
  document.querySelectorAll("#kind-toggle-group .toggle-btn").forEach((btn) => {
    const labels = KIND_LABELS[btn.dataset.value];
    if (labels) btn.textContent = labels[form];
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- WebSocket ----------
function connectAndJoin(joinCode, lobbyInfo) {
  // Guard rather than throw: reaching the lobby form without a pending code
  // shouldn't leave a blank game screen with a dead socket behind it.
  if (!joinCode) {
    showScreen("home");
    $("#home-error").textContent = "That game code was lost — pick a game again.";
    $("#home-error").hidden = false;
    return;
  }
  code = joinCode.toUpperCase();
  pendingLobbyInfo = lobbyInfo;
  const stored = loadStored(code) || {};
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${location.host}/ws/${code}`);

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    setConnection("live");
    ws.send(
      JSON.stringify({
        type: "join",
        playerId: stored.playerId || null,
        displayName: lobbyInfo.displayName ?? stored.displayName,
        commanderName: lobbyInfo.commanderName ?? stored.commanderName,
        colorIdentity: lobbyInfo.colorIdentity ?? stored.colorIdentity,
        pin: lobbyInfo.pin ?? null,
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
        rememberGame(code);
        requestWakeLock();
        break;
      }
      case "state_sync": {
        session.players = msg.state.players;
        session.hostId = msg.state.hostId;
        session.ambientActivePlayerId = msg.state.ambientActivePlayerId;
        session.mode = msg.state.mode || "colocated";
        session.turnOrder = msg.state.turnOrder || [];
        session.monarchPlayerId = msg.state.monarchPlayerId ?? null;
        session.initiativePlayerId = msg.state.initiativePlayerId ?? null;
        session.turnStartedAt = msg.state.turnStartedAt || Date.now();
        session.activePlayerId = session.turnOrder[msg.state.activePlayerIndex ?? 0] ?? null;
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
      case "lethal": {
        const box =
          msg.playerId === selfId
            ? $("#self-panel")
            : document.querySelector(`.opponent-row[data-player-id="${CSS.escape(msg.playerId)}"]`);
        flash(box);
        // Plays on every device: the table should hear someone go out, not
        // just the player it happened to.
        if (!muted) playLethal();
        break;
      }
      case "turn_changed": {
        session.activePlayerId = msg.activePlayerId;
        session.turnStartedAt = msg.turnStartedAt;
        render();
        break;
      }
      case "ambient_changed": {
        session.ambientActivePlayerId = msg.playerId;
        render();
        break;
      }
      case "play_sound": {
        if (muted) break; // sound_activity still lights the UI up
        if (msg.soundId === "broadcast") playBroadcast();
        if (msg.soundId === "damage") playDamage();
        if (msg.soundId === "life_loss") playLifeLoss();
        if (msg.soundId === "life_gain") playLifeGain();
        if (msg.soundId === "taunt") playTaunt();
        if (msg.soundId === "draw_card") playDrawCard();
        if (msg.soundId === "ambient_on") playAmbientOn(msg.colorIdentity);
        if (msg.soundId === "ambient_off") stopAmbient();
        if (msg.soundId === "poke") playPoke();
        if (msg.soundId === "pass_turn") playPassTurn();
        if (LIBRARY_BY_ID[msg.soundId]) playLibrarySound(msg.soundId);
        break;
      }
      case "sound_activity": {
        showActivity(msg.playerId, msg.soundId);
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
        if (msg.code === "bad_pin") {
          leftGame = true; // don't reconnect into a rejection loop
          ws.close();
          showScreen("lobby");
          $("#lobby-error").textContent = msg.message;
          $("#lobby-error").hidden = false;
          $("#join-pin-field").hidden = false;
          setTimeout(() => { leftGame = false; }, 0);
          break;
        }
        console.warn("Server error:", msg.message);
        break;
      }
    }
  });

  // Phones close WebSockets aggressively — backgrounding the tab or letting
  // the screen sleep is enough. Without this the whole UI goes quietly inert:
  // life totals stop updating and every button becomes a no-op, with nothing
  // on screen to say why.
  ws.addEventListener("close", () => {
    if (leftGame) return;
    setConnection("reconnecting");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // A close event always follows, which is where reconnection is handled.
  });
}

function showCooldown(soundId, remainingMs) {
  // Soundboard slots are rendered from JS now, so look the button up by the
  // sound it currently holds rather than a fixed element id.
  const btn = document.querySelector(`[data-sound-id="${CSS.escape(soundId)}"]`);
  if (!btn) return;
  const sub = btn.querySelector(".icon-sub");
  if (!sub) return;
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

function hostPin() {
  if (!$("#input-pin-required").checked) return null;
  const value = $("#input-host-pin").value.trim();
  return /^\d{4}$/.test(value) ? value : null;
}

document.querySelectorAll(".btn-mode").forEach((btn) => {
  btn.addEventListener("click", async () => {
    ensureAudio();
    $("#home-error").hidden = true;
    if ($("#input-pin-required").checked && !hostPin()) {
      $("#home-error").textContent = "Enter a 4-digit PIN, or switch the PIN off.";
      $("#home-error").hidden = false;
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: btn.dataset.mode, pin: hostPin() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create a game");
      const pin = hostPin();
      enterLobby(data.code);
      // The host just chose this PIN; making them retype it to sit down at
      // their own table is pure friction.
      if (pin) $("#input-join-pin").value = pin;
    } catch (err) {
      $("#home-error").textContent = err.message;
      $("#home-error").hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
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
  $("#lobby-error").hidden = true;
  showScreen("lobby");

  // Ask the Worker whether this table wants a PIN, so the field appears
  // before they fill anything in rather than after a rejected join.
  $("#join-pin-field").hidden = true;
  fetch(`/api/session/${encodeURIComponent(joinCode)}`)
    .then((r) => r.json())
    .then((info) => {
      $("#join-pin-field").hidden = !info.pinRequired;
    })
    .catch(() => {
      // Offline or the probe failed — leave the field hidden; a wrong or
      // missing PIN is still caught on join.
    });

  // A favorite tapped on the home screen fills the commander in for you.
  const preselect = readJson(PRESELECT_KEY, null);
  if (preselect) {
    const [name, ci] = splitFavorite(preselect);
    applyCommander(name, ci);
    try { localStorage.removeItem(PRESELECT_KEY); } catch {}
  }
}

$("#form-lobby").addEventListener("submit", (e) => {
  e.preventDefault();
  const displayName = $("#input-name").value.trim();
  const commanderName = $("#input-commander").value.trim();
  const colorIdentity = Array.from(document.querySelectorAll(".color-toggle input:checked")).map((el) => el.value);

  const pin = $("#input-join-pin").value.trim();
  if (!$("#join-pin-field").hidden && !/^\d{4}$/.test(pin)) {
    $("#lobby-error").textContent = "This table needs its 4-digit PIN.";
    $("#lobby-error").hidden = false;
    return;
  }
  $("#lobby-error").hidden = true;
  showScreen("game");
  connectAndJoin(pendingCode, { displayName, commanderName, colorIdentity, pin });
});

// Life total controls
document.querySelectorAll(".life-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    sendMessage({ type: "life_delta", delta: Number(btn.dataset.delta) });
  });
});

// Kind toggle group (Gains Life / Loses Life / Takes Damage) is static —
// unlike the target group, it doesn't depend on who's in the session.
document.querySelectorAll("#kind-toggle-group .toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedKindValue = btn.dataset.value;
    document.querySelectorAll("#kind-toggle-group .toggle-btn").forEach((b) => b.classList.toggle("active", b === btn));
    updateKindLabels();
  });
});

// Amount wheel: a scroll-snapping vertical list, 0–20, defaulting to 1.
// Measured from the rendered row rather than hard-coded: the CSS owns the
// geometry, and a duplicated constant here is exactly what drifted last time.
let wheelItemHeight = 36;
const WHEEL_MAX = 20;

function initWheel() {
  const wheel = $("#wheel-amount");
  let html = `<div class="wheel-pad"></div>`;
  for (let i = 0; i <= WHEEL_MAX; i++) html += `<div class="wheel-item" data-value="${i}">${i}</div>`;
  html += `<div class="wheel-pad"></div>`;
  wheel.innerHTML = html;

  const firstItem = wheel.querySelector(".wheel-item");
  if (firstItem) wheelItemHeight = firstItem.getBoundingClientRect().height || wheelItemHeight;

  wheel.querySelectorAll(".wheel-item").forEach((item) => {
    item.addEventListener("click", () => item.scrollIntoView({ block: "center", behavior: "smooth" }));
  });

  let scrollTimeout;
  wheel.addEventListener("scroll", () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const index = Math.round(wheel.scrollTop / wheelItemHeight);
      wheelAmount = Math.min(WHEEL_MAX, Math.max(0, index));
      updateWheelSelection();
    }, 80);
  });

  positionWheel();
}

// scrollTop can't be set on a display:none element, and initWheel() runs at
// load while the game screen is still hidden — so the wheel silently sat at 0
// and Send did nothing until you scrolled it. Position it when the screen is
// actually on, not when the script runs.
function positionWheel() {
  const wheel = $("#wheel-amount");
  const firstItem = wheel.querySelector(".wheel-item");
  if (firstItem) {
    const measured = firstItem.getBoundingClientRect().height;
    if (measured) wheelItemHeight = measured;
  }
  wheel.scrollTop = wheelAmount * wheelItemHeight;
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
  sendMessage(payload);
});


// ---------- color identity toggles ----------
// Colorless is mutually exclusive with WUBRG: a commander either has colored
// pips in its identity or it doesn't (Kozilek, Traxos, Karn). Checking C
// clears the colors; checking any color clears C.
const colorInputs = Array.from(document.querySelectorAll(".color-toggle input"));

function setColorIdentity(colors) {
  const wanted = new Set((colors || []).map((c) => c.toUpperCase()));
  if (wanted.size === 0) wanted.add("C");
  colorInputs.forEach((input) => {
    input.checked = wanted.has(input.value);
  });
}

colorInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    if (input.value === "C") {
      colorInputs.forEach((other) => {
        if (other.value !== "C") other.checked = false;
      });
    } else {
      const colorless = colorInputs.find((other) => other.value === "C");
      if (colorless) colorless.checked = false;
    }
  });
  // Any manual change re-checks against the resolved commander's identity.
  input.addEventListener("change", checkIdentityMismatch);
});

// ---------- commander autocomplete ----------
// Autocomplete runs against a bundled snapshot of every Commander-legal
// commander (public/commanders.json, rebuilt by scripts/build-commanders.js).
//
// Why not filter Scryfall live: /cards/autocomplete takes only a name
// fragment — passing search syntax returns zero results — and the
// /cards/search that *can* filter by is:commander returns full card objects,
// ~950KB for one page of a two-letter query. The snapshot is ~100KB fetched
// once, carries color identity, and needs no network per keystroke.
//
// Live Scryfall stays as the fallback for a name the snapshot doesn't have
// (a set released since the last build) and for when the file is missing
// entirely. Those calls must remain browser-side — Scryfall blocks
// Cloudflare Worker IPs.
const SCRYFALL_AUTOCOMPLETE = "https://api.scryfall.com/cards/autocomplete";
const SCRYFALL_NAMED = "https://api.scryfall.com/cards/named";
const SUGGEST_DEBOUNCE_MS = 120;
const SUGGEST_MIN_CHARS = 2;
const SUGGEST_LIMIT = 8;

const commanderInput = $("#input-commander");
const suggestionList = $("#commander-suggestions");
const commanderNote = $("#commander-note");
const identityWarning = $("#identity-warning");

let commanderIndex = null;
let commanderIndexState = "idle"; // idle | loading | ready | failed
let suggestDebounce = null;
let suggestController = null;
let lookupController = null;
let suggestions = []; // [{ name, ci }] — ci is null when it came from live Scryfall
let activeSuggestion = -1;

// The color identity of the commander we last resolved, as a canonical WUBRG
// string ("" means colorless). null means no commander is resolved, so there's
// nothing to warn against.
let expectedIdentity = null;
let expectedCommanderName = null;

async function loadCommanderIndex() {
  if (commanderIndexState === "ready" || commanderIndexState === "loading") return;
  commanderIndexState = "loading";
  try {
    const res = await fetch("/commanders.json", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    commanderIndex = data.commanders.map((row) => {
      const sep = row.lastIndexOf("|");
      const name = row.slice(0, sep);
      return { name, ci: row.slice(sep + 1), lower: name.toLowerCase() };
    });
    commanderIndexState = "ready";
  } catch {
    // Not built yet, or failed to load — live Scryfall covers for it.
    commanderIndexState = "failed";
  }
}

function searchCommanders(query) {
  const q = query.toLowerCase();
  const starts = [];
  const contains = [];
  for (const entry of commanderIndex) {
    const at = entry.lower.indexOf(q);
    if (at === 0) starts.push(entry);
    else if (at > 0) contains.push(entry);
  }
  return starts.concat(contains).slice(0, SUGGEST_LIMIT);
}

// ---------- color identity helpers ----------
const WUBRG = ["W", "U", "B", "R", "G"];

// Scryfall returns color_identity ALPHABETICALLY (Atraxa is ["B","G","U","W"]),
// not in WUBRG order. Everything downstream — the mismatch check, the note,
// the pips, and eventually the color-identity sound-set key — has to compare
// and display one canonical form, so normalise the moment a value arrives.
function canonicalIdentity(letters) {
  const set = new Set(String(letters || "").toUpperCase().split(""));
  return WUBRG.filter((c) => set.has(c)).join("");
}

function identityLabel(ci) {
  return ci === "" ? "colorless" : ci;
}

// Canonical WUBRG-ordered string for whatever is currently ticked.
// "" means colorless, matching Scryfall's empty color_identity array.
function currentIdentity() {
  const picked = colorInputs.filter((i) => i.checked).map((i) => i.value);
  if (picked.includes("C")) return "";
  return WUBRG.filter((c) => picked.includes(c)).join("");
}

// Advisory only — never resets the player's toggles. Someone may legitimately
// want an off-identity soundboard, but silently drifting off your commander's
// colors would break the downstream color-identity sound mapping.
function checkIdentityMismatch() {
  if (expectedIdentity === null) {
    identityWarning.hidden = true;
    return;
  }
  if (currentIdentity() === expectedIdentity) {
    identityWarning.hidden = true;
    return;
  }
  identityWarning.textContent =
    `${expectedCommanderName} is ${identityLabel(expectedIdentity)} — this doesn't match its color identity.`;
  identityWarning.hidden = false;
}

function pipsHtml(ci) {
  if (ci === null) return "";
  const canonical = canonicalIdentity(ci);
  const letters = canonical === "" ? ["C"] : canonical.split("");
  return `<span class="suggestion-pips">${letters
    .map((c) => `<span class="color-dot color-${c.toLowerCase()}"></span>`)
    .join("")}</span>`;
}

function setNote(text, warn = false) {
  if (!text) {
    commanderNote.hidden = true;
    commanderNote.textContent = "";
    return;
  }
  commanderNote.textContent = text;
  commanderNote.classList.toggle("warn", warn);
  commanderNote.hidden = false;
}

// Single place where a resolved commander lands, whichever source found it.
function applyCommander(name, rawCi) {
  const ci = canonicalIdentity(rawCi);
  expectedCommanderName = name;
  expectedIdentity = ci;
  commanderInput.value = name.slice(0, 40);
  setColorIdentity(ci === "" ? [] : ci.split(""));
  setNote(`${identityLabel(ci)} — colors set from ${name}.`);
  checkIdentityMismatch();
  renderFavButton();
}

function clearCommanderResolution() {
  expectedIdentity = null;
  expectedCommanderName = null;
  setNote("");
  identityWarning.hidden = true;
  renderFavButton();
}

// ---------- suggestion list ----------
function closeSuggestions() {
  suggestions = [];
  activeSuggestion = -1;
  suggestionList.hidden = true;
  suggestionList.innerHTML = "";
  commanderInput.setAttribute("aria-expanded", "false");
}

function renderSuggestions() {
  if (suggestions.length === 0) {
    closeSuggestions();
    return;
  }
  suggestionList.innerHTML = suggestions
    .map(
      (entry, i) =>
        `<li role="option" data-index="${i}" aria-selected="${i === activeSuggestion}">` +
        `<span class="suggestion-name">${escapeHtml(entry.name)}</span>${pipsHtml(entry.ci)}</li>`
    )
    .join("");
  suggestionList.hidden = false;
  commanderInput.setAttribute("aria-expanded", "true");
}

async function updateSuggestions(query) {
  if (commanderIndexState === "idle" || commanderIndexState === "loading") {
    await loadCommanderIndex();
  }
  if (commanderIndexState === "ready") {
    suggestions = searchCommanders(query);
    activeSuggestion = -1;
    renderSuggestions();
    return;
  }
  await fetchLiveSuggestions(query);
}

// Fallback path: unfiltered Scryfall names, no color pips until one is picked.
async function fetchLiveSuggestions(query) {
  suggestController?.abort();
  suggestController = new AbortController();
  try {
    const res = await fetch(
      `${SCRYFALL_AUTOCOMPLETE}?q=${encodeURIComponent(query)}&include_extras=false`,
      { signal: suggestController.signal, headers: { Accept: "application/json" } }
    );
    if (!res.ok) return;
    const data = await res.json();
    suggestions = (data.data || []).slice(0, SUGGEST_LIMIT).map((name) => ({ name, ci: null }));
    activeSuggestion = -1;
    renderSuggestions();
  } catch (err) {
    if (err.name !== "AbortError") closeSuggestions();
  }
}

// Live exact lookup — for a name the snapshot doesn't carry.
async function resolveCommanderLive(name) {
  lookupController?.abort();
  lookupController = new AbortController();
  setNote("Checking colors…");
  try {
    const res = await fetch(`${SCRYFALL_NAMED}?exact=${encodeURIComponent(name)}`, {
      signal: lookupController.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      setNote("Couldn't find that card — set colors by hand.", true);
      return;
    }
    const card = await res.json();
    applyCommander(card.name, card.color_identity.join(""));
    if (card.legalities?.commander !== "legal") {
      setNote(`${identityLabel(canonicalIdentity(card.color_identity.join("")))} — ${card.name} isn't Commander-legal, but colors are set.`, true);
    }
  } catch (err) {
    if (err.name !== "AbortError") setNote("Couldn't reach Scryfall — set colors by hand.", true);
  }
}

function chooseSuggestion(index) {
  const entry = suggestions[index];
  if (!entry) return;
  closeSuggestions();
  if (entry.ci !== null) applyCommander(entry.name, entry.ci);
  else resolveCommanderLive(entry.name);
}

// A name typed in full without picking from the list: check the snapshot
// first, then fall back to a live lookup.
function resolveTypedName(typed) {
  if (commanderIndexState === "ready") {
    const hit = commanderIndex.find((e) => e.lower === typed.toLowerCase());
    if (hit) {
      applyCommander(hit.name, hit.ci);
      return;
    }
  }
  resolveCommanderLive(typed);
}

// ---------- wiring ----------
commanderInput.addEventListener("focus", loadCommanderIndex);

commanderInput.addEventListener("input", () => {
  const query = commanderInput.value.trim();
  if (query !== expectedCommanderName) clearCommanderResolution();
  clearTimeout(suggestDebounce);
  if (query.length < SUGGEST_MIN_CHARS) {
    suggestController?.abort();
    closeSuggestions();
    return;
  }
  suggestDebounce = setTimeout(() => updateSuggestions(query), SUGGEST_DEBOUNCE_MS);
});

commanderInput.addEventListener("keydown", (e) => {
  if (suggestionList.hidden) {
    if (e.key === "Enter" && commanderInput.value.trim().length >= SUGGEST_MIN_CHARS) {
      const typed = commanderInput.value.trim();
      if (typed !== expectedCommanderName) {
        e.preventDefault();
        resolveTypedName(typed);
      }
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestion = (activeSuggestion + 1) % suggestions.length;
    renderSuggestions();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseSuggestion(activeSuggestion >= 0 ? activeSuggestion : 0);
  } else if (e.key === "Escape") {
    closeSuggestions();
  }
});

// mousedown, not click: the input's blur would tear the list down first.
suggestionList.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-index]");
  if (!li) return;
  e.preventDefault();
  chooseSuggestion(Number(li.dataset.index));
});

commanderInput.addEventListener("blur", () => {
  setTimeout(closeSuggestions, 120);
});

// ---------- modals (how-to, Oracle placeholder, log in) ----------
const modalBackdrop = $("#modal-backdrop");
const modalTitle = $("#modal-title");
const modalBody = $("#modal-body");

function openModal(title, bodyHtml) {
  modalTitle.textContent = title;
  modalBody.className = "modal-body"; // drop any per-modal modifier
  delete modalBody.dataset.kind;
  modalBody.innerHTML = bodyHtml;
  modalBody.scrollTop = 0;
  modalBackdrop.hidden = false;
  $("#modal-close").focus();
}

function closeModal() {
  modalBackdrop.hidden = true;
}

$("#modal-close").addEventListener("click", closeModal);
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal(); // backdrop only, not the card
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalBackdrop.hidden) closeModal();
});

const HELP_HTML = `
  <h3>The table</h3>
  <p>Everyone at one table shares a four-character game code. The first person
  in is the host. Anyone can rejoin with the same code on the same device
  without losing their seat.</p>

  <h3>Local vs remote</h3>
  <p>In a <strong>local</strong> game everyone is in one room, so ambient music
  and board wipes play on the host's device only — four phones playing the same
  sound a few feet apart echoes badly. In a <strong>remote</strong> game those
  play on every device. Damage, taunts and card draws always play on the
  relevant player's own device either way.</p>

  <h3>Life totals</h3>
  <p>The big number is yours; tap −1 and +1 for small corrections. Opponents
  are listed below with their commander and colors.</p>

  <h3>The soundboard</h3>
  <ul>
    <li><strong>Wipe</strong> — a board wipe sting for the whole table. Shared
    60-second cooldown, so only one wipe lands at a time.</li>
    <li><strong>Music</strong> — toggles an ambient bed keyed to your color
    identity. One player's music is live at a time.</li>
    <li><strong>Taunt</strong> — plays on your own device. 8-second cooldown.</li>
    <li><strong>Draw</strong> — a card-flip click, no cooldown.</li>
  </ul>

  <h3>Life events</h3>
  <p>The lower panel builds one sentence: pick <em>who</em>, pick
  <em>what happens</em>, spin the amount, press Apply. Use it for real swings —
  combat damage, a life-gain trigger, or a board-wide "each player loses 3".
  The matching sound plays on each affected player's own device.</p>

  <h3>Sounds not playing?</h3>
  <p>Phone browsers won't play audio until you've tapped something, so tap any
  button once after joining. Keep the screen awake — a locked phone stops
  receiving sounds.</p>
`;

const ORACLE_HTML = `
  <p class="placeholder-flag">Not built yet — this is a placeholder.</p>
  <p>This is where you'll settle rules arguments without leaving the game. Ask
  a question, get an answer from MTG Oracle, and choose whether to push it to
  the table — it'll appear as a card in every player's feed.</p>
  <p>Answers stay private until you share them, so you can check a ruling
  without telegraphing what you're holding.</p>
`;

$("#btn-help").addEventListener("click", () => openModal("How this works", HELP_HTML));
$("#btn-oracle").addEventListener("click", () => openModal("Ask the Oracle", ORACLE_HTML));


// ---------- connection resilience ----------
// The single most confusing failure this app can have is a socket that died
// quietly: the buttons still depress, nothing happens, and the life totals
// silently stop matching everyone else's. So the socket reconnects itself,
// sends are guarded, and the connection state is always on screen.
let reconnectAttempts = 0;
let reconnectTimer = null;
let pendingLobbyInfo = {};
let leftGame = false;
const connStatus = $("#conn-status");

function setConnection(state) {
  if (state === "live") {
    connStatus.hidden = true;
    connStatus.className = "conn-status";
    return;
  }
  connStatus.hidden = false;
  connStatus.className = `conn-status conn-${state}`;
  connStatus.textContent = state === "reconnecting" ? "Reconnecting…" : "Offline";
}

function scheduleReconnect() {
  if (reconnectTimer || leftGame) return;
  // 1s, 2s, 4s… capped at 10s, so a phone that's been asleep for a while
  // still comes back promptly without hammering the Worker.
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (code) connectAndJoin(code, pendingLobbyInfo);
  }, delay);
}

function reconnectNow() {
  if (leftGame || !code) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempts = 0;
  connectAndJoin(code, pendingLobbyInfo);
}

function sendMessage(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  // Deliberately not queued: a life change pressed while disconnected is
  // better lost than replayed minutes later onto a board that has moved on.
  setConnection("reconnecting");
  reconnectNow();
  return false;
}

// Coming back to the tab is the moment a phone's socket is most likely dead.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reconnectNow();
    requestWakeLock();
  }
});
window.addEventListener("online", reconnectNow);
window.addEventListener("offline", () => setConnection("offline"));

// ---------- wake lock ----------
// Keeps the screen (and with it the socket) alive during a game. Unsupported
// or refused is fine — reconnection above covers it.
let wakeLock = null;
async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

// ---------- activity glow ----------
// Lights up who triggered what, on every device, at the same moment.
const ACTIVITY_CONTROL = {
  broadcast: "#btn-broadcast",
  ambient: "#btn-ambient",
  taunt: "#btn-taunt",
  draw_card: "#btn-draw",
  life_event: "#btn-apply-life-event",
};

function flash(el) {
  if (!el) return;
  el.classList.remove("glow");
  void el.offsetWidth; // restart the animation if it's already running
  el.classList.add("glow");
  setTimeout(() => el.classList.remove("glow"), 1400);
}

function showActivity(playerId, soundId) {
  const playerBox =
    playerId === selfId
      ? $("#self-panel")
      : document.querySelector(`.opponent-row[data-player-id="${CSS.escape(playerId)}"]`);
  flash(playerBox);
  flash($(ACTIVITY_CONTROL[soundId]));
}

// ---------- commander card viewer ----------
// format=image returns the card art directly, so there's no JSON round trip.
// Browser-side only: Scryfall blocks Cloudflare Worker IPs.
function openCardModal(name) {
  const src = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`;
  openModal(name, `<img class="card-image" src="${escapeHtml(src)}" alt="${escapeHtml(name)}" />`);
}

// Delegated so it keeps working as opponent rows are re-rendered.
document.addEventListener("dblclick", (e) => {
  const el = e.target.closest("[data-commander]");
  if (!el) return;
  e.preventDefault();
  openCardModal(el.dataset.commander);
});

// ---------- sound library ----------
// Placeholder tones for now — the real audio lands in R2 later. Grouped the
// way claude/sound-ability-map.md groups them: universal table events, then
// per-color mechanics, so a player only sees sounds their identity can use.
const SOUND_LIBRARY = {
  universal: [
    ["combat_damage", "Combat Damage"], ["commander_damage", "Commander Damage"],
    ["attack", "Attack!"], ["block", "Blockers"], ["land_drop", "Land Drop"],
    ["counter_stack", "In Response"], ["shuffle", "Shuffle"], ["eliminated", "Eliminated"],
  ],
  W: [
    ["w_wrath", "Wrath"], ["w_lifegain", "Gain Life"], ["w_exile", "Exile"],
    ["w_tokens", "Token Swarm"], ["w_protect", "Protection"], ["w_anthem", "Anthem"],
  ],
  U: [
    ["u_counter", "Counterspell"], ["u_draw", "Draw Extra"], ["u_scry", "Scry"],
    ["u_bounce", "Bounce"], ["u_mill", "Mill"], ["u_steal", "Steal"], ["u_extra_turn", "Extra Turn"],
  ],
  B: [
    ["b_sacrifice", "Sacrifice"], ["b_destroy", "Destroy"], ["b_drain", "Drain"],
    ["b_reanimate", "Reanimate"], ["b_discard", "Discard"], ["b_tutor", "Tutor"],
    ["b_surveil", "Surveil"],
  ],
  R: [
    ["r_burn", "Burn"], ["r_impulse", "Impulse Draw"], ["r_haste", "Haste"],
    ["r_treasure", "Treasure"], ["r_goad", "Goad"], ["r_extra_combat", "Extra Combat"],
  ],
  G: [
    ["g_ramp", "Ramp"], ["g_counters", "+1/+1 Counters"], ["g_fight", "Fight"],
    ["g_trample", "Trample"], ["g_bigmana", "Big Mana"], ["g_stampede", "Stampede"],
  ],
  C: [
    ["c_equip", "Equip"], ["c_manarock", "Mana Rock"], ["c_eldrazi", "Eldrazi"],
    ["c_annihilator", "Annihilator"], ["c_artifact_token", "Artifact Token"],
  ],
};

const LIBRARY_BY_ID = {};
for (const [group, rows] of Object.entries(SOUND_LIBRARY)) {
  for (const [id, label] of rows) LIBRARY_BY_ID[id] = { id, label, group };
}

// Deterministic placeholder: the same sound id always produces the same tone,
// so they're at least distinguishable while the real audio is authored.
function playLibrarySound(soundId) {
  let hash = 0;
  for (let i = 0; i < soundId.length; i++) hash = (hash * 31 + soundId.charCodeAt(i)) >>> 0;
  const root = 180 + (hash % 520);
  const types = ["sine", "triangle", "square", "sawtooth"];
  tone({ freq: root, duration: 0.22, type: types[hash % 4], gain: 0.16 });
  tone({ freq: root * (hash % 2 ? 1.5 : 0.75), duration: 0.26, type: "sine", gain: 0.13, delay: 0.1 });
}

function playPoke() {
  tone({ freq: 1050, duration: 0.07, type: "square", gain: 0.2 });
  tone({ freq: 1050, duration: 0.07, type: "square", gain: 0.2, delay: 0.14 });
}

function playPassTurn() {
  tone({ freq: 392, duration: 0.2, type: "triangle", gain: 0.16 });
  tone({ freq: 523, duration: 0.3, type: "triangle", gain: 0.16, delay: 0.12 });
}

// ---------- mute ----------
let muted = false;
try { muted = localStorage.getItem("mtge:muted") === "1"; } catch { muted = false; }

const SPEAKER_ON = "\u{1F50A}";
const SPEAKER_OFF = "\u{1F507}";

function renderMuteButton() {
  const btn = $("#btn-mute");
  btn.textContent = muted ? SPEAKER_OFF : SPEAKER_ON;
  btn.setAttribute("aria-pressed", String(muted));
  btn.setAttribute("aria-label", muted ? "Unmute all sounds" : "Mute all sounds");
  btn.classList.toggle("is-muted", muted);
}

$("#btn-mute").addEventListener("click", () => {
  muted = !muted;
  try { localStorage.setItem("mtge:muted", muted ? "1" : "0"); } catch {}
  if (muted) stopAmbient();
  renderMuteButton();
  // Shared so the rest of the table can see who won't hear their sounds.
  sendMessage({ type: "set_muted", muted });
});
renderMuteButton();

// ---------- soundboard slots ----------
// Three hotkey slots plus More. Starring a sound on the full board swaps it
// into a slot; the defaults are simply the three sounds starred to begin with.
const ICONS = {
  broadcast: `<path d="M12 3v4M9 7c0 2 1.3 3.2 3 3.2S15 9 15 7" /><path d="M7 10c-1.8 1-2.5 3-2 5 .6 2.2 2.8 3.5 5 3.2.6 1.4 2 2.3 3.5 2.1 1.8-.2 3.1-1.8 3-3.6 1.9-.2 3.3-1.9 3.1-3.8-.2-1.7-1.6-3-3.3-3.1.3-2-1-3.9-3-4.3-2.2-.5-4.4.9-4.8 3.1-.2 1-.1 2 .3 2.9" />`,
  ambient: `<path d="M9 18V5l11-2v13" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" />`,
  draw_card: `<rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" />`,
  library: `<circle cx="12" cy="12" r="9" /><path d="M8 12h8M12 8v8" />`,
  more: `<circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />`,
};

const BUILTINS = {
  broadcast: { label: "Wipe", icon: "broadcast", message: () => ({ type: "trigger_broadcast" }) },
  ambient: { label: "Music", icon: "ambient", message: () => ({ type: "trigger_ambient", on: !ambientIsMine }) },
  draw_card: { label: "Draw", icon: "draw_card", message: () => ({ type: "trigger_draw_card" }) },
};

const DEFAULT_HOTKEYS = ["broadcast", "ambient", "draw_card"];
const HOTKEY_SLOTS = 3;

function loadHotkeys() {
  try {
    const raw = JSON.parse(localStorage.getItem("mtge:hotkeys") || "null");
    if (Array.isArray(raw) && raw.length === HOTKEY_SLOTS) return raw;
  } catch {}
  return [...DEFAULT_HOTKEYS];
}
let hotkeys = loadHotkeys();

function saveHotkeys() {
  try { localStorage.setItem("mtge:hotkeys", JSON.stringify(hotkeys)); } catch {}
}

function soundMeta(id) {
  if (BUILTINS[id]) return BUILTINS[id];
  const lib = LIBRARY_BY_ID[id];
  return lib ? { label: lib.label, icon: "library", library: true } : null;
}

function iconButton({ soundId, label, icon, extraClass = "", sub = "" }) {
  return `<button class="icon-btn ${extraClass}" type="button" data-sound-id="${escapeHtml(soundId)}" aria-label="${escapeHtml(label)}">
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>
    <span class="icon-caption">${escapeHtml(label)}</span>
    <span class="icon-sub">${sub}</span>
  </button>`;
}

function renderSoundboard() {
  const board = $("#soundboard");
  if (!board) return;
  const slots = hotkeys.map((id) => {
    const meta = soundMeta(id);
    if (!meta) return "";
    const activeClass = id === "ambient" && session.ambientActivePlayerId ? "active" : "";
    return iconButton({ soundId: id, label: meta.label, icon: meta.icon, extraClass: activeClass });
  });
  board.innerHTML =
    slots.join("") +
    `<button class="icon-btn" type="button" id="btn-more" aria-label="All sounds">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS.more}</svg>
      <span class="icon-caption">More</span>
      <span class="icon-sub"></span>
    </button>`;
}

$("#soundboard").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  ensureAudio();
  if (btn.id === "btn-more") return openSoundBoardModal();
  const id = btn.dataset.soundId;
  const meta = soundMeta(id);
  if (!meta) return;
  sendMessage(meta.library ? { type: "trigger_library_sound", soundId: id } : meta.message());
});

// ---------- full sound board ----------
// Universal sounds plus whatever this player's color identity unlocks, so a
// mono-white commander isn't scrolling past mill and burn to find Wrath.
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colorless" };

function myIdentityGroups() {
  const self = session.players[selfId];
  const identity = canonicalIdentity((self?.colorIdentity || []).join(""));
  if (identity === "") return ["C"];
  return identity.split("");
}

function soundRow(id, label) {
  const starred = hotkeys.includes(id);
  return `<li class="sound-row">
    <button class="sound-play" type="button" data-play="${escapeHtml(id)}">${escapeHtml(label)}</button>
    <button class="sound-star${starred ? " starred" : ""}" type="button" data-star="${escapeHtml(id)}"
      aria-label="${starred ? "Remove from" : "Add to"} hotkeys">${starred ? "★" : "☆"}</button>
  </li>`;
}

function soundBoardHtml() {
  const sections = [];
  const builtinRows = Object.entries(BUILTINS).map(([id, meta]) => soundRow(id, meta.label));
  sections.push(`<h3>Board</h3><ul class="sound-list">${builtinRows.join("")}</ul>`);

  // Free accounts still see what's behind the upgrade — a locked list is a
  // better pitch than a hidden one — but can't play or star any of it.
  if (!isPro()) {
    const locked = (rows) =>
      `<ul class="sound-list locked">${rows
        .map(([, label]) => `<li class="sound-row"><span class="sound-play is-locked">${escapeHtml(label)}</span>
          <span class="sound-star is-locked">🔒</span></li>`)
        .join("")}</ul>`;
    return `<p class="board-hint">Your three hotkey sounds are below. The full board unlocks every
      universal sound and every sound in your commander's colors.</p>
      <button class="btn btn-primary upgrade-cta" type="button" data-auth="do-checkout">Upgrade for the full board</button>
      ${sections.join("")}
      <h3>Universal</h3>${locked(SOUND_LIBRARY.universal)}
      ${myIdentityGroups()
        .map((c) => `<h3>${COLOR_NAMES[c]}</h3>${locked(SOUND_LIBRARY[c] || [])}`)
        .join("")}`;
  }

  sections.push(
    `<h3>Universal</h3><ul class="sound-list">${SOUND_LIBRARY.universal.map(([id, l]) => soundRow(id, l)).join("")}</ul>`
  );
  for (const color of myIdentityGroups()) {
    const rows = SOUND_LIBRARY[color] || [];
    if (rows.length === 0) continue;
    sections.push(
      `<h3>${COLOR_NAMES[color]}</h3><ul class="sound-list">${rows.map(([id, l]) => soundRow(id, l)).join("")}</ul>`
    );
  }
  return `<p class="board-hint">Tap a name to play it. Star up to ${HOTKEY_SLOTS} to keep them on the main screen.</p>
    <p id="board-warning" class="field-note error" hidden></p>${sections.join("")}`;
}

function openSoundBoardModal() {
  openModal("Sounds", soundBoardHtml());
  modalBody.classList.add("sound-board");
}

modalBody.addEventListener("click", (e) => {
  const play = e.target.closest("[data-play]");
  if (play) {
    ensureAudio();
    const id = play.dataset.play;
    const meta = soundMeta(id);
    sendMessage(meta?.library ? { type: "trigger_library_sound", soundId: id } : meta.message());
    return;
  }

  const star = e.target.closest("[data-star]");
  if (star) {
    const id = star.dataset.star;
    const warning = $("#board-warning");
    if (hotkeys.includes(id)) {
      // Slots are never left empty — removing one falls back to whichever
      // default isn't already in use.
      const fallback = DEFAULT_HOTKEYS.find((d) => !hotkeys.includes(d)) || "draw_card";
      hotkeys = hotkeys.map((h) => (h === id ? fallback : h));
    } else {
      const replaceable = hotkeys.findIndex((h) => !DEFAULT_HOTKEYS.includes(h));
      if (replaceable === -1) {
        // All three slots hold defaults: take the last one rather than
        // silently refusing.
        hotkeys[HOTKEY_SLOTS - 1] = id;
      } else {
        hotkeys[replaceable] = id;
      }
    }
    saveHotkeys();
    renderSoundboard();
    const scroll = modalBody.scrollTop;
    modalBody.innerHTML = soundBoardHtml();
    modalBody.scrollTop = scroll;
    if (warning) warning.hidden = true;
  }
});

// ---------- turn controls ----------
function renderTurnControls() {
  const isMyTurn = session.activePlayerId === selfId;
  $("#btn-pass-turn").hidden = !isMyTurn;
  const self = session.players[selfId];
  $("#btn-turn-order").hidden = !self?.isHost;
}

$("#btn-pass-turn").addEventListener("click", () => {
  // Easy to hit by accident beside the life buttons, and passing out of turn
  // can't be taken back without the whole table re-passing.
  const next = nextPlayer();
  const afterNext = next ? nextPlayer(next.id, true) : null;

  // A player at 0 life may still be in the game — Platinum Angel, Phyrexian
  // Unlife and Lich's Mastery all switch off the state-based action that
  // would end it, and you can just as easily be out at 40 life by decking or
  // conceding. So the app never decides: it offers the skip and lets whoever
  // is passing say which is true right now.
  // Eliminated players are stepped over by the server, so the manual offer is
  // only for the ambiguous case: down but not declared out.
  const skipOption =
    next && !next.eliminated && isLethal(next) && afterNext && afterNext.id !== next.id
      ? `<button class="btn btn-secondary" type="button" data-confirm="skip"
           data-to="${escapeHtml(afterNext.id)}">Skip to ${escapeHtml(afterNext.displayName)}</button>`
      : "";

  const note =
    next && !next.eliminated && isLethal(next)
      ? `<p class="menu-note">${escapeHtml(next.displayName)} is out of life — skip them only if they're actually out of the game.</p>`
      : "";

  openModal(
    "Pass turn",
    `<p>Hand the turn to <strong>${escapeHtml(next?.displayName || "the next player")}</strong>?</p>
     <div class="player-menu">
       <button class="btn btn-primary" type="button" data-confirm="pass">Pass turn</button>
       ${skipOption}
       <button class="btn btn-secondary" type="button" data-confirm="cancel">Not yet</button>
     </div>${note}`
  );
});

// The player after `fromId` in the rotation. With skipLethal, keeps walking
// past players who are out, stopping if everyone else is.
function nextPlayer(fromId = selfId, skipLethal = false) {
  const order = session.turnOrder.filter((id) => session.players[id]);
  const at = order.indexOf(fromId);
  if (at === -1 || order.length < 2) return null;
  for (let step = 1; step <= order.length; step++) {
    const candidate = session.players[order[(at + step) % order.length]];
    if (!candidate) continue;
    if (candidate.eliminated && candidate.id !== selfId) continue;
    if (!skipLethal || !isLethal(candidate) || candidate.id === selfId) return candidate;
  }
  return session.players[order[(at + 1) % order.length]] ?? null;
}

modalBody.addEventListener("click", (e) => {
  const choice = e.target.closest("[data-confirm]")?.dataset.confirm;
  if (!choice) return;
  if (choice === "pass") {
    ensureAudio();
    sendMessage({ type: "pass_turn" });
  } else if (choice === "skip") {
    ensureAudio();
    sendMessage({ type: "pass_turn", toPlayerId: e.target.closest("[data-to]")?.dataset.to });
  }
  closeModal();
});

// ---------- opponent menu ----------
// One tap on a player opens the actions aimed at them, rather than hiding
// taunt and poke behind a long-press nobody discovers.
let menuTargetId = null;

function pokeAvailable(targetId) {
  if (targetId !== session.activePlayerId) return false;
  return Date.now() - (session.turnStartedAt || 0) >= 60000;
}

function openPlayerMenu(playerId) {
  const player = session.players[playerId];
  if (!player) return;
  menuTargetId = playerId;
  const canPoke = pokeAvailable(playerId);
  const pokeNote = canPoke
    ? ""
    : `<p class="menu-note">Poke unlocks once it's their turn and they've had it a minute.</p>`;
  const self = session.players[selfId];
  const dealt = commanderDamageOf(self)[playerId] ?? 0;
  const damageRow = stepperRow({
    label: `${player.displayName}'s commander → you`,
    sub: dealt >= COMMANDER_DAMAGE_LETHAL ? "lethal" : `${COMMANDER_DAMAGE_LETHAL - dealt} to go`,
    value: dealt,
    action: "cmdr",
    id: playerId,
    lethal: dealt >= COMMANDER_DAMAGE_LETHAL,
  });

  openModal(
    player.displayName,
    `${damageRow}
    <div class="player-menu">
      <button class="btn btn-secondary" type="button" data-menu="taunt">Taunt</button>
      <button class="btn btn-secondary" type="button" data-menu="poke"${canPoke ? "" : " disabled"}>Poke</button>
      <button class="btn btn-secondary" type="button" data-menu="view"${player.commanderName ? "" : " disabled"}>View commander</button>
      <button class="btn btn-secondary" type="button" data-menu="monarch">
        ${session.monarchPlayerId === playerId ? "Remove the monarch" : "Make them the monarch"}
      </button>
      <button class="btn btn-secondary" type="button" data-menu="initiative">
        ${session.initiativePlayerId === playerId ? "Remove the initiative" : "Give them the initiative"}
      </button>
      <button class="btn btn-secondary" type="button" data-menu="eliminate">
        ${player.eliminated ? "Bring back in" : "Mark eliminated"}
      </button>
      <button class="btn btn-secondary" type="button" data-menu="close">Close</button>
    </div>${pokeNote}`
  );
  modalBody.dataset.kind = "player-menu";
}

modalBody.addEventListener("click", (e) => {
  const action = e.target.closest("[data-menu]")?.dataset.menu;
  if (!action) return;
  const player = session.players[menuTargetId];
  if (action === "close" || !player) return closeModal();
  if (action === "view") return openCardModal(player.commanderName);
  if (action === "eliminate") return confirmEliminate(player.id, !player.eliminated);
  if (action === "monarch" || action === "initiative") {
    sendMessage({ type: "set_table_state", which: action, playerId: menuTargetId });
    return closeModal();
  }
  ensureAudio();
  sendMessage({ type: "trigger_targeted", soundId: action, targetPlayerId: menuTargetId });
  closeModal();
});

// The commander name fills much of the row, so excluding it from the tap
// target left half of each row inert. Single tap anywhere opens the menu —
// which carries View anyway; a double-click still jumps straight to the card.
$("#opponents").addEventListener("click", (e) => {
  const row = e.target.closest(".opponent-row");
  if (row) openPlayerMenu(row.dataset.playerId);
});

// ---------- turn order (host) ----------
function turnOrderHtml() {
  const rows = session.turnOrder
    .filter((id) => session.players[id])
    .map((id, i, arr) => {
      const p = session.players[id];
      return `<li class="order-row">
        <span class="order-index">${i + 1}</span>
        <span class="order-name">${escapeHtml(p.displayName)}${id === selfId ? " (you)" : ""}</span>
        <span class="order-actions">
          <button type="button" data-move="up" data-id="${escapeHtml(id)}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button type="button" data-move="down" data-id="${escapeHtml(id)}" ${i === arr.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
        </span>
      </li>`;
    });
  return `<p class="board-hint">Turn order follows the order people sat down. Reorder it here.</p>
    <ul class="order-list">${rows.join("")}</ul>`;
}

$("#btn-turn-order").addEventListener("click", () => openModal("Turn order", turnOrderHtml()));

modalBody.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-move]");
  if (!btn) return;
  const order = session.turnOrder.filter((id) => session.players[id]);
  const from = order.indexOf(btn.dataset.id);
  const to = btn.dataset.move === "up" ? from - 1 : from + 1;
  if (from === -1 || to < 0 || to >= order.length) return;
  [order[from], order[to]] = [order[to], order[from]];
  session.turnOrder = order;
  sendMessage({ type: "set_turn_order", order });
  modalBody.innerHTML = turnOrderHtml();
});

// ---------- rejoin after a browser close ----------
// The Durable Object keeps life totals, commanders and turn position, and the
// player id lives in localStorage — but nothing recorded WHICH game you were
// in, so closing the tab stranded you at the home screen.
const LAST_GAME_KEY = "mtge:last-game";

function rememberGame(joinCode) {
  try { localStorage.setItem(LAST_GAME_KEY, JSON.stringify({ code: joinCode, at: Date.now() })); } catch {}
}

function showRejoinBanner() {
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_GAME_KEY) || "null"); } catch {}
  // A day is long enough to cover finishing a game after a break, short
  // enough not to offer a table that broke up last week.
  if (!last?.code || Date.now() - last.at > 24 * 60 * 60 * 1000) return;
  if (!loadStored(last.code)?.playerId) return;
  $("#rejoin-code").textContent = last.code;
  $("#rejoin-banner").hidden = false;
  $("#btn-rejoin").onclick = () => {
    ensureAudio();
    enterLobby(last.code);
  };
  $("#btn-forget-game").onclick = () => {
    try { localStorage.removeItem(LAST_GAME_KEY); } catch {}
    $("#rejoin-banner").hidden = true;
  };
}
showRejoinBanner();

// ---------- accounts (UI shell) ----------
// There is no auth backend yet: D1 isn't created and no email provider is
// chosen, so password reset can't actually send anything. These screens are
// the real flows against a local stub.
//
// The one hard rule here: a password is never stored, anywhere. It's read for
// validation, checked, and discarded — the "session" below holds a name, an
// email and a paid flag and nothing else. A login form that looks real but
// keeps credentials in localStorage is worse than no login form at all,
// because a tester will type a password they use elsewhere.
const ACCOUNT_KEY = "mtge:account";
const FAVORITES_KEY = "mtge:favorites";
const PRESELECT_KEY = "mtge:preselect";
const MIN_PASSWORD = 8;

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let account = readJson(ACCOUNT_KEY, null);
let favorites = readJson(FAVORITES_KEY, []);

const isPro = () => account?.pro === true;
const emailLooksValid = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const PREVIEW_FLAG = `<p class="placeholder-flag">Preview — not connected yet</p>`;

function authError(message) {
  const el = $("#auth-error");
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

function field(id, label, type = "text", extra = "") {
  return `<label class="field">
    <span>${escapeHtml(label)}</span>
    <input id="${id}" type="${type}" autocomplete="off" ${extra} />
  </label>`;
}

const AUTH_VIEWS = {
  signin: () => ({
    title: "Sign in",
    body: `${PREVIEW_FLAG}
      <div class="auth-form">
        ${field("auth-identifier", "Username or email")}
        ${field("auth-password", "Password", "password")}
        <p id="auth-error" class="field-note error" hidden></p>
        <button class="btn btn-primary" type="button" data-auth="do-signin">Sign in</button>
        <div class="auth-links">
          <button class="link-btn" type="button" data-auth="view-forgot">Forgot username or password?</button>
          <button class="link-btn" type="button" data-auth="view-signup">Create an account</button>
        </div>
      </div>`,
  }),

  signup: () => ({
    title: "Create account",
    body: `${PREVIEW_FLAG}
      <div class="auth-form">
        ${field("auth-name", "Name or username")}
        ${field("auth-email", "Email address", "email")}
        ${field("auth-password", "Password", "password")}
        ${field("auth-confirm", "Confirm password", "password")}
        <p class="field-note">At least ${MIN_PASSWORD} characters.</p>
        <p id="auth-error" class="field-note error" hidden></p>
        <button class="btn btn-primary" type="button" data-auth="do-signup">Create account</button>
        <div class="auth-links">
          <button class="link-btn" type="button" data-auth="view-signin">I already have an account</button>
        </div>
      </div>`,
  }),

  forgot: () => ({
    title: "Reset your password",
    body: `${PREVIEW_FLAG}
      <div class="auth-form">
        <p class="board-hint">Enter the email on the account and we'll send a six-digit reset code.</p>
        ${field("auth-email", "Email address", "email")}
        <p id="auth-error" class="field-note error" hidden></p>
        <button class="btn btn-primary" type="button" data-auth="do-forgot">Send reset code</button>
        <div class="auth-links">
          <button class="link-btn" type="button" data-auth="view-signin">Back to sign in</button>
        </div>
      </div>`,
  }),

  reset: (email) => ({
    title: "Enter your code",
    body: `${PREVIEW_FLAG}
      <div class="auth-form">
        <p class="board-hint">A six-digit code would be sent to ${escapeHtml(email || "your email")}.
        Nothing is actually sent yet — no email provider is wired up.</p>
        ${field("auth-code", "Six-digit code", "text", 'inputmode="numeric" maxlength="6"')}
        ${field("auth-password", "New password", "password")}
        ${field("auth-confirm", "Confirm new password", "password")}
        <p id="auth-error" class="field-note error" hidden></p>
        <button class="btn btn-primary" type="button" data-auth="do-reset">Set new password</button>
        <div class="auth-links">
          <button class="link-btn" type="button" data-auth="view-forgot">Send another code</button>
        </div>
      </div>`,
  }),

  account: () => ({
    title: account?.name || "Your account",
    body: `${PREVIEW_FLAG}
      <p class="account-email">${escapeHtml(account?.email || "")}</p>
      <div class="account-plan">
        <span class="plan-label">${isPro() ? "Full soundboard" : "Free — 3 sounds"}</span>
        ${isPro() ? "" : `<button class="btn btn-primary btn-sm" type="button" data-auth="view-upgrade">Upgrade</button>`}
      </div>

      <h3>Favorite commanders</h3>
      ${favoritesEditorHtml()}

      <div class="auth-links">
        <button class="link-btn" type="button" data-auth="do-logout">Log out</button>
      </div>`,
  }),

  upgrade: () => ({
    title: "Upgrade",
    body: `${PREVIEW_FLAG}
      <p>The full soundboard unlocks every universal sound plus every sound in
      your commander's color identity, lets you star any of them into your
      three hotkey slots, and saves your favorite commanders.</p>
      <p>Custom sound packs and uploading your own sounds are planned on top of
      this.</p>
      <p class="field-note">Price and checkout aren't set up yet.</p>
      <button class="btn btn-primary upgrade-cta" type="button" data-auth="do-checkout">Open checkout</button>
      <div class="auth-links">
        <button class="link-btn" type="button" data-auth="do-simulate-upgrade">
          ${isPro() ? "Turn off" : "Turn on"} upgraded state (without checkout)
        </button>
        <button class="link-btn" type="button" data-auth="view-account">Back</button>
      </div>`,
  }),
};

function openAuth(view = account ? "account" : "signin", arg) {
  const { title, body } = AUTH_VIEWS[view](arg);
  openModal(title, body);
  modalBody.classList.add("auth-modal");
}

// ---------- favorite commanders ----------
function favoritesEditorHtml() {
  if (!isPro()) {
    return `<p class="empty-state">Saving favorite commanders comes with the full soundboard.</p>`;
  }
  if (favorites.length === 0) {
    return `<p class="empty-state">Star a commander in the lobby and it'll appear here.</p>`;
  }
  return `<ul class="fav-list">${favorites
    .map((entry) => {
      const [name, ci] = splitFavorite(entry);
      return `<li class="fav-row">
        <span class="fav-name">${escapeHtml(name)}</span>
        ${pipsHtml(ci)}
        <button type="button" class="fav-remove" data-unfav="${escapeHtml(entry)}" aria-label="Remove ${escapeHtml(name)}">&times;</button>
      </li>`;
    })
    .join("")}</ul>`;
}

function splitFavorite(entry) {
  const at = entry.lastIndexOf("|");
  return at === -1 ? [entry, ""] : [entry.slice(0, at), entry.slice(at + 1)];
}

function renderHomeFavorites() {
  const host = $("#favorites-list");
  if (!host) return;
  if (!account) {
    host.innerHTML = `<p class="empty-state">Sign in to save the commanders you play most.</p>`;
    return;
  }
  if (!isPro()) {
    host.innerHTML = `<p class="empty-state">Favorite commanders come with the full soundboard.</p>`;
    return;
  }
  if (favorites.length === 0) {
    host.innerHTML = `<p class="empty-state">Star a commander in the lobby and it'll show up here.</p>`;
    return;
  }
  host.innerHTML = `<div class="fav-chips">${favorites
    .map((entry) => {
      const [name, ci] = splitFavorite(entry);
      return `<button type="button" class="fav-chip" data-preselect="${escapeHtml(entry)}">
        <span>${escapeHtml(name)}</span>${pipsHtml(ci)}</button>`;
    })
    .join("")}</div>
    <p class="field-note">Tap one to use it in your next game.</p>`;
}

$("#favorites-list").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-preselect]");
  if (!chip) return;
  writeJson(PRESELECT_KEY, chip.dataset.preselect);
  chip.classList.add("chosen");
  $("#favorites-list").querySelectorAll(".fav-chip").forEach((c) => {
    if (c !== chip) c.classList.remove("chosen");
  });
});

// The lobby's star: only meaningful once a commander has actually resolved,
// since a favorite without its color identity is no use later.
function renderFavButton() {
  const btn = $("#btn-fav-commander");
  if (!btn) return;
  const resolved = expectedCommanderName && expectedIdentity !== null;
  btn.hidden = !(resolved && isPro());
  if (btn.hidden) return;
  const entry = `${expectedCommanderName}|${expectedIdentity}`;
  btn.textContent = favorites.includes(entry) ? "★ Saved to favorites" : "☆ Save to favorites";
  btn.dataset.entry = entry;
}

$("#btn-fav-commander").addEventListener("click", () => {
  const entry = $("#btn-fav-commander").dataset.entry;
  if (!entry) return;
  favorites = favorites.includes(entry) ? favorites.filter((f) => f !== entry) : [...favorites, entry];
  writeJson(FAVORITES_KEY, favorites);
  renderFavButton();
  renderHomeFavorites();
});

// ---------- auth actions ----------
let resetEmail = "";

function setAccount(next) {
  account = next;
  writeJson(ACCOUNT_KEY, account);
  renderLoginButton();
  renderHomeFavorites();
  renderFavButton();
  renderSoundboard();
}

// Checkout gets its own window so the game keeps its socket and its seat at
// the table. The upgrade page writes the flag on the same origin, which fires
// a storage event back here — the same shape the real Stripe return will take.
function openCheckout() {
  const win = window.open("/upgrade.html", "mtge-upgrade", "width=460,height=720");
  if (!win) {
    // Popup blocked — navigating there still works, it just loses the game
    // screen until they come back.
    location.href = "/upgrade.html";
  }
}

window.addEventListener("storage", (e) => {
  if (e.key !== ACCOUNT_KEY) return;
  account = readJson(ACCOUNT_KEY, null);
  renderLoginButton();
  renderHomeFavorites();
  renderFavButton();
  renderSoundboard();
  // If the sound board is open, redraw it so the unlock is immediate.
  if (modalBody.classList.contains("sound-board") && !modalBackdrop.hidden) {
    modalBody.innerHTML = soundBoardHtml();
  }
});

function renderLoginButton() {
  const btn = $("#btn-login");
  if (!btn) return;
  btn.textContent = account ? account.name : "Log in";
}

modalBody.addEventListener("click", (e) => {
  const unfav = e.target.closest("[data-unfav]");
  if (unfav) {
    favorites = favorites.filter((f) => f !== unfav.dataset.unfav);
    writeJson(FAVORITES_KEY, favorites);
    renderHomeFavorites();
    return openAuth("account");
  }

  const action = e.target.closest("[data-auth]")?.dataset.auth;
  if (!action) return;

  if (action.startsWith("view-")) return openAuth(action.slice(5), resetEmail);

  if (action === "do-signin") {
    const identifier = $("#auth-identifier").value.trim();
    const password = $("#auth-password").value;
    if (!identifier) return authError("Enter your username or email.");
    if (!password) return authError("Enter your password.");
    // Shape checked, password dropped on the floor — nothing to verify it
    // against until there's a backend, and nowhere safe to keep it.
    $("#auth-password").value = "";
    setAccount({ name: identifier.split("@")[0], email: identifier.includes("@") ? identifier : "", pro: false });
    return openAuth("account");
  }

  if (action === "do-signup") {
    const name = $("#auth-name").value.trim();
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const confirm = $("#auth-confirm").value;
    if (name.length < 2) return authError("Pick a name of at least two characters.");
    if (!emailLooksValid(email)) return authError("That doesn't look like an email address.");
    if (password.length < MIN_PASSWORD) return authError(`Passwords need at least ${MIN_PASSWORD} characters.`);
    if (password !== confirm) return authError("The two passwords don't match.");
    $("#auth-password").value = "";
    $("#auth-confirm").value = "";
    setAccount({ name, email, pro: false });
    return openAuth("account");
  }

  if (action === "do-forgot") {
    const email = $("#auth-email").value.trim();
    if (!emailLooksValid(email)) return authError("Enter the email address on the account.");
    resetEmail = email;
    return openAuth("reset", email);
  }

  if (action === "do-reset") {
    const code = $("#auth-code").value.trim();
    const password = $("#auth-password").value;
    const confirm = $("#auth-confirm").value;
    if (!/^\d{6}$/.test(code)) return authError("The code is six digits.");
    if (password.length < MIN_PASSWORD) return authError(`Passwords need at least ${MIN_PASSWORD} characters.`);
    if (password !== confirm) return authError("The two passwords don't match.");
    $("#auth-password").value = "";
    $("#auth-confirm").value = "";
    return openAuth("signin");
  }

  if (action === "do-checkout") {
    openCheckout();
    return closeModal();
  }

  if (action === "do-logout") {
    setAccount(null);
    return closeModal();
  }

  if (action === "do-simulate-upgrade") {
    setAccount({ ...account, pro: !isPro() });
    return openAuth("upgrade");
  }

});

$("#btn-login").addEventListener("click", () => openAuth());
renderLoginButton();
renderHomeFavorites();

// ---------- join PIN ----------
$("#input-pin-required").addEventListener("change", (e) => {
  const input = $("#input-host-pin");
  input.hidden = !e.target.checked;
  if (e.target.checked) input.focus();
  else input.value = "";
});

$("#input-host-pin").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
});
$("#input-join-pin").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
});

// ---------- commander damage and poison ----------
// The two loss conditions that aren't life. Commander damage is recorded per
// source, because 21 is the threshold for a single commander rather than a
// running total, so it lives keyed by the id of the player who dealt it.
const COMMANDER_DAMAGE_LETHAL = 21;
const POISON_LETHAL = 10;

function commanderDamageOf(player) {
  return player?.commanderDamage || {};
}

function worstCommanderDamage(player) {
  const values = Object.values(commanderDamageOf(player));
  return values.length ? Math.max(...values) : 0;
}

function isLethal(player) {
  if (!player) return false;
  if ((player.lifeTotal ?? 1) <= 0) return true;
  return worstCommanderDamage(player) >= COMMANDER_DAMAGE_LETHAL || (player.poison ?? 0) >= POISON_LETHAL;
}

function chipClass(value, lethal) {
  if (value >= lethal) return " lethal";
  // Flag at roughly two-thirds, which is the point it starts mattering.
  if (value >= Math.ceil(lethal * 0.66)) return " warn";
  return "";
}

// Commander tax is twice the number of times it has been cast from the
// command zone. The chip shows the cost, not the count, because the cost is
// the number you need when you're deciding whether you can afford it.
function commanderTax(player) {
  return (player?.commanderCasts ?? 0) * 2;
}

const CHIP_ICONS = {
  more: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2.1" fill="currentColor" stroke="none"/><circle cx="10" cy="16" r="2.1" fill="currentColor" stroke="none"/></svg>`,
  poison: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.6 2 4 5.4 4 9.6c0 2.5 1.2 4.4 3 5.6V18a1 1 0 0 0 1 1h1.2l.4 2.2a1 1 0 0 0 1 .8h2.8a1 1 0 0 0 1-.8l.4-2.2H16a1 1 0 0 0 1-1v-2.8c1.8-1.2 3-3.1 3-5.6C20 5.4 16.4 2 12 2Zm-3 9a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Zm6 0a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z"/></svg>`,
  tax: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 16c4-8 12-8 16 0"/><path d="M12 3v3M7.5 5l1.5 2.6M16.5 5 15 7.6"/></svg>`,
  cmdr: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 14 10M7 4l13 13M10 7 7 4 4 7l3 3M17 20l3-3"/></svg>`,
};

function chip(kind, label, value, extraClass = "") {
  return `<button type="button" class="counter-chip${extraClass}" data-counters="open"
    aria-label="${escapeHtml(label)}: ${value}" title="${escapeHtml(label)}">
    <span class="chip-icon">${CHIP_ICONS[kind]}</span><span class="chip-value">${value}</span></button>`;
}

function renderCounterChips() {
  const self = session.players[selfId];
  if (!self) return;
  const poison = self.poison ?? 0;
  const worst = worstCommanderDamage(self);

  // Poison and tax are always offered so they can be raised from zero.
  // Commander damage only appears once someone has connected with one.
  // A leading affordance: the value chips are clickable, but nothing about a
  // number suggests that, so this one carries the "there's more here" signal.
  const chips = [
    `<button type="button" class="counter-chip chip-more" data-counters="open"
       aria-label="Counters and table states" title="Counters and table states">
       <span class="chip-icon">${CHIP_ICONS.more}</span></button>`,
    chip("poison", "Poison counters", poison, chipClass(poison, POISON_LETHAL)),
    chip("tax", "Commander tax", commanderTax(self)),
  ];
  if (worst > 0) {
    chips.push(chip("cmdr", "Commander damage taken", worst, chipClass(worst, COMMANDER_DAMAGE_LETHAL)));
  }
  $("#counter-chips").innerHTML = chips.join("");
}

// Crown and initiative markers, shown on whoever currently holds them.
const TABLE_ICONS = {
  monarch: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l3.5 3L12 4l5.5 7L21 8l-1.6 9.4a1 1 0 0 1-1 .8H5.6a1 1 0 0 1-1-.8L3 8Z"/></svg>`,
  initiative: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 21V10a7 7 0 0 1 14 0v11"/><path d="M9 21v-8M15 21v-8M5 14h14M5 17.5h14"/></svg>`,
};

function tableStateMarks(playerId) {
  let out = "";
  if (session.monarchPlayerId === playerId) {
    out += `<span class="table-mark" title="The monarch">${TABLE_ICONS.monarch}</span>`;
  }
  if (session.initiativePlayerId === playerId) {
    out += `<span class="table-mark" title="The initiative">${TABLE_ICONS.initiative}</span>`;
  }
  return out;
}

function stepperRow({ label, sub, value, action, id, lethal }) {
  return `<div class="stepper-row${lethal ? " lethal" : ""}">
    <span class="stepper-label">${escapeHtml(label)}${sub ? `<span class="stepper-sub">${escapeHtml(sub)}</span>` : ""}</span>
    <button type="button" class="stepper-btn" data-step="${action}" data-id="${escapeHtml(id)}" data-delta="-1">−</button>
    <span class="stepper-value">${value}</span>
    <button type="button" class="stepper-btn" data-step="${action}" data-id="${escapeHtml(id)}" data-delta="1">+</button>
  </div>`;
}

function countersHtml() {
  const self = session.players[selfId];
  if (!self) return "";
  const poison = self.poison ?? 0;
  const damage = commanderDamageOf(self);

  const banner = isLethal(self)
    ? `<p class="lethal-banner">That's lethal — ${
        worstCommanderDamage(self) >= COMMANDER_DAMAGE_LETHAL
          ? `21 commander damage from one commander`
          : `10 poison counters`
      }.</p>`
    : "";

  const opponents = Object.values(session.players).filter((p) => p.id !== selfId);
  const rows = opponents.map((p) => {
    const value = damage[p.id] ?? 0;
    return stepperRow({
      label: `${p.displayName}'s commander`,
      sub: value >= COMMANDER_DAMAGE_LETHAL ? "lethal" : `${COMMANDER_DAMAGE_LETHAL - value} to go`,
      value,
      action: "cmdr",
      id: p.id,
      lethal: value >= COMMANDER_DAMAGE_LETHAL,
    });
  });

  return `${banner}
    <p class="board-hint">Commander damage also takes the life with it, so record it here rather than twice.</p>
    ${stepperRow({
      label: "Poison counters",
      sub: poison >= POISON_LETHAL ? "lethal" : `${POISON_LETHAL - poison} to go`,
      value: poison,
      action: "poison",
      id: selfId,
      lethal: poison >= POISON_LETHAL,
    })}
    ${stepperRow({
      label: "Commander tax",
      sub: `cast ${self.commanderCasts ?? 0}\u00d7 \u2014 costs ${commanderTax(self)} more`,
      value: commanderTax(self),
      action: "casts",
      id: selfId,
    })}

    <h3>Table</h3>
    <div class="table-state-row">
      <button class="btn btn-secondary" type="button" data-table="monarch">
        ${session.monarchPlayerId === selfId ? "Give up monarch" : "Take monarch"}
      </button>
      <button class="btn btn-secondary" type="button" data-table="initiative">
        ${session.initiativePlayerId === selfId ? "Give up initiative" : "Take initiative"}
      </button>
    </div>
    ${tableHolderNote()}

    <button class="btn btn-secondary elim-self" type="button" data-self-elim="1">
      ${self.eliminated ? "I'm back in" : "I'm out of the game"}
    </button>
    <h3>Commander damage dealt to you</h3>
    ${rows.length ? rows.join("") : `<p class="empty-state">Nobody else is at the table yet.</p>`}`;
}

function openCounters() {
  openModal("Your counters", countersHtml());
  modalBody.classList.add("counters-modal");
  modalBody.dataset.kind = "counters";
}

$("#counter-chips").addEventListener("click", (e) => {
  if (e.target.closest("[data-counters]")) openCounters();
});

// Steppers are shared by the counters modal and the opponent menu.
modalBody.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-step]");
  if (!btn) return;
  const delta = Number(btn.dataset.delta);
  if (btn.dataset.step === "casts") {
    // The stepper shows the cost but moves by one cast, so it steps in twos.
    sendMessage({ type: "commander_casts", targetPlayerId: selfId, delta });
  } else if (btn.dataset.step === "poison") {
    sendMessage({ type: "poison", targetPlayerId: selfId, delta });
  } else {
    // Damage is always recorded on yourself, from the opponent whose
    // commander dealt it — the same direction a player tracks it physically.
    ensureAudio();
    sendMessage({ type: "commander_damage", targetPlayerId: selfId, sourcePlayerId: btn.dataset.id, delta });
  }
  // No optimistic redraw here: refreshOpenModal() runs off the state_sync the
  // server sends back, so rapid taps can't show a number the server hasn't
  // accepted, and can't lag behind one it has.
});

// Keeps a counter panel in step with the table while it's open.
function refreshOpenModal() {
  if (modalBackdrop.hidden) return;
  const kind = modalBody.dataset.kind;
  if (kind !== "counters" && kind !== "player-menu") return;
  const scroll = modalBody.scrollTop;
  if (kind === "counters") {
    modalBody.innerHTML = countersHtml();
  } else if (menuTargetId && session.players[menuTargetId]) {
    openPlayerMenu(menuTargetId);
  }
  modalBody.scrollTop = scroll;
}

// Elimination: a slow descending minor figure, longer and lower than a damage
// hit so it reads as final rather than as another point of damage.
function playLethal() {
  [330, 262, 196, 147].forEach((freq, i) =>
    tone({ freq, duration: 1.1, type: "triangle", gain: 0.17, delay: i * 0.16 })
  );
  tone({ freq: 98, duration: 1.6, type: "sine", gain: 0.2, delay: 0.55 });
}

// ---------- elimination ----------
// Explicit rather than inferred. Marking someone out takes them out of the
// rotation, so it's confirmed first and always reversible — a player at 0 life
// may still be playing, and a player at 40 may have decked out or conceded.
function confirmEliminate(playerId, eliminated) {
  const player = session.players[playerId];
  if (!player) return;
  const isSelf = playerId === selfId;
  const who = isSelf ? "yourself" : player.displayName;
  const pronoun = isSelf ? "You'll" : "They'll";
  openModal(
    eliminated ? "Out of the game?" : "Back in?",
    `<p>${
      eliminated
        ? `Mark <strong>${escapeHtml(who)}</strong> as eliminated? ${pronoun} be skipped when the turn passes.`
        : `Put <strong>${escapeHtml(who)}</strong> back into the turn order?`
    }</p>
     <div class="player-menu">
       <button class="btn btn-primary" type="button" data-elim="yes"
         data-id="${escapeHtml(playerId)}" data-value="${eliminated}">
         ${eliminated ? "Yes, they're out" : "Yes, back in"}
       </button>
       <button class="btn btn-secondary" type="button" data-elim="no">Cancel</button>
     </div>`
  );
}

modalBody.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-elim]");
  if (!btn) return;
  if (btn.dataset.elim === "yes") {
    ensureAudio();
    sendMessage({
      type: "set_eliminated",
      targetPlayerId: btn.dataset.id,
      eliminated: btn.dataset.value === "true",
    });
  }
  closeModal();
});

// Your own toggle lives with your other loss-condition state.
modalBody.addEventListener("click", (e) => {
  if (e.target.closest("[data-self-elim]")) {
    const self = session.players[selfId];
    confirmEliminate(selfId, !self?.eliminated);
  }
});

// Says who currently holds each table state, since only one player can.
function tableHolderNote() {
  const lines = [];
  const monarch = session.players[session.monarchPlayerId];
  const initiative = session.players[session.initiativePlayerId];
  if (monarch) lines.push(`${escapeHtml(monarch.displayName)} has the monarch.`);
  if (initiative) lines.push(`${escapeHtml(initiative.displayName)} has the initiative.`);
  return lines.length ? `<p class="menu-note">${lines.join(" ")}</p>` : "";
}

modalBody.addEventListener("click", (e) => {
  const which = e.target.closest("[data-table]")?.dataset.table;
  if (!which) return;
  sendMessage({ type: "set_table_state", which, playerId: selfId });
});
