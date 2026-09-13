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
let session = { players: {}, hostId: null, ambientActivePlayerId: null, mode: "colocated" };
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
  const badge = $("#host-badge");
  badge.hidden = !self.isHost;
  badge.textContent =
    session.mode === "remote"
      ? "Remote — sounds on all devices"
      : "Local — sounds play here";

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
        session.mode = msg.state.mode || "colocated";
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

document.querySelectorAll(".btn-mode").forEach((btn) => {
  btn.addEventListener("click", async () => {
    ensureAudio();
    $("#home-error").hidden = true;
    btn.disabled = true;
    try {
      const res = await fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: btn.dataset.mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create a game");
      enterLobby(data.code);
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
    updateKindLabels();
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
}

function clearCommanderResolution() {
  expectedIdentity = null;
  expectedCommanderName = null;
  setNote("");
  identityWarning.hidden = true;
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
  modalBody.innerHTML = bodyHtml;
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

const LOGIN_HTML = `
  <p class="placeholder-flag">Not built yet — this is a placeholder.</p>
  <p>Accounts will save your commanders, favorites and custom sound packages
  across devices. Hosting will need an account; other players will still be
  able to join as guests with the default sounds.</p>
`;

$("#btn-help").addEventListener("click", () => openModal("How this works", HELP_HTML));
$("#btn-oracle").addEventListener("click", () => openModal("Ask the Oracle", ORACLE_HTML));
$("#btn-login").addEventListener("click", () => openModal("Log in", LOGIN_HTML));
