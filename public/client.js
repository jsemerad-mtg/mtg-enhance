// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const screens = {
  home: $("#screen-home"),
  lobby: $("#screen-lobby"),
  stats: $("#screen-stats"),
  game: $("#screen-game"),
};
// ---------- where you are, and how to get back ----------
// Three steps today. The list is data rather than markup so that adding a step
// later (deck import, table settings) is one entry, not a hunt through HTML.
const GAME_STEPS = [
  { id: "home", label: "Table" },
  { id: "lobby", label: "Commander" },
  { id: "game", label: "Game" },
];

// My Commanders is a destination, not a stage of setting up a game, so it gets
// its own two-step train rather than pretending to be step 2 of 3 with no step
// 1 and no step 3. Same affordance — the first step is still the way back.
const STATS_STEPS = [
  { id: "home", label: "Table" },
  { id: "stats", label: "My Commanders" },
];

const stepsFor = (screen) => (screen === "stats" ? STATS_STEPS : GAME_STEPS);

let currentScreen = "home";

function showScreen(name) {
  for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
  currentScreen = name;
  renderSteps();
  // Each screen is a history entry, so the phone's back gesture moves back a
  // step instead of leaving the site. Without this, Android's back button
  // drops you out of a game you're in the middle of — which reads as the app
  // crashing, not as navigation.
  const atTop = history.state?.screen === name;
  if (!atTop) history.pushState({ screen: name }, "", location.pathname);
  // The wheel can only be positioned once its screen is actually rendered.
  if (name === "game" && typeof positionWheel === "function") positionWheel();
}

function renderSteps() {
  const nav = $("#step-train");
  if (!nav) return;
  const steps = stepsFor(currentScreen);
  const at = steps.findIndex((s) => s.id === currentScreen);
  nav.innerHTML = steps.map((step, i) => {
    const state = i < at ? "done" : i === at ? "current" : "todo";
    // Only completed steps are reachable. Jumping *forward* would skip the
    // work each step exists to collect.
    const tag = state === "done" ? "button" : "span";
    const attrs =
      state === "done"
        ? ` type="button" data-step="${step.id}"`
        : state === "current"
          ? ' aria-current="step"'
          : "";
    return `<${tag} class="step is-${state}"${attrs}>
      <span class="step-dot">${i + 1}</span><span class="step-label">${escapeHtml(step.label)}</span>
    </${tag}>`;
  }).join('<span class="step-line" aria-hidden="true"></span>');
}

// Going back from a game means leaving the table, so it asks first. Going back
// from the lobby costs nothing — no seat has been taken yet.
function goToStep(id) {
  if (currentScreen === "game" && id !== "game") {
    openModal(
      "Leave the table?",
      `<p>You'll drop out of this game. The others keep playing, and you can
       rejoin with the same code.</p>
       <button class="btn btn-primary" type="button" data-step-confirm="${escapeHtml(id)}">Leave</button>
       <div class="auth-links">
         <button class="link-btn" type="button" data-step-cancel="1">Stay</button>
       </div>`
    );
    return;
  }
  showScreen(id);
}

// Deliberately sets leftGame BEFORE closing the socket. The close handler
// schedules a reconnect, and without the flag the app would cheerfully put the
// player straight back into the game they just chose to leave.
function leaveTable() {
  leftGame = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try { ws?.close(); } catch {}
  ws = null;
  setConnection("offline");
}

document.addEventListener("click", (e) => {
  const back = e.target.closest("[data-step]");
  if (back) return goToStep(back.dataset.step);
  const confirm = e.target.closest("[data-step-confirm]");
  if (confirm) {
    const to = confirm.dataset.stepConfirm;
    closeModal();
    leaveTable();
    showScreen(to);
    return;
  }
  if (e.target.closest("[data-step-cancel]")) closeModal();
});

// The browser's own back button, wired to the same rules — including the
// confirmation, so a back gesture can't silently drop someone out of a game.
window.addEventListener("popstate", (e) => {
  const target = e.state?.screen || "home";
  if (target === currentScreen) return;
  if (currentScreen === "game" && target !== "game") {
    // Put the entry back before asking: if they choose to stay, the history
    // has to still reflect where they actually are.
    history.pushState({ screen: "game" }, "", location.pathname);
    goToStep(target);
    return;
  }
  showScreen(target);
});

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

// Oracle answer arriving at the table: a soft two-note chime, rising, clearly
// not a combat sound. Deliberately quieter than anything in the soundboard —
// it announces information, not an attack, and it can land while someone is
// mid-sentence.
function playOracleChime() {
  tone({ freq: 587, duration: 0.14, type: "sine", gain: 0.14 });
  tone({ freq: 880, duration: 0.22, type: "sine", gain: 0.12, delay: 0.11 });
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

// ---------- muting one player ----------
// The header's mute is a setting: silence everything. This is a social tool:
// silence the one person hammering the taunt button, and keep playing.
//
// Local and private by design. Nobody is told they've been muted, and nothing
// is sent to the table — the point is to carry on with someone who is being
// annoying, not to open a conversation about it.
//
// Session-scoped, keyed by player id, deliberately not remembered: ids are
// issued per table, and a mute silently surviving into a game three weeks
// later is a surprise nobody asked for.
const mutedPlayers = new Set();

// ---------- undoing a life change someone else made ----------
// Flash and undo, not an accept gate. Commander life totals move constantly
// and correctly without the affected player's input — combat damage,
// symmetrical effects, "each opponent loses 3" — so requiring four
// acknowledgements per board wipe would turn the fastest part of the app into
// the slowest, and an unacknowledged change leaves the table's totals in
// disagreement, which is worse than a wrong total nobody noticed.
//
// One pending undo, always the most recent. A second change replacing the
// first is the ordinary shallow-undo contract, and a queue of chips stacking
// up mid-combat is its own problem.
let pendingUndo = null;   // { eventId, byName, delta }
let undoTimer = null;

// Twelve seconds server-side, ten here — so the button disappears just before
// the window closes rather than just after, and never lies about what it does.
const UNDO_VISIBLE_MS = 10000;

function showUndo(msg) {
  pendingUndo = { eventId: msg.eventId, byName: msg.byName || "Someone", delta: msg.delta };
  renderUndo();
  clearTimeout(undoTimer);
  undoTimer = setTimeout(clearUndo, UNDO_VISIBLE_MS);
}

function clearUndo() {
  clearTimeout(undoTimer);
  undoTimer = null;
  pendingUndo = null;
  renderUndo();
}

function renderUndo() {
  const chip = $("#undo-chip");
  if (!chip) return;
  chip.hidden = !pendingUndo;
  if (!pendingUndo) return;
  const { delta, byName } = pendingUndo;
  $("#undo-text").textContent =
    `${delta > 0 ? "+" : "\u2212"}${Math.abs(delta)} from ${byName}`;
}

const playerMuted = (id) => !!id && mutedPlayers.has(id);

function toggleMutePlayer(id) {
  if (mutedPlayers.has(id)) mutedPlayers.delete(id);
  else mutedPlayers.add(id);
  render();
}

// ---------- how opponents are drawn ----------
// Boxes pack two to a row; rows give each opponent the full width. Neither wins
// outright — boxes are compact with an even number of opponents and leave a
// visible hole with an odd one, while rows never leave a hole but cost height.
// So it's the player's call, remembered per device.
const OPP_VIEW_KEY = "mtge:oppview";
let oppView = readJson(OPP_VIEW_KEY, null);   // "boxes" | "rows" | null = not chosen

// Until someone chooses, follow the count: pair up when the opponents divide
// evenly, stack when they don't. A first-time player never sees the empty cell,
// and the first tap on the toggle pins their preference for good.
function effectiveOppView(count) {
  // One opponent in a two-column grid is a card beside an empty cell, which is
  // never what anyone wants — and the toggle is hidden at that count, so a
  // stored "boxes" would be unfixable. Rows regardless.
  if (count < 2) return "rows";
  if (oppView === "boxes" || oppView === "rows") return oppView;
  return count % 2 === 0 ? "boxes" : "rows";
}

const VIEW_ICONS = {
  boxes: `<svg class="hdr-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="3.5" y="4" width="7.4" height="6.6" rx="1.6"/><rect x="13.1" y="4" width="7.4" height="6.6" rx="1.6"/><rect x="3.5" y="13.4" width="7.4" height="6.6" rx="1.6"/><rect x="13.1" y="13.4" width="7.4" height="6.6" rx="1.6"/></svg>`,
  rows: `<svg class="hdr-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="3.5" y="4.4" width="17" height="4.4" rx="1.4"/><rect x="3.5" y="9.8" width="17" height="4.4" rx="1.4"/><rect x="3.5" y="15.2" width="17" height="4.4" rx="1.4"/></svg>`,
};

// The button shows the view it would switch TO, which is the convention every
// list/grid toggle uses — showing the current state reads as "you are here"
// and people tap it expecting nothing to happen.
function renderOppViewToggle(count, view) {
  const head = $("#opponents-head");
  const btn = $("#btn-opp-view");
  if (!head || !btn) return;
  // One opponent draws the same either way, so there is nothing to choose.
  head.hidden = count < 2;
  if (head.hidden) return;
  const next = view === "boxes" ? "rows" : "boxes";
  btn.innerHTML = VIEW_ICONS[next];
  const label = next === "rows" ? "Show opponents as rows" : "Show opponents as boxes";
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

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
      // Two different facts that look alike and aren't: theirs means they
      // can't hear the table, ours means we can't hear them.
      const mutedIcon = p.muted
        ? `<span class="muted-pip" title="Their sounds are off">${SPEAKER_OFF}</span>`
        : "";
      const byMeIcon = playerMuted(p.id)
        ? `<span class="muted-pip muted-by-me" title="You've muted their sounds">${SPEAKER_OFF}</span>`
        : "";
      const tableMarks = tableStateMarks(p.id);
      const commander = p.commanderName
        ? `<span class="opponent-commander" data-commander="${escapeHtml(p.commanderName)}">${escapeHtml(p.commanderName)}</span>`
        : "";
      // Two lines that each answer one question: who this is and how much life
      // they have, then what they're playing and in what colours. The pips used
      // to sit beside the name, where they pushed four-colour players' names out
      // of their own card; beside the commander they're describing the thing
      // they actually belong to.
      const deck = commander || dots
        ? `<div class="opponent-deck">${commander}${dots ? `<span class="opponent-pips">${dots}</span>` : ""}</div>`
        : "";
      return `<div class="opponent-row${active}${doomed}" data-player-id="${escapeHtml(p.id)}" role="button" tabindex="0">
        <div class="opponent-top">
          <span class="opponent-name"><span class="${dead}">${escapeHtml(p.displayName)}</span>${mutedIcon}${byMeIcon}${tableMarks}${outTag}</span>
          <span class="opponent-life">${p.lifeTotal}</span>
        </div>
        ${deck}
      </div>`;
    })
    .join("");

  const oppHost = $("#opponents");
  const view = effectiveOppView(opponents.length);
  oppHost.dataset.view = view;
  renderOppViewToggle(opponents.length, view);

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

// ---------- the protocol ----------
// Everything the server can say to this client. Lifted out of the socket's own
// message listener so it can be called directly — a protocol handler reachable
// only through a live WebSocket is a protocol handler with no tests.
function handleMessage(msg) {
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
      // Stopping is never blocked. Skipping ambient_off because its owner is
      // muted would leave their music playing here with nothing to end it.
      if (msg.soundId !== "ambient_off" && playerMuted(msg.fromPlayerId)) break;
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
      if (msg.soundId === "oracle") playOracleChime();
      if (LIBRARY_BY_ID[msg.soundId]) playLibrarySound(msg.soundId);
      break;
    }
    case "life_changed_by": {
      showUndo(msg);
      break;
    }
    case "life_undone": {
      // Everyone sees the number move back. Without the flash, a total that
      // changes twice in five seconds looks like a bug rather than someone
      // fixing a mis-tap.
      flash(msg.playerId === selfId
        ? $("#self-panel")
        : document.querySelector(`.opponent-row[data-player-id="${CSS.escape(msg.playerId)}"]`));
      if (msg.playerId === selfId) clearUndo();
      break;
    }
    case "deck_shared": {
      oracleFeed = [{ kind: "deck", askedBy: msg.byName, commander: msg.commander,
                      url: msg.url, at: msg.at }, ...oracleFeed].slice(0, 20);
      const feedOpen = !modalBackdrop.hidden && modalBody.classList.contains("oracle-modal");
      if (feedOpen) {
        const feed = $("#oracle-feed");
        if (feed) { feed.innerHTML = oracleFeedHtml(); fillOracleCards(); }
      } else {
        oracleUnread.card += 1;
        renderOracleBadge();
      }
      if (!muted && !playerMuted(msg.byPlayerId)) playOracleChime();
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
    // Only the last player standing gets this, and only once per game.
    case "confirm_win": {
      openModal("Last one standing", confirmWinHtml(msg.opponents));
      break;
    }

    // Everyone gets this once the winner has confirmed. setNote() would have
    // been wrong here — it writes to the lobby's commander field, which
    // nobody is looking at during a game.
    case "game_over": {
      const winner = session.players?.[msg.winnerPlayerId];
      const mine = msg.winnerPlayerId === selfId;
      openModal(mine ? "You won" : "Game over", gameOverHtml(winner?.displayName, mine));
      break;
    }

    case "oracle_event": {
      receiveOracleEvent(msg);
      break;
    }
    case "sound_locked": {
      // The server refused a palette sound. In normal use this is
      // unreachable — the board doesn't render locked sounds as buttons — so
      // reaching it means our copy of the entitlements is stale, most likely
      // a purchase that landed on another device. Re-read rather than
      // arguing with the server, which is the side that knows.
      refreshSession();
      const warn = $("#board-warning");
      if (warn) {
        warn.textContent = "That palette isn't unlocked on this account.";
        warn.hidden = false;
      }
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
        // ?? not ||, deliberately: a bracket of null means "didn't say", and
        // || would silently swap that for the stored value from a previous
        // game with a different deck.
        bracket: lobbyInfo.bracket ?? stored.bracket ?? null,
        pin: lobbyInfo.pin ?? null,
      })
    );
  });

  // One line, so the protocol handler can be exercised without a live socket.
  ws.addEventListener("message", (event) => handleMessage(JSON.parse(event.data)));

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

// ---------- choosing how to start ----------
// The three buttons choose; the one below commits. Separating those matters
// because two of the three create something real on the server, and the old
// layout invited a tap on what looked like a description.
const MODES = {
  colocated: {
    action: "Create game",
    prompt: "This will create a local game where we assume everyone is at the same table — proceed?",
  },
  remote: {
    action: "Create game",
    prompt: "This will create a game where one or more players are joining remotely — proceed?",
  },
  join: {
    // Not "Continue": at the moment of pressing it, "Join game" says what is
    // about to happen and "Continue" doesn't.
    action: "Join game",
    prompt: "Enter your 4-character game code to join an existing game:",
  },
};

let chosenMode = null;

function chooseMode(mode) {
  // Not a game mode: nothing is created, so there is nothing to confirm.
  // Tapping it should just take you there, the way a tab would.
  if (mode === "stats") {
    openRecords();
    return;
  }

  chosenMode = mode;
  $("#home-error").hidden = true;

  for (const btn of document.querySelectorAll("[data-pick]")) {
    const on = btn.dataset.pick === mode;
    btn.classList.toggle("is-chosen", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }

  const detail = $("#mode-detail");
  const joining = mode === "join";
  detail.hidden = false;
  $("#mode-prompt").textContent = MODES[mode].prompt;
  $("#btn-mode-go").textContent = MODES[mode].action;

  // A PIN is something a host sets, so it only exists in the two host modes.
  $("#pin-toggle-row").hidden = joining;
  $("#input-host-pin").hidden = joining || !$("#input-pin-required").checked;
  $("#input-code").hidden = !joining;
  if (joining) $("#input-code").focus();
}

document.querySelectorAll("[data-pick]").forEach((btn) => {
  btn.addEventListener("click", () => {
    ensureAudio();
    chooseMode(btn.dataset.pick);
  });
});

async function startChosenMode() {
  if (!chosenMode) return;
  ensureAudio();
  const error = $("#home-error");
  error.hidden = true;

  if (chosenMode === "join") {
    const value = $("#input-code").value.trim().toUpperCase();
    if (value.length !== 4) {
      error.textContent = "Enter the 4-character table code.";
      error.hidden = false;
      return;
    }

    // Ask about the table before moving to it. Two things come back: whether
    // it exists at all, and whether it wants a PIN. Checking here rather than
    // after the screen change means a typo'd code is caught while the code box
    // is still in front of them, instead of dropping them into a lobby for a
    // table that was never created.
    const go = $("#btn-mode-go");
    go.disabled = true;
    go.textContent = "Checking…";
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(value)}`);
      const info = await res.json().catch(() => ({}));
      if (!info.exists) {
        error.textContent = `No table with the code ${value}. Check it with whoever is hosting.`;
        error.hidden = false;
        return;
      }
      // Carried through so the lobby doesn't have to ask a second time.
      enterLobby(value, info);
    } catch {
      // The probe failed, not the join. Go anyway — the lobby asks again, and
      // a missing or wrong PIN is still refused at sit-down.
      enterLobby(value);
    } finally {
      go.disabled = false;
      go.textContent = MODES.join.action;
    }
    return;
  }

  if ($("#input-pin-required").checked && !hostPin()) {
    error.textContent = "Enter a 4-digit PIN, or switch the PIN off.";
    error.hidden = false;
    return;
  }

  const go = $("#btn-mode-go");
  go.disabled = true;
  try {
    const res = await fetch("/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: chosenMode, pin: hostPin() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create a game");
    const pin = hostPin();
    enterLobby(data.code);
    // The host just chose this PIN; making them retype it to sit down at
    // their own table is pure friction.
    if (pin) $("#input-join-pin").value = pin;
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    go.disabled = false;
  }
}

$("#btn-mode-go").addEventListener("click", startChosenMode);

// Typing a code and pressing Enter should start the game, the way it did when
// this was a form. It stopped being a form so that one button could serve all
// three modes, but the keyboard behaviour shouldn't regress with it.
$("#input-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); startChosenMode(); }
});

function enterLobby(joinCode, knownInfo = null) {
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

  // Whether this table wants a PIN, so the field appears before they fill
  // anything in rather than after a rejected join. The join flow has usually
  // asked already and passes the answer in; hosts and rejoins haven't, so it
  // still falls back to asking.
  $("#join-pin-field").hidden = true;
  if (knownInfo) {
    $("#join-pin-field").hidden = !knownInfo.pinRequired;
    if (knownInfo.pinRequired) $("#input-join-pin").focus();
  } else {
    fetch(`/api/session/${encodeURIComponent(joinCode)}`)
      .then((r) => r.json())
      .then((info) => {
        $("#join-pin-field").hidden = !info.pinRequired;
      })
      .catch(() => {
        // Offline or the probe failed — leave the field hidden; a wrong or
        // missing PIN is still caught on join.
      });
  }

  // Arriving at the lobby with whatever the fields hold, which after a previous
  // game is not nothing. Without this the button and its hint describe the last
  // table rather than this one.
  updateSitButton();
}

// ---------- bracket ----------
// Two pieces of state, not one. "Haven't answered" and "answered: don't know"
// look the same if you only store a number — and they are completely
// different: the first should block sitting down, the second shouldn't.
let bracketAnswered = false;
let bracketValue = null;   // 1-5, or null for "??"

function setBracket(raw) {
  bracketAnswered = true;
  bracketValue = raw === "?" ? null : Number(raw);
  for (const btn of document.querySelectorAll("[data-bracket]")) {
    const on = btn.dataset.bracket === raw;
    btn.classList.toggle("is-chosen", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }
  $("#bracket-note").textContent = bracketValue
    ? `Bracket ${bracketValue} — ${BRACKETS[bracketValue]}.`
    : "No bracket recorded for this game.";
  updateSitButton();
}

// "a" / "a and b" / "a, b and c" — the shape a person would say out loud.
function listPhrase(items) {
  if (items.length <= 1) return items[0] || "";
  return items.slice(0, -1).join(", ") + " and " + items.at(-1);
}

// The button says what's missing rather than sitting there greyed out with no
// explanation — a disabled control with no reason is the most common way an
// app looks broken when it's working correctly.
function updateSitButton() {
  const btn = $("#btn-sit-down");
  const hint = $("#sit-hint");
  if (!btn) return;
  const name = $("#input-name").value.trim();
  const commander = $("#input-commander").value.trim();
  const missing = [];
  if (!name) missing.push("your name");
  if (!commander) missing.push("a commander");
  if (!bracketAnswered) missing.push("a bracket");
  btn.disabled = missing.length > 0;
  hint.textContent = missing.length ? `Still need ${listPhrase(missing)}.` : "";
  hint.hidden = missing.length === 0;
}

document.querySelectorAll("[data-bracket]").forEach((btn) => {
  btn.addEventListener("click", () => setBracket(btn.dataset.bracket));
});
$("#input-name").addEventListener("input", updateSitButton);
$("#input-commander").addEventListener("input", updateSitButton);

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
  connectAndJoin(pendingCode, { displayName, commanderName, colorIdentity, pin, bracket: bracketValue });

  // Remember the deck for next time. Fire-and-forget on purpose: this is a
  // convenience, and nobody should be kept out of a game because a deck row
  // didn't save.
  if (signedIn() && commanderName) {
    fetch("/api/decks", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commander: commanderName,
        identity: canonicalIdentity(colorIdentity.join("")),
        bracket: bracketValue,
      }),
    }).catch(() => {});
  }
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
  pop($("#btn-apply-life-event"));
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

// Built here rather than inline in the socket handler so it can be rendered
// and checked without a live game — the wording is the whole feature, and it
// is the one screen that decides whether a result is recorded at all.
function confirmWinHtml(opponents) {
  const names = (opponents || []).map(escapeHtml).join(", ");
  return `<p>Everyone else is out${names ? ` — ${names}` : ""}. Did you win this game?</p>
    <p class="field-note">Saying yes records the result for everyone at the table who's signed
    in. Saying no records nothing at all — not even the losses — and you can still add the game
    by hand later.</p>
    <button class="btn btn-primary" type="button" data-win="1">Yes, I won</button>
    <div class="auth-links">
      <button class="link-btn" type="button" data-win="0">No — don't record this game</button>
    </div>`;
}

function gameOverHtml(winnerName, mine) {
  return `<p>${mine ? "You were the last one standing." : `${escapeHtml(winnerName || "Someone")} won.`}</p>
    <p class="field-note">Recorded against each signed-in player's commander. Guests at the
    table appear in the history but keep no record of their own.</p>
    <button class="btn btn-primary" type="button" data-step-cancel="1">Close</button>`;
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
  // Setting .value in code fires no input event, so nothing else was telling
  // the sit-down button that a commander had arrived. Tapping a favorite left
  // it disabled under "Still need a commander" with the name sitting in the
  // field above it.
  updateSitButton();
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

// ---------- Ask the Oracle ----------
// Two different things behind one button, and the difference matters:
//
//   Show a card — a Scryfall lookup. Free, instant, exact, and it answers the
//   question people currently answer by holding a card up to a webcam. Only
//   the card's Scryfall id crosses the wire; every client fetches the card
//   itself, so nobody can put words on anyone else's screen this way.
//
//   Ask a rules question — a model call, grounded in the Comprehensive Rules.
//   Costs money, takes seconds, and is capped per table.
//
// The card path is listed first on purpose: it's the one most questions
// actually want, and it costs nothing.
const ORACLE_ASKS_PER_GAME = 10;

let oracleFeed = [];          // newest first
// Counted separately, because the two buttons mean different things: a card
// someone held up and a rules answer are not the same news.
let oracleUnread = { card: 0, rules: 0 };
let oracleAsking = false;

function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function micButton(target) {
  // Hidden entirely where the API is missing rather than shown-and-dead —
  // iOS Safari is the common case, and a button that does nothing when tapped
  // reads as a broken app, not an unsupported browser.
  if (!speechSupported()) return "";
  return `<button type="button" class="mic-btn" data-mic="${target}" aria-label="Dictate">🎤</button>`;
}

function oracleHtml(focus = "card") {
  const asksLeft = Math.max(0, ORACLE_ASKS_PER_GAME - (session.oracleAsked || 0));
  const cardSection = `
      <h3>Show a card</h3>
      <p class="board-hint">Puts the real card on everyone's screen — no more holding it up to the camera.</p>
      <div class="oracle-row">
        <input id="oracle-card-input" type="text" placeholder="Card name" autocomplete="off" maxlength="120" />
        ${micButton("oracle-card-input")}
        <button class="btn btn-primary btn-sm" type="button" data-oracle="card">Show</button>
      </div>
      <p id="oracle-card-note" class="field-note" hidden></p>`;

  const rulesSection = `
      <h3>Ask a rules question</h3>
      <p class="board-hint">Answered from the Comprehensive Rules, with the rule quoted.
        ${asksLeft} ${asksLeft === 1 ? "question" : "questions"} left at this table.</p>
      <div class="oracle-row">
        <textarea id="oracle-question" rows="2" maxlength="400"
          placeholder="If I sacrifice it in response to the trigger, does the trigger still resolve?"></textarea>
        ${micButton("oracle-question")}
      </div>
      <div class="oracle-row">
        <span id="oracle-count" class="field-note">0 / 400</span>
        <button class="btn btn-primary btn-sm" type="button" data-oracle="ask"
          ${asksLeft <= 0 ? "disabled" : ""}>Ask the table</button>
      </div>
      <p id="oracle-error" class="field-note error" hidden></p>`;

  // Both halves are always here — they share one feed, and someone who came to
  // look up a card often has a rules question about it a second later. What the
  // button chooses is which one they land on.
  return `
    <div class="oracle-pane">
      ${focus === "rules" ? rulesSection + cardSection : cardSection + rulesSection}

      <h3>At this table</h3>
      <div id="oracle-feed">${oracleFeedHtml()}</div>
    </div>`;
}

function oracleFeedHtml() {
  if (!oracleFeed.length) {
    return `<p class="empty-state">Nothing asked yet. Anything answered here is shown to everyone.</p>`;
  }
  return oracleFeed
    .map((e, i) =>
      e.kind === "deck"
        ? `<div class="oracle-entry">
             <p class="field-note">${escapeHtml(e.askedBy || "Someone")} shared a decklist${
               e.commander ? ` — ${escapeHtml(e.commander)}` : ""}</p>
             <a class="deck-link" href="${escapeHtml(e.url)}" target="_blank"
                rel="noopener noreferrer">${escapeHtml(prettyUrl(e.url))}</a>
           </div>`
      : e.kind === "card"
        ? `<div class="oracle-card-entry" data-scryfall="${escapeHtml(e.scryfallId)}">
             <p class="field-note">${escapeHtml(e.askedBy || "Someone")} showed a card</p>
             <div class="oracle-card-body">Loading…</div>
           </div>`
        : `<div class="oracle-entry">
             <p class="oracle-q">${escapeHtml(e.askedBy || "Someone")} asked: ${escapeHtml(e.question)}</p>
             <div class="oracle-a${longAnswer(e) ? " is-clipped" : ""}">${oracleMarkup(e.answer)}</div>
             ${longAnswer(e)
               ? `<button class="link-btn oracle-more" type="button" data-expand="${i}">Show the rest</button>`
               : ""}
           </div>`
    )
    .join("");
}

// Four or five lines is what a phone can hold mid-game without the feed
// becoming the screen. Clipped, never truncated — the whole answer is one tap
// away, and a rules answer cut off at a full stop you can't see is worse than
// no answer at all.
// The host is what tells you whether to trust a link before you tap it, so it
// leads. Everything after it is decoration at this width.
function prettyUrl(raw) {
  try {
    const u = new URL(raw);
    const tail = (u.pathname + u.search).replace(/\/$/, "");
    return u.host + (tail.length > 28 ? tail.slice(0, 27) + "\u2026" : tail);
  } catch {
    return String(raw || "").slice(0, 60);
  }
}

const LONG_ANSWER_CHARS = 300;
const longAnswer = (e) => !e.expanded && String(e.answer || "").length > LONG_ANSWER_CHARS;

// The answer is model-written text, so it is escaped first and only then given
// the two pieces of formatting it actually uses. Nothing here can introduce a
// tag, an attribute or a URL that wasn't already plain text.
function oracleMarkup(text) {
  return escapeHtml(String(text || ""))
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

// Each client resolves the card itself from the broadcast id. Scryfall blocks
// Cloudflare Worker IPs, so this could never have been a server-side fetch —
// which turns out to be the safer design anyway.
async function fillOracleCards() {
  for (const el of document.querySelectorAll("[data-scryfall]")) {
    if (el.dataset.filled) continue;
    el.dataset.filled = "1";
    const body = el.querySelector(".oracle-card-body");
    try {
      const res = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(el.dataset.scryfall)}`);
      if (!res.ok) throw new Error(String(res.status));
      const card = await res.json();
      const img = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || "";
      const oracle = card.oracle_text || card.card_faces?.map((f) => f.oracle_text).join("\n//\n") || "";
      body.innerHTML = `
        ${img ? `<img class="oracle-card-img" src="${escapeHtml(img)}" alt="${escapeHtml(card.name)}" loading="lazy" />` : ""}
        <p class="oracle-card-name">${escapeHtml(card.name)}</p>
        <p class="oracle-card-text">${escapeHtml(oracle).replace(/\n/g, "<br>")}</p>`;
    } catch {
      body.textContent = "Couldn't load that card.";
    }
  }
}

function openOracle(focus = "card") {
  // Both counters clear: the feed they're about to read holds everything.
  oracleUnread = { card: 0, rules: 0 };
  renderOracleBadge();
  openModal(focus === "rules" ? "Ask a rules question" : "Show a card", oracleHtml(focus));
  modalBody.classList.add("oracle-modal");
  fillOracleCards();
  const field = $(focus === "rules" ? "#oracle-question" : "#oracle-card-input");
  if (field) field.focus();
}

// The button pulses until it's opened. Someone mid-turn shouldn't have to watch
// the screen to know something landed — but it also stops the moment they look.
function renderOracleBadge() {
  badgeButton($("#btn-card-lookup"), oracleUnread.card, "Show a card to the table", "new card");
  badgeButton($("#btn-rules"), oracleUnread.rules, "Ask a rules question", "new answer");
}

function badgeButton(btn, count, label, noun) {
  if (!btn) return;
  btn.classList.toggle("has-news", count > 0);
  btn.setAttribute(
    "aria-label",
    count > 0 ? `${label} — ${count} ${noun}${count === 1 ? "" : "s"}` : label
  );
}

function receiveOracleEvent(msg) {
  oracleFeed = [msg, ...oracleFeed].slice(0, 20);
  const open = !modalBackdrop.hidden && modalBody.classList.contains("oracle-modal");
  if (open) {
    const feed = $("#oracle-feed");
    if (feed) { feed.innerHTML = oracleFeedHtml(); fillOracleCards(); }
  } else {
    oracleUnread[msg.kind === "card" ? "card" : "rules"] += 1;
    renderOracleBadge();
  }
  if (!muted) playOracleChime();
}

async function showCardToTable() {
  const input = $("#oracle-card-input");
  const note = $("#oracle-card-note");
  const name = input.value.trim();
  if (!name) return;
  note.hidden = false;
  note.textContent = "Looking it up…";
  try {
    // fuzzy, not exact: dictation and typos both produce near-misses, and
    // Scryfall is good at them.
    const res = await fetch(`${SCRYFALL_NAMED}?fuzzy=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(res.status === 404 ? "No card by that name." : `Scryfall ${res.status}`);
    const card = await res.json();
    sendMessage({ type: "oracle_card", scryfallId: card.id });
    input.value = "";
    note.textContent = `Showed ${card.name} to the table.`;
  } catch (err) {
    note.textContent = String(err.message || err);
  }
}

async function askTheOracle() {
  if (oracleAsking) return;
  const box = $("#oracle-question");
  const err = $("#oracle-error");
  const question = box.value.trim();
  err.hidden = true;
  if (!question) return;

  oracleAsking = true;
  const btn = modalBody.querySelector('[data-oracle="ask"]');
  if (btn) { btn.disabled = true; btn.textContent = "Asking…"; }
  try {
    const res = await fetch("/api/oracle/ask", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, question, askedBy: session.players?.[selfId]?.displayName || "" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    box.value = "";
    // The answer arrives over the socket like everyone else's — no special
    // case for the asker, so what they see is exactly what the table sees.
  } catch (e) {
    err.textContent = String(e.message || e);
    err.hidden = false;
  } finally {
    oracleAsking = false;
    if (btn) { btn.disabled = false; btn.textContent = "Ask the table"; }
  }
}

// ---------- dictation ----------
// Browser-native, so it costs nothing and sends no audio anywhere. It is also
// wrong often enough at a noisy table that the transcript always lands in the
// input for review rather than being submitted.
let recognition = null;
function startDictation(targetId, btn) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return;
  if (recognition) { recognition.stop(); recognition = null; btn.classList.remove("listening"); return; }
  const target = document.getElementById(targetId);
  if (!target) return;

  recognition = new Ctor();
  recognition.lang = navigator.language || "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  const before = target.value ? target.value.trim() + " " : "";

  recognition.onstart = () => btn.classList.add("listening");
  recognition.onresult = (ev) => {
    let heard = "";
    for (const result of ev.results) heard += result[0].transcript;
    target.value = (before + heard).slice(0, Number(target.maxLength) > 0 ? target.maxLength : 400);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  };
  recognition.onerror = () => { btn.classList.remove("listening"); recognition = null; };
  recognition.onend = () => { btn.classList.remove("listening"); recognition = null; };
  recognition.start();
}

// ---------- what this app collects ----------
// Written from what the code actually does, not copied from MTG Oracle's
// policy — the two apps collect different things, and a policy that describes
// the wrong app is worse than none. Points worth keeping accurate as the app
// changes: Enhance has no analytics of its own, the game lives in the Durable
// Object and is gone when the table breaks up, and a rules question DOES leave
// this app — it goes to MTG Oracle, which logs queries.
const LEGAL_HTML = `
  <p class="field-note">Last updated 14 September 2026.</p>

  <h3>The game itself</h3>
  <p>Your display name, commander, life total and counters live in the table's
  session while the game is running, and are gone once everyone leaves. Nothing
  about a game is kept afterwards.</p>

  <h3>Your browser</h3>
  <p>Your hotkey choices, mute setting, favorite commanders and the code of the
  table you were last in are stored on this device only. Clearing site data
  removes them. Nothing in there is sent to us.</p>

  <h3>If you sign in</h3>
  <p>Signing in happens on MTG Oracle, and this app reads the same account:
  your email address, your display name and what you've purchased. There is no
  password in this app and no sign-in of its own.</p>

  <h3>Cards</h3>
  <p>Card names and images come from
  <a href="https://scryfall.com" target="_blank" rel="noopener">Scryfall</a>,
  fetched by your browser as you type or look a card up. Those requests go to
  Scryfall directly and are subject to their privacy policy.</p>

  <h3>Rules questions</h3>
  <p>A rules question leaves this app. It is sent to MTG Oracle, answered using
  Anthropic's Claude, and logged there along with the answer for debugging and
  abuse prevention. The question and the answer are also shown to everyone at
  your table &mdash; that's the point of the feature, but it's worth knowing
  before you type something you'd rather keep to yourself.</p>

  <h3>Dictation</h3>
  <p>The microphone button uses your browser's own speech recognition. Some
  browsers &mdash; Chrome among them &mdash; do this by sending the audio to
  the browser maker's servers. We never receive the audio, but we also can't
  control what your browser does with it.</p>

  <h3>What we don't do</h3>
  <p>No analytics, no advertising, no tracking cookies, no selling anything to
  anyone. The only cookie is the sign-in session shared with MTG Oracle.</p>

  <p class="field-note">Questions, or want data associated with your account
  removed? Contact us through
  <a href="https://mtg-oracle.com" target="_blank" rel="noopener">mtg-oracle.com</a>.</p>
`;

$("#btn-legal").addEventListener("click", () => openModal("What this app collects", LEGAL_HTML));

$("#btn-help").addEventListener("click", () => openModal("How this works", HELP_HTML));
$("#btn-card-lookup").addEventListener("click", () => openOracle("card"));
$("#btn-rules").addEventListener("click", () => openOracle("rules"));

// Expanding is remembered on the entry itself, so a new answer arriving and
// re-rendering the feed doesn't collapse the one someone is reading.
modalBody.addEventListener("click", (e) => {
  const more = e.target.closest("[data-expand]");
  if (!more) return;
  const entry = oracleFeed[Number(more.dataset.expand)];
  if (!entry) return;
  entry.expanded = true;
  const feed = $("#oracle-feed");
  if (feed) { feed.innerHTML = oracleFeedHtml(); fillOracleCards(); }
});

modalBody.addEventListener("input", (e) => {
  if (e.target.id === "import-box") return renderImportPreview();
  if (e.target.id === "cmdr-search") return renderCommanderSearch(e.target.value);
  if (e.target.id !== "oracle-question") return;
  const count = $("#oracle-count");
  if (count) count.textContent = `${e.target.value.length} / 400`;
});

modalBody.addEventListener("click", (e) => {
  const mic = e.target.closest("[data-mic]");
  if (mic) return startDictation(mic.dataset.mic, mic);

  const action = e.target.closest("[data-oracle]")?.dataset.oracle;
  if (action === "card") return showCardToTable();
  if (action === "ask") return askTheOracle();
});


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

function flash(el, cls = "glow", ms = 1400) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // restart the animation if it's already running
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

// Sound and motion fire off the same server event, so every device at the
// table sees the control move at the moment it hears it.
function pop(el) {
  flash(el, "trigger-pop", 540);
}

function showActivity(playerId, soundId) {
  const playerBox =
    playerId === selfId
      ? $("#self-panel")
      : document.querySelector(`.opponent-row[data-player-id="${CSS.escape(playerId)}"]`);
  flash(playerBox);
  const control = $(ACTIVITY_CONTROL[soundId]) || document.querySelector(`[data-sound-id="${CSS.escape(soundId)}"]`);
  if (control) {
    flash(control);
    pop(control);
  }
}

// ---------- commander card viewer ----------
// format=image returns the card art directly, so there's no JSON round trip.
// Browser-side only: Scryfall blocks Cloudflare Worker IPs.
function openCardModal(name) {
  openModal(name, `<img class="card-image" src="${escapeHtml(scryfallImage(name))}" alt="${escapeHtml(name)}" />`);
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

// Inline SVG rather than emoji: the emoji speaker renders in its own colours
// (blue on most platforms) and fights the palette.
const SPEAKER_ON = `<svg class="hdr-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" stroke="none"/><path d="M16.5 8.8a4.5 4.5 0 0 1 0 6.4M19 6.2a8 8 0 0 1 0 11.6"/></svg>`;
const SPEAKER_OFF = `<svg class="hdr-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" stroke="none"/><path d="m16.5 9.5 5 5M21.5 9.5l-5 5"/></svg>`;

function renderMuteButton() {
  const btn = $("#btn-mute");
  btn.innerHTML = muted ? SPEAKER_OFF : SPEAKER_ON;
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

  // Library sounds used to share one generic glyph, which was fine when only
  // three slots existed and none of them held a library sound. Seven slots of
  // the same circle would be a row of identical buttons.
  swords: `<path d="M14.5 14.5 20 20M9.5 14.5 4 20" /><path d="M18 3.5h2.5V6l-8 8-2.5-2.5 8-8Z" /><path d="M6 3.5H3.5V6l8 8 2.5-2.5-8-8Z" />`,
  burst: `<path d="m12 2.5 2.3 5.6 5.9.4-4.5 3.9 1.4 5.8L12 15.1l-5.1 3.1 1.4-5.8-4.5-3.9 5.9-.4L12 2.5Z" />`,
  crown: `<path d="M3.5 8 7 11l5-6.5 5 6.5 3.5-3-1.7 9.6a1 1 0 0 1-1 .8H6.2a1 1 0 0 1-1-.8L3.5 8Z" />`,
  shield: `<path d="M12 3.2 19 6v5c0 4.2-2.9 7.9-7 8.8C7.9 18.9 5 15.2 5 11V6l7-2.8Z" />`,
  land: `<path d="M3 18.5h18" /><path d="m5 18.5 4.6-6.6 2.7 3.6 2-2.2 4.7 5.2" /><circle cx="17" cy="6.5" r="2" />`,
  counter: `<circle cx="12" cy="12" r="8.6" /><path d="m8.4 8.4 7.2 7.2" />`,
  shuffle: `<path d="M16.5 3.5H21v4.5" /><path d="M3 21 21 3.5" /><path d="M21 16v5h-4.5" /><path d="m15 15 6 6" /><path d="m3 3.5 5.5 5.5" />`,
  skull: `<path d="M12 3c-4.3 0-7.8 3.2-7.8 7.2 0 2.4 1.2 4.4 3.1 5.7V19a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1v-3.1c1.9-1.3 3.1-3.3 3.1-5.7C19.8 6.2 16.3 3 12 3Z" /><circle cx="9.3" cy="10.6" r="1.5" /><circle cx="14.7" cy="10.6" r="1.5" />`,
};

const LIBRARY_ICONS = {
  attack: "swords",
  combat_damage: "burst",
  commander_damage: "crown",
  block: "shield",
  land_drop: "land",
  counter_stack: "counter",
  shuffle: "shuffle",
  eliminated: "skull",
};

const BUILTINS = {
  broadcast: { label: "Wipe", icon: "broadcast", message: () => ({ type: "trigger_broadcast" }) },
  ambient: { label: "Music", icon: "ambient", message: () => ({ type: "trigger_ambient", on: !ambientIsMine }) },
  draw_card: { label: "Draw", icon: "draw_card", message: () => ({ type: "trigger_draw_card" }) },
};

// Seven slots and More: two rows of four. The board was one row of three plus
// More, which left the bottom of the game screen empty on every phone we tried.
const DEFAULT_HOTKEYS = [
  "broadcast", "ambient", "draw_card", "attack",
  "combat_damage", "counter_stack", "land_drop",
];
const HOTKEY_SLOTS = 7;

// Migrate rather than discard. The old check was `raw.length === HOTKEY_SLOTS`,
// so growing the board would have silently thrown away the three hotkeys every
// existing player had chosen. Keep their picks, fill the new slots with
// defaults they don't already have.
function loadHotkeys() {
  let stored = [];
  try {
    const raw = JSON.parse(localStorage.getItem("mtge:hotkeys") || "null");
    if (Array.isArray(raw)) stored = raw.filter((id) => typeof id === "string");
  } catch {}
  const kept = stored.slice(0, HOTKEY_SLOTS);
  for (const id of DEFAULT_HOTKEYS) {
    if (kept.length >= HOTKEY_SLOTS) break;
    if (!kept.includes(id)) kept.push(id);
  }
  return kept;
}
let hotkeys = loadHotkeys();

function saveHotkeys() {
  try { localStorage.setItem("mtge:hotkeys", JSON.stringify(hotkeys)); } catch {}
}

function soundMeta(id) {
  if (BUILTINS[id]) return BUILTINS[id];
  const lib = LIBRARY_BY_ID[id];
  return lib ? { label: lib.label, icon: LIBRARY_ICONS[id] || "library", library: true } : null;
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

$("#btn-undo-life").addEventListener("click", () => {
  if (!pendingUndo) return;
  sendMessage({ type: "undo_life", eventId: pendingUndo.eventId });
  // Hidden immediately rather than on the echo. The server is authoritative
  // about the number; the button is about intent, and a control that stays up
  // after you press it invites a second press.
  clearUndo();
});

// Asking to share, not supplying a link: the Worker reads the URL out of this
// player's own deck row and posts it into the table. Nothing typed in a
// browser reaches three other people's screens.
async function shareMyDeck(btn) {
  const self = session.players[selfId];
  if (!self?.commanderName || !code) return;
  btn.disabled = true;
  try {
    const res = await fetch("/api/decks/share", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, commander: self.commanderName, playerId: selfId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (e) {
    openModal("Couldn't share that", `<p>${escapeHtml(String(e.message || e))}</p>`);
  } finally {
    btn.disabled = false;
  }
}

$("#counter-chips").addEventListener("click", (e) => {
  const share = e.target.closest("[data-share-deck]");
  if (share) shareMyDeck(share);
});

$("#btn-opp-view").addEventListener("click", () => {
  const count = Math.max(0, Object.keys(session.players).length - 1);
  oppView = effectiveOppView(count) === "boxes" ? "rows" : "boxes";
  writeJson(OPP_VIEW_KEY, oppView);
  render();
});

$("#soundboard").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  ensureAudio();
  if (btn.id === "btn-more") return openSoundBoardModal();
  const id = btn.dataset.soundId;
  const meta = soundMeta(id);
  if (!meta) return;
  // Immediate feedback: the server echo re-pops it, but a press should never
  // feel like it's waiting on the network.
  pop(btn);
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

  // The universal table sounds — damage, draw, board wipe, pass turn — are
  // free for everyone, signed in or not. They're what makes the app work at a
  // table, and putting them behind a purchase would make the free tier a demo
  // rather than a thing you'd actually use.
  sections.push(
    `<h3>Universal</h3><ul class="sound-list">${SOUND_LIBRARY.universal
      .map(([id, l]) => soundRow(id, l))
      .join("")}</ul>`
  );

  const key = myIdentityKey();
  const groups = myIdentityGroups().filter((c) => (SOUND_LIBRARY[c] || []).length);

  if (identityUnlocked(key)) {
    for (const color of groups) {
      sections.push(
        `<h3>${COLOR_NAMES[color]}</h3><ul class="sound-list">${(SOUND_LIBRARY[color] || [])
          .map(([id, l]) => soundRow(id, l))
          .join("")}</ul>`
      );
    }
    return `<p class="board-hint">Tap a name to play it. Star up to ${HOTKEY_SLOTS} to keep them on the main screen.</p>
      <p id="board-warning" class="field-note error" hidden></p>${sections.join("")}`;
  }

  // Locked palettes are shown, not hidden: a list you can read is a far better
  // pitch than an absence, and it tells the player exactly what their deck
  // would get. Nothing here is playable or starrable.
  const locked = (rows) =>
    `<ul class="sound-list locked">${rows
      .map(([, label]) => `<li class="sound-row"><span class="sound-play is-locked">${escapeHtml(label)}</span>
        <span class="sound-star is-locked">🔒</span></li>`)
      .join("")}</ul>`;

  // Three different asks, depending on what stands between them and the sounds.
  let cta;
  if (!signedIn()) {
    cta = `<button class="btn btn-primary upgrade-cta" type="button" data-auth="do-signin">Sign in to unlock palettes</button>`;
  } else if ((account?.slotsLeft || 0) > 0) {
    cta = `<button class="btn btn-primary upgrade-cta" type="button" data-auth="view-unlock-${escapeHtml(key)}">
      Unlock ${escapeHtml(paletteLabel(key))} — uses 1 of ${account.slotsLeft}</button>`;
  } else {
    cta = `<button class="btn btn-primary upgrade-cta" type="button" data-auth="view-upgrade">Get palette slots</button>`;
  }

  return `<p class="board-hint">Every sound above is free. The ${escapeHtml(paletteLabel(key))}
    sounds below are this deck's palette.</p>
    ${cta}
    ${sections.join("")}
    ${groups.map((c) => `<h3>${COLOR_NAMES[c]}</h3>${locked(SOUND_LIBRARY[c] || [])}`).join("")}`;
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
      <button class="btn btn-secondary" type="button" data-menu="mute">
        ${playerMuted(playerId) ? "Unmute their sounds" : "Mute their sounds"}
      </button>
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
  if (action === "mute") {
    toggleMutePlayer(menuTargetId);
    // Reopened rather than closed: muting someone mid-game is usually followed
    // by something else in this menu, and the label has to flip either way.
    return openPlayerMenu(menuTargetId);
  }
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

// ---------- accounts (the shared mtg-oracle.com session) ----------
// MTG Enhance has no sign-in of its own, by design. Signing in happens once on
// mtg-oracle.com, which issues an HMAC-signed cookie scoped to the parent
// domain; this app only reads it. A second implementation of sign-in would be a
// second thing to get wrong, and the wrong thing to get wrong.
//
// Three states, not two. "unknown" is the one that earns its keep: a request
// that never came back is NOT a signed-out player. On 2026-09-13 AdBlock Plus
// returned a bare 403 for this app's session endpoint, which a two-state model
// would have read as "signed out" — showing a paying customer an empty
// soundboard with no error and no explanation. So a failed check leaves the
// last known-good session in place and says so, and only an actual answer from
// the server can sign someone out.
const ORACLE_SITE = "https://mtg-oracle.com";
const ORACLE_API = "https://api.mtg-oracle.com";
// Not "/api/me": generic enough that filter lists match it. See the 403 above.
const SESSION_URL = "/api/player-state";
const UNLOCK_URL = "/api/unlock-identity";

const FAVORITES_KEY = "mtge:favorites";

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let sessionState = "unknown";   // "unknown" | "out" | "in"
let account = null;             // set only in the "in" state
let favorites = readJson(FAVORITES_KEY, []);

const signedIn = () => sessionState === "in";

// The purchasable unit is a whole colour identity — one deck's worth — not a
// single colour. "C" is colorless, which needs a name of its own to be a key.
function identityKey(letters) {
  return canonicalIdentity(letters) || "C";
}

function myIdentityKey() {
  const self = session.players?.[selfId];
  return identityKey((self?.colorIdentity || []).join(""));
}

function identityUnlocked(key = myIdentityKey()) {
  if (!account) return false;
  return account.all === true || (account.identities || []).includes(key);
}

function paletteLabel(key) {
  if (key === "C") return "Colorless";
  return key.split("").map((c) => COLOR_NAMES[c]).join(" · ");
}

// ---------- talking to the server about who you are ----------
let sessionTimer = null;
let sessionAttempt = 0;
// Backs off rather than hammering: a blocked request will never succeed, and a
// tab retrying every second forever is its own bug report.
const RETRY_MS = [2000, 5000, 15000, 30000];

function applySession(next) {
  const wasSignedIn = sessionState === "in";
  account = next;
  sessionState = next ? "in" : "out";
  sessionAttempt = 0;
  renderAccountUi();
  // Signing in mid-session should bring the records with it; signing out
  // should take them away rather than leaving the last account's numbers on
  // screen next to somebody else's name.
  if (!next) { records = []; byIdentity = []; decks = []; recordsState = "guest"; renderRecords(); renderFavorites(); }
  else if (!wasSignedIn) loadRecords();
}

function renderAccountUi() {
  renderLoginButton();
  renderFavorites();
  renderFavButton();
  renderSoundboard();
  // If a board or account modal is open, redraw it so an unlock lands without
  // the player having to close and reopen anything.
  if (!modalBackdrop.hidden) {
    if (modalBody.classList.contains("sound-board")) modalBody.innerHTML = soundBoardHtml();
    else if (modalBody.classList.contains("auth-modal")) openAuth();
  }
}

async function refreshSession() {
  clearTimeout(sessionTimer);
  try {
    const res = await fetch(SESSION_URL, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applySession(data.signedIn ? data : null);
  } catch (err) {
    // Never downgrade a known-good session because one request failed.
    if (sessionState !== "in") sessionState = "unknown";
    renderAccountUi();
    const delay = RETRY_MS[Math.min(sessionAttempt, RETRY_MS.length - 1)];
    if (sessionAttempt < RETRY_MS.length) {
      sessionAttempt += 1;
      sessionTimer = setTimeout(refreshSession, delay);
    }
  }
}

// Covers both windows we open: signing in on Oracle and buying on the checkout
// page. Coming back to this tab is the signal that something may have changed,
// and it costs one small request.
window.addEventListener("focus", () => {
  if (document.visibilityState === "visible") refreshSession();
});

function openOracleSignIn() {
  // A new window, not a redirect: a redirect mid-game drops the WebSocket and
  // the player loses their seat at the table.
  const win = window.open(ORACLE_SITE, "mtgo-signin", "width=520,height=760");
  if (!win) location.href = ORACLE_SITE;
}

async function doLogout() {
  try {
    const res = await fetch(`${ORACLE_API}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applySession(null);
    closeModal();
  } catch {
    // Clearing it locally would be a lie: the cookie is still live and the next
    // reload would sign them straight back in.
    authError("Couldn't reach the sign-out service. You're still signed in.");
  }
}

function authError(message) {
  const el = $("#auth-error");
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

// ---------- account screens ----------
const AUTH_VIEWS = {
  unknown: () => ({
    title: "Account",
    body: `<p>Couldn't check your account just now, so nothing here is certain
      yet — this isn't a sign-out.</p>
      <p class="field-note">If you run an ad blocker, it may be blocking the
      request. Allowing this site fixes it.</p>
      <p id="auth-error" class="field-note error" hidden></p>
      <button class="btn btn-primary" type="button" data-auth="do-retry">Try again</button>`,
  }),

  signin: () => ({
    title: "Sign in",
    body: `<p>One account covers MTG Oracle and MTG Enhance. Signing in happens
      on MTG Oracle — come back to this tab afterwards and you'll be signed in
      here too.</p>
      <p class="field-note">You don't need an account to host or join a game.
      It's for saving favorite commanders and for anything you've bought.</p>
      <p id="auth-error" class="field-note error" hidden></p>
      <button class="btn btn-primary" type="button" data-auth="do-signin">Sign in at MTG Oracle</button>`,
  }),

  account: () => {
    const owned = account?.identities || [];
    const palettes = account?.all
      ? `<p class="palette-count">Every colour identity unlocked.</p>`
      : `<p class="palette-count">${account?.slotsLeft || 0} palette ${
          (account?.slotsLeft || 0) === 1 ? "slot" : "slots"
        } left of ${account?.slotsTotal || 0}</p>
        ${
          owned.length
            ? `<ul class="fav-list">${owned
                .map((k) => `<li class="fav-row"><span class="fav-name">${escapeHtml(paletteLabel(k))}</span>${pipsHtml(k === "C" ? "" : k)}</li>`)
                .join("")}</ul>`
            : `<p class="empty-state">No palettes unlocked yet.</p>`
        }
        <button class="btn btn-primary btn-sm palette-more" type="button" data-auth="view-upgrade">Get more palettes</button>`;
    return {
      title: account?.name || "Your account",
      body: `<p class="account-email">${escapeHtml(account?.email || "")}</p>
        <div class="palette-panel">${palettes}</div>

        <h3>Favorite commanders</h3>
        ${favoritesEditorHtml()}

        <p id="auth-error" class="field-note error" hidden></p>
        <div class="auth-links">
          <button class="link-btn" type="button" data-auth="do-logout">Log out</button>
        </div>`,
    };
  },

  upgrade: () => ({
    title: "Palettes",
    body: `<p>Every table sound — damage, draw, board wipe, pass turn — is free
      and always will be. Palettes are the sounds written for one deck's colour
      identity, and you unlock them a deck at a time.</p>
      <ul class="price-list">
        <li><strong>5 palettes — $4.99.</strong> Enough for five decks. Buy it
          again whenever you build more.</li>
        <li><strong>Every palette — $14.99.</strong> All 32 identities, forever.</li>
      </ul>
      <p class="field-note">Checkout isn't live yet.</p>
      <button class="btn btn-primary upgrade-cta" type="button" data-auth="do-checkout">Open checkout</button>
      <div class="auth-links">
        <button class="link-btn" type="button" data-auth="view-account">Back</button>
      </div>`,
  }),

  // Spending a slot is permanent, so it gets a real confirmation naming both
  // what they're buying into and what it costs them. Without this, one game
  // with a borrowed deck silently burns a slot.
  unlock: (key) => ({
    title: `Unlock ${paletteLabel(key)}?`,
    body: `<p>This uses <strong>1 of your ${account?.slotsLeft || 0}</strong>
      remaining palette slots. The ${escapeHtml(paletteLabel(key))} palette is
      then yours permanently, on every device.</p>
      <p class="field-note">Playing a one-off deck? Skip it — the universal
      table sounds work for any commander.</p>
      <p id="auth-error" class="field-note error" hidden></p>
      <button class="btn btn-primary" type="button" data-unlock="${escapeHtml(key)}">Use a slot</button>
      <div class="auth-links">
        <button class="link-btn" type="button" data-auth="do-close">Not now</button>
      </div>`,
  }),
};

function defaultAuthView() {
  if (sessionState === "unknown") return "unknown";
  return signedIn() ? "account" : "signin";
}

function openAuth(view = defaultAuthView(), arg) {
  const { title, body } = AUTH_VIEWS[view](arg);
  openModal(title, body);
  modalBody.classList.add("auth-modal");
}

// ---------- commander records ----------
// Win/loss per commander, recorded server-side when a game ends with one
// player standing. Guests have none — there is nowhere to store them — and the
// screen says that rather than showing an empty table, which reads as data
// that went missing.
let records = [];          // [{ commander, identity, wins, losses }]
let byIdentity = [];       // the same games grouped by colour identity
let decks = [];            // [{ id, commander, identity, bracket, deck_url }]
let recordsState = "idle"; // "idle" | "loading" | "ready" | "failed" | "guest"
// Decks failing while records load is its own state: the records are true, the
// list of commanders is short, and saying nothing is how the last two database
// faults hid. A banner is enough — losing the whole screen over it would be a
// worse trade than the missing rows.
let decksFailed = false;

function recordFor(name) {
  const key = String(name || "").toLowerCase();
  return records.find((r) => String(r.commander).toLowerCase() === key) || null;
}

function recordBadge(name) {
  const r = recordFor(name);
  if (!r) return "";
  return `<span class="wl" title="${r.wins} won, ${r.losses} lost">
    <span class="wl-w">${r.wins}</span><span class="wl-sep">–</span><span class="wl-l">${r.losses}</span>
  </span>`;
}

async function loadRecords() {
  if (recordsState === "loading") return;
  recordsState = "loading";
  decksFailed = false;
  try {
    const res = await fetch("/api/records", { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // A 200 whose query threw is not an empty account. `ok` is absent on older
    // deployments, so only an explicit false counts as a failure.
    if (data.ok === false) throw new Error("query failed");
    records = Array.isArray(data.byCommander) ? data.byCommander : [];
    byIdentity = Array.isArray(data.byIdentity) ? data.byIdentity : [];
    recordsState = data.signedIn ? "ready" : "guest";

    // Decks are a separate table from the game log, and the list needs both: a
    // deck saved but never played to a finish still deserves a row, and a
    // commander with games but no saved deck still needs somewhere to put a
    // link. Losing them costs rows, not records — so the screen still renders,
    // and says what's missing rather than quietly showing a shorter list.
    try {
      const dres = await fetch("/api/decks", { credentials: "include", cache: "no-store" });
      if (!dres.ok) throw new Error(`HTTP ${dres.status}`);
      const ddata = await dres.json();
      if (ddata.ok === false) throw new Error("query failed");
      decks = Array.isArray(ddata.decks) ? ddata.decks : [];
    } catch {
      decks = [];
      decksFailed = true;
    }
  } catch {
    // Same rule as the session check: a request that didn't come back is not
    // evidence that someone has no record.
    recordsState = "failed";
  }
  renderRecords();
  renderFavorites();
}

const BRACKETS = { 1: "Exhibition", 2: "Core", 3: "Upgraded", 4: "Optimized", 5: "cEDH" };

// "By commander" and "By colours" are the same games grouped two ways —
// someone with six mono-red decks cares more about how red does than how each
// build does. It's one log and two GROUP BYs on the server, so offering both
// costs a toggle, not a feature.
let recordsView = "commander";

function winRate(w, l) {
  const played = w + l;
  return played ? `${Math.round((w / played) * 100)}%` : "—";
}

// One row per commander, from the game log and the deck list together. A deck
// with no finished games still belongs here — that is exactly when someone
// wants to paste the decklist in.
function commanderRows() {
  const byName = new Map();
  for (const r of records) {
    byName.set(r.commander.toLowerCase(), {
      commander: r.commander, identity: r.identity || "",
      wins: r.wins, losses: r.losses, deck: null,
    });
  }
  for (const d of decks) {
    const key = d.commander.toLowerCase();
    const row = byName.get(key);
    if (row) { row.deck = d; if (!row.identity) row.identity = d.identity || ""; }
    else byName.set(key, {
      commander: d.commander, identity: d.identity || "",
      wins: 0, losses: 0, deck: d,
    });
  }
  return [...byName.values()].sort(
    (a, b) => (b.wins + b.losses) - (a.wins + a.losses) || a.commander.localeCompare(b.commander)
  );
}

// Both tabs are two views of ONE list, so they are derived from one source.
// The colours tab used to render the server's `byIdentity`, which is a GROUP BY
// over game_history — so three saved decks with no games finished showed three
// rows under "By commander" and an empty screen under "By colours". A deck you
// have saved is yours whether or not you have finished a game with it.
function identityRows() {
  const out = new Map();
  for (const r of commanderRows()) {
    const identity = r.identity === "C" ? "" : r.identity || "";
    const row = out.get(identity) || { identity, wins: 0, losses: 0, decks: 0 };
    row.wins += r.wins;
    row.losses += r.losses;
    row.decks += 1;
    out.set(identity, row);
  }
  return [...out.values()].sort(
    (a, b) => (b.wins + b.losses) - (a.wins + a.losses) || a.identity.localeCompare(b.identity)
  );
}

function recordsHtml() {
  if (recordsState === "guest") {
    return `<p class="empty-state">Sign in and your wins and losses are kept with each
      commander, across every device you play on.</p>`;
  }
  if (recordsState === "loading" || recordsState === "idle") {
    return `<p class="empty-state">Loading…</p>`;
  }
  if (recordsState === "failed") {
    return `<p class="empty-state">Couldn't load your records just now. This isn't a
      reset — try again in a moment.</p>`;
  }

  // Records came back, saved decks didn't. Commanders you've played still show;
  // ones you saved but never finished a game with are missing, and so are the
  // brackets and decklist links.
  const deckWarning = decksFailed
    ? `<p class="load-warning">Couldn't load your saved decks, so this list may be
       short and decklist links are missing. Nothing has been deleted.</p>`
    : "";

  const toggle = `<div class="seg">
    <button type="button" class="seg-btn${recordsView === "commander" ? " is-on" : ""}"
      data-view="commander">By commander</button>
    <button type="button" class="seg-btn${recordsView === "identity" ? " is-on" : ""}"
      data-view="identity">By colours</button>
  </div>`;

  const actions = `<div class="records-actions">
    <button class="btn btn-secondary btn-sm" type="button"
      data-records="addcmdr">Add a commander</button>
    <button class="btn btn-secondary btn-sm" type="button"
      data-records="add">Add a game played elsewhere</button>
    <button class="btn btn-secondary btn-sm" type="button"
      data-records="import">Import a list</button>
  </div>`;

  const rowData = commanderRows();
  if (!rowData.length) {
    return `${toggle}
      ${deckWarning}
      <p class="empty-state">Nothing here yet. Add the commanders you play and they'll be one
      tap away at the table; results land here as games finish.</p>
      ${actions}`;
  }

  const rows = recordsView === "identity"
    ? identityRows().map((r) => `<li class="fav-row">
        <span class="fav-name">${escapeHtml(paletteLabel(r.identity || "C"))}<span class="fav-sub">${
          r.decks} ${r.decks === 1 ? "deck" : "decks"}</span></span>
        ${pipsHtml(r.identity)}
        <span class="wl"><span class="wl-w">${r.wins}</span><span class="wl-sep">–</span><span class="wl-l">${r.losses}</span></span>
        <span class="wl-pct">${winRate(r.wins, r.losses)}</span>
      </li>`)
    // Only the per-commander rows are tappable: there is no such thing as the
    // history of a colour combination, only of the decks inside it.
    : rowData.map((r) => `<li class="fav-row">
        <button type="button" class="fav-name link-name" data-history="${escapeHtml(r.commander)}">
          ${escapeHtml(r.commander)}</button>
        ${pipsHtml(r.identity === "C" ? "" : r.identity)}
        <span class="wl"><span class="wl-w">${r.wins}</span><span class="wl-sep">–</span><span class="wl-l">${r.losses}</span></span>
        <span class="wl-pct">${winRate(r.wins, r.losses)}</span>
        <button type="button" class="clip-btn${r.deck?.deck_url ? " has-link" : ""}"
          data-deck="${escapeHtml(r.commander)}"
          aria-label="${r.deck?.deck_url ? "Edit the decklist link for" : "Add a decklist link for"} ${escapeHtml(r.commander)}"
          title="${r.deck?.deck_url ? "Decklist attached" : "Attach a decklist"}">&#128206;</button>
        ${r.deck
          ? `<button type="button" class="fav-remove" data-drop-deck="${r.deck.id}"
               data-drop-name="${escapeHtml(r.commander)}"
               title="Take off your list — games already played are kept"
               aria-label="Take ${escapeHtml(r.commander)} off your list">&times;</button>`
          // A commander that only exists as a record — played once, never saved
          // — has nothing to remove. The spacer holds the column.
          : `<span class="fav-remove-spacer" aria-hidden="true"></span>`}
      </li>`);

  return `${toggle}${deckWarning}<ul class="fav-list">${rows.join("")}</ul>
    ${recordsView === "commander" ? `<p class="field-note">Tap a commander to see its past games.</p>` : ""}
    ${actions}`;
}

// ---------- decklist links ----------
function deckLinkHtml(row) {
  const url = row.deck?.deck_url || "";
  return `<p>Paste a link to this deck — Moxfield, Archidekt, a Google Doc, anywhere.
    It's stored as a link and nothing else; we never open or read it.</p>
    <label class="field">
      <span>Decklist URL</span>
      <input id="deck-url" type="url" inputmode="url" maxlength="500" autocomplete="off"
        placeholder="https://" value="${escapeHtml(url)}" />
    </label>
    <p id="deck-error" class="field-note error" hidden></p>
    <p id="deck-note" class="field-note" hidden></p>
    <div class="manual-actions">
      <button class="btn btn-primary" type="button" data-deck-save="${escapeHtml(row.commander)}">Save</button>
      <button class="btn btn-secondary" type="button" data-deck-copy="1"${url ? "" : " disabled"}>Copy</button>
    </div>
    ${url ? `<div class="auth-links">
      <button class="link-btn" type="button" data-deck-clear="${escapeHtml(row.commander)}">Remove the link</button>
    </div>` : ""}`;
}

function openDeckLink(commander) {
  const row = commanderRows().find((r) => r.commander === commander);
  if (!row) return;
  openModal(commander, deckLinkHtml(row));
}

async function saveDeckLink(commander, rawUrl) {
  const row = commanderRows().find((r) => r.commander === commander);
  const err = $("#deck-error");
  err.hidden = true;

  const url = rawUrl.trim();
  if (url) {
    // Checked here as well as at the server so a typo is answered instantly
    // rather than after a round trip.
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      err.textContent = "That doesn't look like a web link — it should start with https://";
      err.hidden = false;
      return false;
    }
  }

  const res = await fetch("/api/decks", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commander,
      identity: row?.identity || "",
      // The upsert replaces every column it's given, so the existing bracket
      // has to come along. Leaving it out would silently erase a bracket the
      // player set in the lobby — the kind of loss nobody notices until their
      // history stops saying what it used to.
      bracket: row?.deck?.bracket ?? null,
      deckUrl: url,
    }),
  }).catch(() => null);

  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || !data?.ok) {
    err.textContent = data?.error || "Couldn't save that link.";
    err.hidden = false;
    return false;
  }
  await loadRecords();
  return true;
}

// ---------- one commander's past games ----------
// Tapping a commander shows the card first, then everything that has happened
// with it. The card viewer already existed but was bound to double-click, which
// on a phone is close to undiscoverable — a tap on the name is the obvious
// gesture and it was spent on the history alone.
async function openHistory(commander) {
  const row = commanderRows().find((r) => r.commander === commander);
  openModal(commander, cardPeekHtml(commander, row) +
    `<div id="history-body"><p class="empty-state">Loading…</p></div>`);
  modalBody.classList.add("history-modal");
  watchCardImage();

  const body = () => $("#history-body");
  try {
    const res = await fetch(`/api/history?commander=${encodeURIComponent(commander)}`, {
      credentials: "include", cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // "No games recorded" and "the query threw" look the same from here, and
    // only one of them is worth believing.
    if (data.ok === false) throw new Error("query failed");
    if (body()) body().innerHTML = historyHtml(data.games || []);
  } catch {
    if (body()) body().innerHTML = `<p class="empty-state">Couldn't load those games just now.</p>`;
  }
}

function cardPeekHtml(commander, row) {
  const record = row && row.wins + row.losses > 0
    ? `<span class="wl"><span class="wl-w">${row.wins}</span><span class="wl-sep">–</span><span class="wl-l">${row.losses}</span></span>
       <span class="wl-pct">${winRate(row.wins, row.losses)}</span>`
    : `<span class="field-note">No finished games yet</span>`;
  return `<figure class="card-peek">
      <img class="card-image" alt="${escapeHtml(commander)}"
        src="${escapeHtml(scryfallImage(commander))}" />
      <figcaption class="card-peek-meta">${pipsHtml(row?.identity === "C" ? "" : row?.identity || "")}${record}</figcaption>
    </figure>`;
}

function scryfallImage(name) {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=normal`;
}

// A name Scryfall doesn't have — a typo, or something typed in by hand — gives a
// 404 and a broken-image glyph. Drop the figure instead: the history below it
// is still worth showing.
function watchCardImage() {
  const img = modalBody.querySelector(".card-peek .card-image");
  if (!img) return;
  img.addEventListener("error", () => {
    const fig = img.closest(".card-peek");
    if (fig) fig.innerHTML = `<p class="field-note">No card image for this name.</p>`;
  }, { once: true });
}

function historyHtml(games) {
  if (!games.length) return `<p class="empty-state">No games recorded with this commander yet.</p>`;
  return `<ul class="history-list">${games
    .map((g) => {
      const when = String(g.played_at || "").slice(0, 10);
      const bracket = g.bracket ? ` · Bracket ${g.bracket}` : "";
      // A manual row has no seats, because there was nobody to name. Showing
      // an empty table would imply the opponents were lost rather than never
      // collected.
      const table = Array.isArray(g.seats) && g.seats.length
        ? `<ul class="seat-list">${g.seats
            .map((seat) => `<li class="seat${seat.won ? " seat-won" : ""}">
              <span class="seat-name">${escapeHtml(seat.name || "Player")}</span>
              <span class="seat-cmd">${escapeHtml(seat.commander || "—")}</span>
              ${pipsHtml(seat.identity === "C" ? "" : seat.identity || "")}
            </li>`)
            .join("")}</ul>`
        : `<p class="field-note">Added by hand — no table recorded.</p>`;
      return `<li class="history-entry">
        <p class="history-head">
          <span class="history-result ${g.won ? "is-win" : "is-loss"}">${g.won ? "Won" : "Lost"}</span>
          <span class="field-note">${escapeHtml(when)}${bracket}</span>
          <button type="button" class="link-btn history-del" data-forget="${g.id}">Remove</button>
        </p>
        ${table}
      </li>`;
    })
    .join("")}</ul>`;
}

// ---------- importing a list of decks ----------
// Built for one gesture: select two columns in a spreadsheet, copy, paste.
// That arrives TAB-separated, which is why tabs are tried first and commas
// only as a fallback — and the comma path has to handle quotes, because
// "Krenko, Mob Boss" has a comma in it and a naive split would cut his name
// in half.
function splitCells(line) {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const URLISH = /^https?:\/\/\S+$/i;
// Something clearly meant as a link but missing its scheme. Worth telling
// someone about rather than silently treating "www.moxfield.com/..." as the
// name of a commander.
const HALF_URL = /^(www\.|[a-z0-9-]+\.[a-z]{2,}\/)/i;
const MONEY = /^[$£€]?[\d.,]+%?$/;
const HEADERS = /^(commander|deck|deck name|name|url|link|decklist|price|value|cost|total|notes?)$/i;
const CMDR_HEADER = /^commander$/i;
const LINK_HEADER = /^(url|link|decklist|deck ?list ?url)$/i;

// Column order is not assumed. A deck pricing sheet has price columns, the
// link might be first or last, and — the case that actually bit — the first
// text column is often the deck's nickname, not its commander. So: if the
// sheet has a header row, believe it; otherwise keep every plausible cell as
// a candidate and let resolveImportRow, which has the commander index, pick.
function parseDeckLines(text) {
  const rows = [];
  const seen = new Set();
  let cols = null;

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Indices matter once a header is in play, so the empties stay put here
    // and only the heuristics work off the filled ones.
    const cells = splitCells(line);
    const filled = cells.filter(Boolean);
    if (!filled.length) continue;

    const url = filled.find((c) => URLISH.test(c)) || "";

    // A header row names its columns. Requiring EVERY cell to be a name the
    // app knows was too strict for a real sheet, which has a "Colours" or a
    // "Check" column the app has never heard of — so a row with no link in it
    // is a header if it says "Commander" anywhere, or if every cell is a name
    // we do know.
    if (!url && (cells.some((c) => CMDR_HEADER.test(c)) || filled.every((c) => HEADERS.test(c)))) {
      const at = cells.findIndex((c) => CMDR_HEADER.test(c));
      cols = at >= 0 ? { commander: at, url: cells.findIndex((c) => LINK_HEADER.test(c)) } : null;
      continue;
    }

    const halfUrl = !url && (filled.find((c) => HALF_URL.test(c)) || "");
    const candidates = filled.filter(
      (c) => c !== url && c !== halfUrl && !URLISH.test(c) && !MONEY.test(c)
    );
    // The header wins when there is one; otherwise the first plausible cell is
    // the opening guess, which resolveImportRow may improve on.
    const named = cols && cells[cols.commander];
    const commander = (named || candidates[0] || "").trim();

    if (!commander && !url && !halfUrl) continue;

    const key = commander.toLowerCase();
    let status = "ok";
    if (!commander) status = "no-commander";
    else if (seen.has(key)) status = "duplicate";
    else if (halfUrl) status = "bad-url";
    if (commander) seen.add(key);

    rows.push({
      commander,
      url,
      halfUrl: halfUrl || "",
      // Empty when a header named the column: there is nothing left to guess.
      candidates: named ? [] : candidates,
      status,
      line,
    });
  }
  return rows;
}

// Resolution is separate from parsing so the parser stays pure and the index
// can be missing without breaking the preview.
function resolveImportRow(row) {
  if (row.status === "no-commander") {
    return { ...row, identity: "", known: false, existing: false };
  }
  const index = commanderIndexState === "ready" ? commanderIndex : null;
  const find = (name) => index && index.find((c) => c.lower === name.toLowerCase());

  let hit = find(row.commander);
  // "Goblins | Krenko, Mob Boss | $412.55 | <link>" — the first text cell is
  // the deck's nickname. If a later one is a commander the index knows and the
  // first isn't, that one is the commander.
  if (!hit) {
    for (const cell of row.candidates || []) {
      const alt = find(cell);
      if (alt) { hit = alt; break; }
    }
  }
  const name = hit ? hit.name : row.commander;
  const existing = commanderRows().find((r) => r.commander.toLowerCase() === name.toLowerCase());
  return {
    ...row,
    // The snapshot's spelling wins, so "krenko, mob boss" out of a spreadsheet
    // lands as "Krenko, Mob Boss" and matches everything else in the app.
    commander: name,
    identity: hit ? hit.ci : existing?.identity || "",
    known: !!hit,
    existing: !!existing?.deck,
  };
}

// The parser can only spot a repeat by the text on the line; once the index has
// had its say, two differently-labelled rows can turn out to be the same deck.
function resolveImportRows(rows) {
  const seen = new Set();
  return rows.map(resolveImportRow).map((r) => {
    if (r.status === "no-commander") return r;
    const key = r.commander.toLowerCase();
    const dupe = seen.has(key);
    seen.add(key);
    return dupe ? { ...r, status: "duplicate" } : r;
  });
}

const IMPORT_NOTE = {
  "no-commander": "no commander name on this line",
  duplicate: "listed more than once — only the first is used",
  "bad-url": "the link needs to start with https://",
};

function importDecksHtml() {
  return `<p>Paste two columns from a spreadsheet: the commander and its decklist
    link. Extra columns are ignored.</p>
    <label class="field">
      <span>Paste here</span>
      <textarea id="import-box" rows="4" spellcheck="false"
        placeholder="Krenko, Mob Boss\thttps://moxfield.com/decks/..."></textarea>
    </label>
    <div id="import-preview"></div>
    <p id="import-error" class="field-note error" hidden></p>`;
}

function renderImportPreview() {
  const host = $("#import-preview");
  if (!host) return;
  const rows = resolveImportRows(parseDeckLines($("#import-box")?.value || ""));
  if (!rows.length) {
    host.innerHTML = `<p class="field-note">Nothing pasted yet.</p>`;
    return;
  }
  const usable = rows.filter((r) => r.status === "ok" || r.status === "bad-url");
  const added = usable.filter((r) => !r.existing).length;
  const updated = usable.filter((r) => r.existing).length;
  const unknown = usable.filter((r) => !r.known).length;

  host.innerHTML = `
    <ul class="import-list">${rows.map((r) => `
      <li class="import-row${r.status === "ok" ? "" : " is-flagged"}">
        <span class="import-name">${escapeHtml(r.commander || r.halfUrl || r.line)}</span>
        ${r.status === "ok" || r.status === "bad-url" ? pipsHtml(r.identity) : ""}
        <span class="field-note">${
          IMPORT_NOTE[r.status]
            || (r.existing ? "already yours — link updated"
              : r.known ? (r.url ? "new" : "new, no link")
              : "new, colours unknown")
        }</span>
      </li>`).join("")}</ul>
    <p class="field-note">${added} to add${updated ? `, ${updated} to update` : ""}${
      unknown ? `, ${unknown} not in the commander list` : ""}.</p>
    <div class="manual-actions">
      <button class="btn btn-primary" type="button" data-import="go"${usable.length ? "" : " disabled"}>
        Import ${usable.length} deck${usable.length === 1 ? "" : "s"}</button>
    </div>`;
}

// One POST per deck rather than a bulk endpoint: /api/decks already validates
// the URL, carries the bracket forward and upserts, and all of that is already
// tested. A list of forty takes a few seconds and reuses every guard.
async function runImport(btn) {
  const rows = resolveImportRows(parseDeckLines($("#import-box")?.value || ""))
    .filter((r) => r.status === "ok" || r.status === "bad-url");
  if (!rows.length) return;

  const err = $("#import-error");
  err.hidden = true;
  btn.disabled = true;

  let done = 0;
  const failed = [];
  for (const row of rows) {
    btn.textContent = `Importing ${done + 1} of ${rows.length}…`;
    try {
      // A link that isn't http(s) is dropped rather than failing the row: the
      // deck is still worth having, and the preview already said so.
      await saveDeckRow(row.commander, row.identity, row.url || "");
    } catch (e) {
      failed.push(`${row.commander}: ${e.message || e}`);
    }
    done += 1;
  }

  await loadRecords();
  if (failed.length) {
    // Partial success is the honest report. The ones that landed stay landed.
    err.textContent = `${rows.length - failed.length} imported, ${failed.length} failed — ${failed[0]}`;
    err.hidden = false;
    btn.disabled = false;
    btn.textContent = "Try the rest again";
    return;
  }
  closeModal();
}

// ---------- adding a commander ----------
// Searching the same bundled snapshot the lobby autocompletes against, so this
// costs no network and arrives with the colour identity already attached —
// which is the whole reason to pick from a list rather than type a name.
function addCommanderHtml() {
  return `<p>Find a commander and it joins this list, and the chips on the table
    screen — so you can sit down with one tap instead of typing it again.</p>
    <label class="field">
      <span>Commander</span>
      <input id="cmdr-search" type="text" maxlength="80" autocomplete="off"
        placeholder="Start typing a name" />
    </label>
    <ul id="cmdr-results" class="cmdr-results"></ul>
    <p id="cmdr-error" class="field-note error" hidden></p>`;
}

function renderCommanderSearch(query) {
  const host = $("#cmdr-results");
  if (!host) return;
  const q = query.trim();
  if (q.length < SUGGEST_MIN_CHARS) { host.innerHTML = ""; return; }

  const mine = new Set(commanderRows().map((r) => r.commander.toLowerCase()));
  const hits = commanderIndexState === "ready" ? searchCommanders(q) : [];

  // No hits, or no index at all (never built, or offline): still offer to add
  // exactly what was typed. A search box that refuses an unusual name is worse
  // than one that takes it without the colours.
  if (!hits.length) {
    host.innerHTML = `<li><button type="button" class="cmdr-hit" data-add-cmdr="${escapeHtml(q)}|"
      ${mine.has(q.toLowerCase()) ? "disabled" : ""}>
      <span class="cmdr-hit-name">Add “${escapeHtml(q)}”</span>
      <span class="field-note">${mine.has(q.toLowerCase()) ? "already yours" : "no colours on file"}</span>
      </button></li>`;
    return;
  }

  host.innerHTML = hits
    .map((h) => {
      const owned = mine.has(h.name.toLowerCase());
      return `<li><button type="button" class="cmdr-hit"
        data-add-cmdr="${escapeHtml(h.name)}|${escapeHtml(h.ci)}" ${owned ? "disabled" : ""}>
        <span class="cmdr-hit-name">${escapeHtml(h.name)}</span>${pipsHtml(h.ci)}
        ${owned ? `<span class="field-note">already yours</span>` : ""}
      </button></li>`;
    })
    .join("");
}

// The deck upsert replaces every column it is given, so an existing row's
// bracket and decklist have to travel back with it. Adding a commander must
// never be a quiet way to erase one.
async function saveDeckRow(name, ci, deckUrl) {
  const existing = commanderRows().find((r) => r.commander.toLowerCase() === name.toLowerCase());
  const res = await fetch("/api/decks", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commander: name,
      identity: existing?.identity || ci,
      bracket: existing?.deck?.bracket ?? null,
      // Undefined means "leave it alone", which is what every caller but the
      // importer wants. An empty string still means "no link".
      deckUrl: deckUrl === undefined ? existing?.deck?.deck_url || "" : deckUrl,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

function rememberFavorite(name, ci) {
  const entry = `${name}|${ci}`;
  if (favorites.includes(entry)) return;
  favorites = [...favorites, entry];
  writeJson(FAVORITES_KEY, favorites);
}

async function addCommander(entry) {
  const [name, ci] = splitFavorite(entry);
  const err = $("#cmdr-error");
  if (err) err.hidden = true;
  try {
    await saveDeckRow(name, ci);
  } catch (e) {
    if (err) { err.textContent = String(e.message || e); err.hidden = false; }
    return;
  }
  // Also local, so the chips are there at the table even if the next load of
  // /api/decks doesn't come back.
  rememberFavorite(name, ci);
  closeModal();
  await loadRecords();
}

async function dropDeck(id, name) {
  await fetch(`/api/decks/${encodeURIComponent(id)}`, {
    method: "DELETE", credentials: "include",
  }).catch(() => {});
  favorites = favorites.filter((f) => splitFavorite(f)[0].toLowerCase() !== String(name).toLowerCase());
  writeJson(FAVORITES_KEY, favorites);
  await loadRecords();
}

// ---------- a game played away from the app ----------
function addGameHtml() {
  const options = favorites
    .map((f) => splitFavorite(f)[0])
    .concat(records.map((r) => r.commander))
    .filter((v, i, a) => v && a.indexOf(v) === i);
  return `<p>Played somewhere without the app? Add it here and it counts exactly the same.</p>
    <label class="field">
      <span>Commander</span>
      <input id="manual-commander" type="text" maxlength="80" autocomplete="off"
        list="manual-commanders" />
    </label>
    <datalist id="manual-commanders">${options
      .map((o) => `<option value="${escapeHtml(o)}"></option>`).join("")}</datalist>
    <label class="field">
      <span>Bracket (optional)</span>
      <select id="manual-bracket">
        <option value="">Not sure</option>
        ${Object.entries(BRACKETS).map(([n, label]) =>
          `<option value="${n}">${n} — ${label}</option>`).join("")}
      </select>
    </label>
    <p id="manual-error" class="field-note error" hidden></p>
    <div class="manual-actions">
      <button class="btn btn-primary" type="button" data-manual="1">Record a win</button>
      <button class="btn btn-secondary" type="button" data-manual="0">Record a loss</button>
    </div>`;
}

async function submitManualGame(won) {
  const name = $("#manual-commander").value.trim();
  const err = $("#manual-error");
  err.hidden = true;
  if (!name) {
    err.textContent = "Name the commander you played.";
    err.hidden = false;
    return;
  }
  const bracketRaw = $("#manual-bracket").value;
  try {
    const res = await fetch("/api/history/manual", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commander: name,
        // The colour identity of a favourite we already know, so a manually
        // added game lands in the same bucket as the played ones instead of
        // creating a second, colourless row for the same deck.
        identity: knownIdentityFor(name),
        bracket: bracketRaw ? Number(bracketRaw) : null,
        won,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    closeModal();
    await loadRecords();
  } catch (e) {
    err.textContent = String(e.message || e);
    err.hidden = false;
  }
}

// A commander's colours, from whatever we already know — an existing record
// first, then the favorites list.
function knownIdentityFor(name) {
  const key = name.toLowerCase();
  const rec = records.find((r) => String(r.commander).toLowerCase() === key);
  if (rec) return rec.identity || "";
  const fav = favorites.find((f) => splitFavorite(f)[0].toLowerCase() === key);
  return fav ? splitFavorite(fav)[1] : "";
}

function renderRecords() {
  const host = $("#records-list");
  if (host) host.innerHTML = recordsHtml();
}

function openRecords() {
  showScreen("stats");
  renderRecords();
  loadRecords();
}

$("#records-list").addEventListener("click", (e) => {
  const view = e.target.closest("[data-view]");
  if (view) {
    recordsView = view.dataset.view;
    renderRecords();
    return;
  }
  const hist = e.target.closest("[data-history]");
  if (hist) return openHistory(hist.dataset.history);
  const clip = e.target.closest("[data-deck]");
  if (clip) return openDeckLink(clip.dataset.deck);
  const drop = e.target.closest("[data-drop-deck]");
  if (drop) {
    drop.disabled = true;
    return dropDeck(drop.dataset.dropDeck, drop.dataset.dropName);
  }
  if (e.target.closest('[data-records="import"]')) {
    openModal("Import a list", importDecksHtml());
    loadCommanderIndex().then(renderImportPreview);
    renderImportPreview();
    $("#import-box")?.focus();
    return;
  }
  if (e.target.closest('[data-records="addcmdr"]')) {
    openModal("Add a commander", addCommanderHtml());
    loadCommanderIndex();
    $("#cmdr-search")?.focus();
    return;
  }
  if (e.target.closest('[data-records="add"]')) {
    openModal("Add a game", addGameHtml());
  }
});

modalBody.addEventListener("click", async (e) => {
  const save = e.target.closest("[data-deck-save]");
  if (save) {
    save.disabled = true;
    const ok = await saveDeckLink(save.dataset.deckSave, $("#deck-url").value);
    save.disabled = false;
    if (ok) closeModal();
    return;
  }

  const clear = e.target.closest("[data-deck-clear]");
  if (clear) {
    if (await saveDeckLink(clear.dataset.deckClear, "")) closeModal();
    return;
  }

  const copy = e.target.closest("[data-deck-copy]");
  if (copy) {
    const note = $("#deck-note");
    const value = $("#deck-url").value.trim();
    try {
      await navigator.clipboard.writeText(value);
      note.textContent = "Copied.";
    } catch {
      // Clipboard access is refused in plenty of ordinary situations — an
      // insecure origin, a permission prompt declined, an older browser. Say
      // so and select the text instead, so there's still a way to copy it.
      $("#deck-url").select();
      note.textContent = "Couldn't copy for you — the link is selected, so copy it now.";
    }
    note.hidden = false;
    return;
  }

  const imp = e.target.closest('[data-import="go"]');
  if (imp) return runImport(imp);

  const addCmdr = e.target.closest("[data-add-cmdr]");
  if (addCmdr) {
    addCmdr.disabled = true;
    return addCommander(addCmdr.dataset.addCmdr);
  }

  const manual = e.target.closest("[data-manual]");
  if (manual) return submitManualGame(manual.dataset.manual === "1");

  const forget = e.target.closest("[data-forget]");
  if (forget) {
    const id = forget.dataset.forget;
    forget.disabled = true;
    await fetch(`/api/history/${encodeURIComponent(id)}`, {
      method: "DELETE", credentials: "include",
    }).catch(() => {});
    forget.closest(".history-entry")?.remove();
    // The totals on the screen behind are now wrong, so re-read rather than
    // trying to decrement them here.
    loadRecords();
  }
});

// ---------- favorite commanders ----------
function favoritesEditorHtml() {
  if (!signedIn()) {
    return `<p class="empty-state">Sign in to save the commanders you play most.</p>`;
  }
  if (favorites.length === 0) {
    return `<p class="empty-state">Star a commander at the table, or add one under
      My Commanders, and it'll appear here.</p>`;
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

// The chips are My Commanders, seen from the table. Decks first — they're the
// server-side list and follow the player between devices — with local favorites
// filling in anything saved while signed out or not yet written back.
//
// The server stores colourless as "C" and the client as "", so normalise on the
// way in rather than leaving two spellings of the same identity in circulation.
function tableCommanders() {
  const out = new Map();
  for (const d of decks) {
    if (!d.commander) continue;
    const ci = d.identity === "C" ? "" : d.identity || "";
    out.set(d.commander.toLowerCase(), `${d.commander}|${ci}`);
  }
  for (const entry of favorites) {
    const key = splitFavorite(entry)[0].toLowerCase();
    if (!out.has(key)) out.set(key, entry);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}

function renderFavorites() {
  const host = $("#favorites-list");
  if (!host) return;
  if (!signedIn()) {
    host.innerHTML = `<p class="empty-state">Sign in to save the commanders you play most.</p>`;
    return;
  }
  const warning = decksFailed
    ? `<p class="load-warning">Couldn't load your saved commanders just now — only the ones
       this device remembers are shown.</p>`
    : "";
  const entries = tableCommanders();
  if (entries.length === 0) {
    host.innerHTML = warning + `<p class="empty-state">Add a commander under My Commanders, or
      star one here, and it'll be waiting next time.</p>`;
    return;
  }
  host.innerHTML = warning + `<div class="fav-chips">${entries
    .map((entry) => {
      const [name, ci] = splitFavorite(entry);
      return `<button type="button" class="fav-chip" data-preselect="${escapeHtml(entry)}">
        <span>${escapeHtml(name)}</span>${pipsHtml(ci)}${recordBadge(name)}</button>`;
    })
    .join("")}</div>
    <p class="field-note">Tap one to fill it in above.</p>`;
}

// Tapping a chip fills the commander in, here and now. It used to stash the
// choice in localStorage for the lobby to read on arrival — correct while
// favorites lived on the home screen, and a no-op the moment they moved onto
// the lobby screen itself, because the reader had already run.
$("#favorites-list").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-preselect]");
  if (!chip) return;
  const [name, ci] = splitFavorite(chip.dataset.preselect);
  applyCommander(name, ci);
  chip.classList.add("chosen");
  $("#favorites-list").querySelectorAll(".fav-chip").forEach((c) => {
    if (c !== chip) c.classList.remove("chosen");
  });
});

// One list, two places to edit it: the star here and the × under My Commanders
// do the same thing to the same row.
function savedRow(name) {
  return commanderRows().find((r) => r.commander.toLowerCase() === String(name).toLowerCase());
}

function isSaved(name, entry) {
  if (favorites.includes(entry)) return true;
  return signedIn() && !!savedRow(name)?.deck;
}

// The lobby's star: only meaningful once a commander has actually resolved,
// since a favorite without its color identity is no use later.
function renderFavButton() {
  const btn = $("#btn-fav-commander");
  if (!btn) return;
  const resolved = expectedCommanderName && expectedIdentity !== null;
  btn.hidden = !(resolved && signedIn());
  if (btn.hidden) return;
  const entry = `${expectedCommanderName}|${expectedIdentity}`;
  btn.textContent = isSaved(expectedCommanderName, entry)
    ? "★ Saved to favorites"
    : "☆ Save to favorites";
  btn.dataset.entry = entry;
}

// Held shut while a write is in flight. Fire-and-forget left a window where a
// second tap read stale decks: un-starring would find no deck row to drop, and
// the reload from the first tap then put the chip straight back.
$("#btn-fav-commander").addEventListener("click", async () => {
  const btn = $("#btn-fav-commander");
  const entry = btn.dataset.entry;
  if (!entry || btn.disabled) return;
  const [name, ci] = splitFavorite(entry);
  btn.disabled = true;

  try {
    // Starring at the table is the same act as adding one under My Commanders,
    // so it writes the same row.
    if (!isSaved(name, entry)) {
      rememberFavorite(name, ci);
      renderFavorites();
      if (signedIn()) {
        await saveDeckRow(name, ci).catch(() => {});
        await loadRecords();
      }
      return;
    }

    // And un-starring removes it, the same way the × does. What goes is the
    // saved deck — its bracket and decklist link. Games already played live in
    // a different table and are untouched, so this can never cost a record.
    const row = signedIn() ? savedRow(name) : null;
    favorites = favorites.filter((f) => splitFavorite(f)[0].toLowerCase() !== name.toLowerCase());
    writeJson(FAVORITES_KEY, favorites);
    if (row?.deck) await dropDeck(row.deck.id, name);
  } finally {
    btn.disabled = false;
    renderFavButton();
    renderFavorites();
  }
});

// ---------- auth actions ----------
// Checkout gets its own window so the game keeps its socket and its seat at the
// table. On return, the focus handler re-reads the session — entitlements live
// in D1 now, so there is nothing local to update and nothing local to fake.
function openCheckout() {
  const win = window.open("/upgrade.html", "mtge-upgrade", "width=460,height=720");
  if (!win) {
    // Popup blocked — navigating there still works, it just loses the game
    // screen until they come back.
    location.href = "/upgrade.html";
  }
}

function renderLoginButton() {
  const btn = $("#btn-login");
  if (!btn) return;
  if (sessionState === "unknown") {
    // Deliberately not "Log in": we don't know that they aren't, and offering
    // a sign-in to someone already signed in is how you get a support email.
    btn.textContent = "Account";
    btn.classList.add("is-unsure");
    return;
  }
  btn.classList.remove("is-unsure");
  btn.textContent = signedIn() ? account.name : "Log in";
}

modalBody.addEventListener("click", async (e) => {
  const win = e.target.closest("[data-win]");
  if (win) {
    sendMessage({ type: "claim_win", won: win.dataset.win === "1" });
    closeModal();
    return;
  }

  const unfav = e.target.closest("[data-unfav]");
  if (unfav) {
    favorites = favorites.filter((f) => f !== unfav.dataset.unfav);
    writeJson(FAVORITES_KEY, favorites);
    renderFavorites();
    return openAuth("account");
  }

  // Spending a palette slot. The button is only reachable from the confirm
  // screen, and the server re-checks everything anyway — this is the courtesy
  // layer, not the control.
  const unlock = e.target.closest("[data-unlock]");
  if (unlock) {
    const key = unlock.dataset.unlock;
    unlock.disabled = true;
    unlock.textContent = "Unlocking…";
    try {
      const res = await fetch(UNLOCK_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Take the server's word for the new state rather than decrementing a
      // local counter, which would drift the moment two devices are open.
      applySession({ ...account, ...data });
      // The Durable Object reads entitlements once, at the handshake, so a
      // palette bought mid-game doesn't reach it until the socket is remade.
      // Reconnecting costs a state_sync and nothing else — the seat, the life
      // totals and the turn order all come straight back.
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
        reconnectNow();
      }
      return openSoundBoardModal();
    } catch (err) {
      unlock.disabled = false;
      unlock.textContent = "Use a slot";
      return authError(String(err.message || err));
    }
  }

  const action = e.target.closest("[data-auth]")?.dataset.auth;
  if (!action) return;

  // "view-unlock-WUBG" carries its identity in the attribute, so the confirm
  // screen can name the exact palette without reaching back into game state.
  if (action.startsWith("view-unlock-")) return openAuth("unlock", action.slice("view-unlock-".length));
  if (action.startsWith("view-")) return openAuth(action.slice(5));

  if (action === "do-retry") {
    authError("");
    await refreshSession();
    return openAuth();
  }

  if (action === "do-signin") {
    openOracleSignIn();
    return closeModal();
  }

  if (action === "do-checkout") {
    openCheckout();
    return closeModal();
  }

  if (action === "do-logout") return doLogout();

  if (action === "do-close") return closeModal();
});

$("#btn-login").addEventListener("click", () => openAuth());
renderLoginButton();
renderFavorites();
refreshSession();

// The home screen starts visible rather than being switched to, so the train
// would otherwise stay empty until the first navigation. Seeding the history
// entry here also means the very first back gesture has somewhere to land.
history.replaceState({ screen: "home" }, "", location.pathname);
renderSteps();

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

// Your own saved decklist for the commander you actually sat down with. The
// link is never sent from here — this only decides whether to offer the
// button; the Worker reads the URL out of your deck row.
function myDeckUrl() {
  const self = session.players[selfId];
  const name = self?.commanderName;
  if (!name || !signedIn()) return "";
  const row = decks.find((d) => String(d.commander).toLowerCase() === name.toLowerCase());
  return row?.deck_url || "";
}

const CHIP_ICONS = {
  more: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2.1" fill="currentColor" stroke="none"/><circle cx="10" cy="16" r="2.1" fill="currentColor" stroke="none"/></svg>`,
  poison: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C7.6 2 4 5.4 4 9.6c0 2.5 1.2 4.4 3 5.6V18a1 1 0 0 0 1 1h1.2l.4 2.2a1 1 0 0 0 1 .8h2.8a1 1 0 0 0 1-.8l.4-2.2H16a1 1 0 0 0 1-1v-2.8c1.8-1.2 3-3.1 3-5.6C20 5.4 16.4 2 12 2Zm-3 9a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Zm6 0a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6Z"/></svg>`,
  tax: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 16c4-8 12-8 16 0"/><path d="M12 3v3M7.5 5l1.5 2.6M16.5 5 15 7.6"/></svg>`,
  cmdr: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 14 10M7 4l13 13M10 7 7 4 4 7l3 3M17 20l3-3"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="m8.3 10.7 7.4-4M8.3 13.3l7.4 4"/></svg>`,
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
  // Offered only when there is something to send. A share button that always
  // shows and usually errors teaches people to ignore it.
  if (myDeckUrl()) {
    chips.push(`<button type="button" class="counter-chip" data-share-deck="1"
      aria-label="Share your decklist with the table" title="Share your decklist">
      <span class="chip-icon">${CHIP_ICONS.share}</span></button>`);
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

  // Name the reasons that are actually true. This used to be a two-way choice
  // between commander damage and poison, with no branch for life — so a player
  // at zero, the most ordinary way there is to lose, was told they had ten
  // poison counters.
  const reasons = [];
  if ((self.lifeTotal ?? 1) <= 0) reasons.push("no life left");
  if (worstCommanderDamage(self) >= COMMANDER_DAMAGE_LETHAL) reasons.push("21 commander damage from one commander");
  if (poison >= POISON_LETHAL) reasons.push("10 poison counters");
  const banner = reasons.length
    ? `<p class="lethal-banner">That's lethal — ${listPhrase(reasons)}.</p>`
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
