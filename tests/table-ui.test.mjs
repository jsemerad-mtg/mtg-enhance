// Four things that were wrong or missing at the table:
//   - tapping a saved commander did nothing visible
//   - the lethal banner named poison for a player who had taken damage
//   - commanders could only arrive by playing a game
//   - the soundboard was one row in a screen with room for two

import pw from "playwright";
const { chromium } = pw;

const BASE = process.env.MTGE_TEST_BASE || "http://127.0.0.1:8232";
// Set MTGE_CHROMIUM to a browser binary; otherwise Playwright picks its own.
const LAUNCH = process.env.MTGE_CHROMIUM ? { executablePath: process.env.MTGE_CHROMIUM } : {};
let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}
const SIGNED_IN = { mode: "in", state: { email: "jay@example.com", name: "Jay", all: false,
  identities: ["WUBG"], slotsTotal: 5, slotsUsed: 1, slotsLeft: 4 } };

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));

// The mock process outlives a single suite, so start from a known set of decks.
await fetch(`${BASE}/__reset`, { method: "POST" });
await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify(SIGNED_IN) });
await page.goto(BASE);
await page.waitForFunction(() => sessionState === "in");
await page.waitForFunction(() => recordsState === "ready");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ntapping a saved commander");
{
  // Get to the lobby the way a player does.
  await page.evaluate(async () => {
    chooseMode("join");
    document.querySelector("#input-code").value = "abcd";
    await startChosenMode();
  });
  const r = await page.evaluate(() => ({
    screen: currentScreen,
    chips: [...document.querySelectorAll(".fav-chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  }));
  check("the lobby shows the saved commanders", r.screen === "lobby" && r.chips.length > 0,
    JSON.stringify(r).slice(0, 160));
  // They came from /api/decks, not only from localStorage — the point of
  // merging is that a commander added on another device is here too.
  check("including ones that only exist server-side",
    r.chips.some((c) => /Shorikai/.test(c)), r.chips.join(" | "));
}
{
  const before = await page.evaluate(() => ({
    value: document.querySelector("#input-commander").value,
    hint: document.querySelector("#sit-hint").textContent,
    hintHidden: document.querySelector("#sit-hint").hidden,
  }));
  check("nothing is filled in yet", before.value === "");
  check("and the button says a commander is missing", /commander/i.test(before.hint), before.hint);
  check("without having to touch a field first", before.hintHidden === false, String(before.hintHidden));
}
{
  const after = await page.evaluate(() => {
    document.querySelector("#input-name").value = "Jay";
    updateSitButton();
    setBracket("3");
    [...document.querySelectorAll(".fav-chip")].find((c) => /Krenko/.test(c.textContent)).click();
    return {
      value: document.querySelector("#input-commander").value,
      colors: [...document.querySelectorAll(".color-toggle input:checked")].map((i) => i.value),
      note: document.querySelector("#commander-note").textContent,
      hint: document.querySelector("#sit-hint").textContent,
      hintHidden: document.querySelector("#sit-hint").hidden,
      disabled: document.querySelector("#btn-sit-down").disabled,
      chosen: document.querySelectorAll(".fav-chip.chosen").length,
    };
  });
  check("the name lands in the field above", after.value === "Krenko, Mob Boss", after.value);
  check("with its colours ticked", after.colors.join("") === "R", after.colors.join(""));
  check("and the note names them", /R —|red/i.test(after.note), after.note);
  // The actual bug: .value set in code fires no input event, so nothing was
  // recomputing this and the button stayed disabled under a stale complaint.
  check("the 'still need a commander' hint clears", after.hintHidden === true && after.hint === "",
    JSON.stringify({ h: after.hint, hid: after.hintHidden }));
  check("and you can sit down", after.disabled === false);
  check("exactly one chip reads as picked", after.chosen === 1, String(after.chosen));
}
{
  const r = await page.evaluate(() => {
    [...document.querySelectorAll(".fav-chip")].find((c) => /Shorikai/.test(c.textContent)).click();
    return {
      value: document.querySelector("#input-commander").value,
      colors: [...document.querySelectorAll(".color-toggle input:checked")].map((i) => i.value).join(""),
      chosen: document.querySelectorAll(".fav-chip.chosen").length,
    };
  });
  check("changing your mind replaces it", r.value === "Shorikai, Genesis Engine", r.value);
  check("colours follow", r.colors === "WU", r.colors);
  check("and still only one chip is picked", r.chosen === 1, String(r.chosen));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nwhat 'that's lethal' actually means");
const lethalFor = (self) => page.evaluate((s) => {
  selfId = "me";
  session.players = { me: { id: "me", displayName: "Jay", commanderCasts: 0, ...s },
                      opp: { id: "opp", displayName: "Sam" } };
  const html = countersHtml();
  const banner = html.match(/<p class="lethal-banner">([\s\S]*?)<\/p>/);
  return banner ? banner[1].replace(/\s+/g, " ").trim() : null;
}, self);
{
  const b = await lethalFor({ lifeTotal: 12, poison: 0, commanderDamage: {} });
  check("a healthy player gets no banner", b === null, String(b));
}
{
  const b = await lethalFor({ lifeTotal: -2, poison: 0, commanderDamage: {} });
  // The reported bug, exactly: -2 life, no poison, and the app announced ten
  // poison counters because the message only ever chose between poison and
  // commander damage.
  check("at -2 life it says the life is gone", /no life left/i.test(b || ""), String(b));
  check("and does not invent poison counters", !/poison/i.test(b || ""), String(b));
}
{
  const b = await lethalFor({ lifeTotal: 0, poison: 0, commanderDamage: {} });
  check("zero counts too", /no life left/i.test(b || ""), String(b));
}
{
  const b = await lethalFor({ lifeTotal: 30, poison: 10, commanderDamage: {} });
  check("real poison is still named", /10 poison counters/.test(b || ""), String(b));
  check("without claiming the life is gone", !/no life left/i.test(b || ""), String(b));
}
{
  const b = await lethalFor({ lifeTotal: 30, poison: 0, commanderDamage: { opp: 21 } });
  check("commander damage is named", /21 commander damage/.test(b || ""), String(b));
}
{
  const b = await lethalFor({ lifeTotal: -3, poison: 10, commanderDamage: { opp: 22 } });
  check("all three at once read as a sentence",
    b === "That's lethal — no life left, 21 commander damage from one commander and 10 poison counters.",
    String(b));
}
{
  const b = await lethalFor({ lifeTotal: 18, poison: 7, commanderDamage: { opp: 14 } });
  check("close but not lethal stays quiet", b === null, String(b));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nadding a commander without playing a game");
await page.evaluate(() => { showScreen("home"); });
await page.click('[data-pick="stats"]');
await page.waitForFunction(() => recordsState === "ready");
{
  const r = await page.evaluate(() => ({
    actions: [...document.querySelectorAll(".records-actions .btn")].map((b) => b.textContent.trim()),
  }));
  check("both ways in are offered", r.actions.length === 2, JSON.stringify(r.actions));
  check("adding a commander comes first", /add a commander/i.test(r.actions[0] || ""), r.actions[0]);
}
{
  await page.click('[data-records="addcmdr"]');
  await page.waitForFunction(() => commanderIndexState === "ready" || commanderIndexState === "failed");
  const r = await page.evaluate(() => ({
    title: document.querySelector("#modal-title").textContent,
    focused: document.activeElement?.id,
    results: document.querySelectorAll("#cmdr-results li").length,
    indexed: commanderIndexState,
  }));
  check("the search opens ready to type", r.focused === "cmdr-search", String(r.focused));
  check("titled for the job", /add a commander/i.test(r.title), r.title);
  check("with no results until something is typed", r.results === 0, String(r.results));
  check("and the bundled index loaded", r.indexed === "ready", r.indexed);
}
{
  const r = await page.evaluate(() => {
    const box = document.querySelector("#cmdr-search");
    box.value = "a";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return document.querySelectorAll("#cmdr-results li").length;
  });
  // One letter matches thousands of commanders; the list stays empty rather
  // than showing eight arbitrary ones.
  check("one character is too little to search on", r === 0, String(r));
}
{
  const r = await page.evaluate(() => {
    const box = document.querySelector("#cmdr-search");
    box.value = "atra";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return [...document.querySelectorAll("#cmdr-results .cmdr-hit")].map((b) => ({
      name: b.querySelector(".cmdr-hit-name").textContent.trim(),
      pips: b.querySelectorAll(".color-dot").length,
      disabled: b.disabled,
    }));
  });
  check("typing finds commanders", r.length > 0, String(r.length));
  check("matches start with what was typed", /^Atra/i.test(r[0]?.name || ""), r[0]?.name);
  // The reason to pick from a list rather than type a name: the colours come
  // with it, so the row isn't created colourless.
  check("each hit shows its colours", r.every((h) => h.pips > 0), JSON.stringify(r).slice(0, 200));
}
{
  const r = await page.evaluate(() => {
    const box = document.querySelector("#cmdr-search");
    box.value = "atraxa, grand";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const hit = document.querySelector("#cmdr-results .cmdr-hit");
    return { name: hit.querySelector(".cmdr-hit-name").textContent.trim(),
             disabled: hit.disabled, text: hit.textContent.replace(/\s+/g, " ") };
  });
  check("a commander already on the list can't be added twice", r.disabled === true, JSON.stringify(r));
  check("and it's the right one", /^Atraxa, Grand/.test(r.name), r.name);
  check("and says why", /already yours/i.test(r.text), r.text);
}
{
  const r = await page.evaluate(() => {
    const box = document.querySelector("#cmdr-search");
    box.value = "Zzyzx the Unprinted";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const hit = document.querySelector("#cmdr-results .cmdr-hit");
    return { text: hit.textContent.replace(/\s+/g, " "), value: hit.dataset.addCmdr };
  });
  // A name the snapshot has never heard of — a set released since the last
  // build, or a typo they meant. Offer it rather than refusing.
  check("an unknown name is still offered", /Add .Zzyzx the Unprinted./.test(r.text), r.text);
  check("honestly, without colours", /no colours on file/i.test(r.text), r.text);
  check("and carries the typed name through", r.value === "Zzyzx the Unprinted|", r.value);
}
{
  const posted = await page.evaluate(async () => {
    const box = document.querySelector("#cmdr-search");
    box.value = "prosper, tome";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#cmdr-results .cmdr-hit").click();
    await new Promise((r) => setTimeout(r, 400));
    const res = await fetch("/__decks").then((r) => r.json());
    return {
      last: res.lastDeckPost,
      open: !document.querySelector("#modal-backdrop").hidden,
      listed: document.querySelector("#records-list").textContent.replace(/\s+/g, " "),
    };
  });
  check("picking one saves it", posted.last?.commander === "Prosper, Tome-Bound",
    JSON.stringify(posted.last));
  check("with the colours from the index", posted.last?.identity === "BR", posted.last?.identity);
  check("and no bracket or link invented", posted.last?.bracket === null && !posted.last?.deckUrl,
    JSON.stringify(posted.last));
  check("the modal closes", posted.open === false);
  check("and the commander is on the list", /Prosper, Tome-Bound/.test(posted.listed));
}
{
  // The upsert replaces every column, so adding a commander that already has a
  // bracket and a decklist must carry them back rather than blanking them.
  const r = await page.evaluate(async () => {
    await saveDeckRow("Shorikai, Genesis Engine", "WU");
    const res = await fetch("/__decks").then((r) => r.json());
    return res.decks.find((d) => d.commander === "Shorikai, Genesis Engine");
  });
  check("re-saving keeps the bracket", r?.bracket === 2, JSON.stringify(r));
  check("and keeps the decklist link", r?.deck_url === "https://moxfield.com/decks/abc", JSON.stringify(r));
}
{
  const r = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#records-list .fav-row")];
    const find = (name) => rows.find((li) => li.textContent.includes(name));
    return {
      // Atraxa in the mock has games behind it; the one just added does not.
      played: !!find("Krenko, Mob Boss")?.querySelector("[data-drop-deck]"),
      unplayed: !!find("Shorikai, Genesis Engine")?.querySelector("[data-drop-deck]"),
      // Atraxa has games but no saved deck here, so there is nothing to remove.
      recordOnly: !!find("Atraxa, Grand Unifier")?.querySelector("[data-drop-deck]"),
      spacer: !!find("Atraxa, Grand Unifier")?.querySelector(".fav-remove-spacer"),
    };
  });
  check("a deck with no games can be taken off the list", r.unplayed === true);
  // Dropping a deck row never touches game_history, so a played commander can
  // come off the list too — it just keeps its record.
  check("and so can one with games behind it", r.played === true);
  check("a record with no saved deck has nothing to remove", r.recordOnly === false);
  check("but still lines up with the rest", r.spacer === true);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe soundboard fills the space it has");
{
  const r = await page.evaluate(() => {
    localStorage.removeItem("mtge:hotkeys");
    hotkeys = loadHotkeys();
    showScreen("game");
    renderSoundboard();
    const btns = [...document.querySelectorAll("#soundboard .icon-btn")];
    return {
      count: btns.length,
      rows: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      labels: btns.map((b) => b.querySelector(".icon-caption").textContent),
      icons: btns.map((b) => b.querySelector("svg")?.innerHTML.slice(0, 40)),
      lastIsMore: btns.at(-1).id === "btn-more",
    };
  });
  check("eight buttons", r.count === 8, String(r.count));
  check("in two rows", r.rows === 2, String(r.rows));
  check("More stays last", r.lastIsMore === true);
  check("every one is labelled", r.labels.every(Boolean), JSON.stringify(r.labels));
  // Seven identical circles would be worse than three, which is why the
  // universal sounds got their own glyphs.
  check("and no two share a glyph", new Set(r.icons).size === r.icons.length,
    JSON.stringify(r.labels));
}
{
  const r = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const board = document.querySelector("#soundboard").getBoundingClientRect();
    const panel = document.querySelector(".life-event-panel").getBoundingClientRect();
    return { overflow, boardBottom: Math.round(board.bottom), panelBottom: Math.round(panel.bottom),
             viewport: window.innerHeight };
  });
  check("no sideways scroll at 390px", r.overflow === false);
  check("and the game still ends above the fold", r.panelBottom <= r.viewport,
    `${r.panelBottom} > ${r.viewport}`);
}
{
  // Existing players have three hotkeys saved. Growing the board must not
  // throw their choices away — the old `length === HOTKEY_SLOTS` check would.
  const r = await page.evaluate(() => {
    localStorage.setItem("mtge:hotkeys", JSON.stringify(["u_counter", "ambient", "r_burn"]));
    const loaded = loadHotkeys();
    return { loaded, len: loaded.length };
  });
  check("an old three-slot setting is kept", r.loaded.slice(0, 3).join() === "u_counter,ambient,r_burn",
    JSON.stringify(r.loaded));
  check("and padded out to seven", r.len === 7, String(r.len));
  check("without repeating anything", new Set(r.loaded).size === 7, JSON.stringify(r.loaded));
}
{
  const r = await page.evaluate(() => {
    localStorage.setItem("mtge:hotkeys", JSON.stringify(["broadcast", "ambient", "draw_card"]));
    return loadHotkeys().length;
  });
  check("padding never duplicates a default already held", r === 7, String(r));
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
