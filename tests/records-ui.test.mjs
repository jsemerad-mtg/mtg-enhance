// My Commanders: records, the guest case, and the unreachable case.

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

// The mock server outlives any one suite, so reset its decks first — otherwise
// whatever the last suite wrote is still here and the row counts drift.
await fetch(`${BASE}/__reset`, { method: "POST" });

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));

console.log("\nsigned out");
await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify({ mode: "out", state: null }) });
await page.goto(BASE);
await page.waitForFunction(() => typeof recordsState !== "undefined");
{
  await page.click('[data-pick="stats"]');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    screen: currentScreen,
    text: document.querySelector("#records-list").textContent.replace(/\s+/g, " "),
    // Picking this must not arm the Create/Join flow.
    chosen: chosenMode,
    detailHidden: document.querySelector("#mode-detail").hidden,
  }));
  check("it goes straight to the screen", r.screen === "stats", r.screen);
  check("without arming a game mode", r.chosen === null && r.detailHidden === true, JSON.stringify(r));
  check("and invites signing in rather than showing an empty table",
    /Sign in and your wins and losses are kept/i.test(r.text), r.text.slice(0, 120));
}
{
  const t = await page.evaluate(() =>
    [...document.querySelectorAll("#step-train .step")].map((el) => el.querySelector(".step-label").textContent));
  check("the train shows its own two steps, not 2 of 3",
    t.join("/") === "Table/My Commanders", t.join("/"));
}

console.log("\nsigned in");
await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify(SIGNED_IN) });
await page.reload();
await page.waitForFunction(() => sessionState === "in");
await page.click('[data-pick="stats"]');
await page.waitForFunction(() => recordsState === "ready");
{
  const text = await page.evaluate(() =>
    document.querySelector("#records-list").textContent.replace(/\s+/g, " "));
  check("commanders are listed", /Atraxa, Grand Unifier/.test(text) && /Krenko, Mob Boss/.test(text));
  check("wins and losses are shown", /4.*3/.test(text) && /1.*5/.test(text), text.slice(0, 160));
  check("with a win rate", /57%/.test(text) && /17%/.test(text), text.slice(0, 200));
}
{
  const r = await page.evaluate(() => {
    showScreen("lobby");
    favorites = ["Atraxa, Grand Unifier|WUBG", "Nobody, the Unplayed|U"];
    renderFavorites();
    return document.querySelector("#favorites-list").textContent.replace(/\s+/g, " ");
  });
  check("a favorite with a record shows it", /Atraxa, Grand Unifier.*4.*3/.test(r), r.slice(0, 160));
  check("one without a record shows no badge, not a zero",
    !/Nobody, the Unplayed\s*[–\d]/.test(r), r.slice(0, 200));
}

console.log("\nnarrowing by colour");
{
  // There used to be a By colours tab here. It grouped decks into one row per
  // colour combination, showed a win rate, and opened nothing — a colour has
  // no history of its own, so the rows were a dead end. Colour is a filter on
  // the one list now, and every row still opens.
  const r = await page.evaluate(() => {
    showScreen("stats");
    renderRecords();
    return {
      // Scoped: [data-view] also names the opponents boxes/rows toggle on the
      // game screen, which has nothing to do with this.
      tabs: document.querySelectorAll("#records-list [data-view]").length,
      chips: document.querySelectorAll("#records-list [data-cifilter]").length,
      tappable: document.querySelectorAll("[data-history]").length,
      text: document.querySelector("#records-list").textContent.replace(/\s+/g, " "),
    };
  });
  check("the tabs are gone", r.tabs === 0, String(r.tabs));
  check("chips in their place", r.chips > 1, String(r.chips));
  // Three, not two: the list merges the game log with saved decks, so a deck
  // with no finished games has a row too.
  check("every deck is listed and openable", r.tappable === 3, String(r.tappable));
  check("by commander name, not colour name",
    /Atraxa/.test(r.text) && !/White · Blue · Black · Green/.test(r.text), r.text.slice(0, 160));
}
{
  const r = await page.evaluate(() => {
    document.querySelector('[data-cifilter="R"]')?.click();
    return {
      tappable: document.querySelectorAll("[data-history]").length,
      names: [...document.querySelectorAll("[data-history]")].map((b) => b.dataset.history),
    };
  });
  check("picking red narrows the list", r.tappable < 3, String(r.tappable));
  check("to the red decks", r.names.every((n) => /Krenko/.test(n)), JSON.stringify(r.names));
  // Filtering must never cost a row its history.
  check("which still open", r.tappable > 0, String(r.tappable));
  await page.evaluate(() => document.querySelector("[data-ciclear]")?.click());
}

console.log("\npast games for one commander");
{
  await page.evaluate(() => document.querySelector('[data-history]').click());
  await page.waitForFunction(() => /Won|Lost/.test(document.querySelector("#modal-body").textContent));
  const text = await page.evaluate(() =>
    document.querySelector("#modal-body").textContent.replace(/\s+/g, " "));
  check("a played game lists the whole table",
    /Jay/.test(text) && /Sam/.test(text) && /Krenko, Mob Boss/.test(text), text.slice(0, 200));
  check("the result is stated, not inferred", /Won/.test(text) && /Lost/.test(text));
  check("the bracket shows when it was recorded", /Bracket 3/.test(text), text.slice(0, 200));
  check("a manual game says so rather than showing an empty table",
    /Added by hand/.test(text), text.slice(0, 260));
  const winnerMarked = await page.evaluate(() =>
    !!document.querySelector(".seat-won .seat-name"));
  check("the winner is marked in the table, not left to be worked out", winnerMarked);
}
{
  const before = await page.evaluate(() => document.querySelectorAll(".history-entry").length);
  await page.evaluate(() => document.querySelector("[data-forget]").click());
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => document.querySelectorAll(".history-entry").length);
  check("removing a game takes it off the list", after === before - 1, `${before} -> ${after}`);
}

console.log("\nadding a game played elsewhere");
{
  const r = await page.evaluate(() => {
    closeModal();
    showScreen("stats");
    renderRecords();
    document.querySelector('[data-records="add"]').click();
    const text = document.querySelector("#modal-body").textContent.replace(/\s+/g, " ");
    const opts = [...document.querySelectorAll("#manual-bracket option")].map((o) => o.textContent);
    return { text, opts };
  });
  check("explains it counts the same", /counts exactly the same/i.test(r.text), r.text.slice(0, 140));
  check("bracket is optional and says so", r.opts[0] === "Not sure", r.opts.join("|"));
  check("all five brackets are offered", r.opts.length === 6, String(r.opts.length));
  check("named, not just numbered", /1 — Exhibition/.test(r.opts[1]) && /5 — cEDH/.test(r.opts[5]), r.opts.join("|"));
}
{
  const r = await page.evaluate(() => {
    document.querySelector("#manual-commander").value = "";
    document.querySelector('[data-manual="1"]').click();
    const err = document.querySelector("#manual-error");
    return { hidden: err.hidden, text: err.textContent };
  });
  check("an empty commander is refused", r.hidden === false && /Name the commander/i.test(r.text), r.text);
}
{
  // The identity must come along, or a hand-added Atraxa game lands in a
  // second, colourless row instead of joining the played ones.
  const sent = await page.evaluate(async () => {
    let captured = null;
    const real = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes("/api/history/manual")) { captured = JSON.parse(o.body); }
      return real(u, o);
    };
    document.querySelector("#manual-commander").value = "Atraxa, Grand Unifier";
    document.querySelector("#manual-bracket").value = "4";
    await submitManualGame(true);
    window.fetch = real;
    return captured;
  });
  check("sends the commander", sent?.commander === "Atraxa, Grand Unifier", JSON.stringify(sent));
  check("sends the bracket as a number", sent?.bracket === 4, JSON.stringify(sent?.bracket));
  check("sends won:true", sent?.won === true);
  check("and carries the colours we already knew", sent?.identity === "WUBG", String(sent?.identity));
}

console.log("\nconfirming a win");
{
  const r = await page.evaluate(() => {
    closeModal();
    openModal("Last one standing", confirmWinHtml(["Sam", "Ali"]));
    return document.querySelector("#modal-body").textContent.replace(/\s+/g, " ");
  });
  check("names who's out", /Sam, Ali/.test(r), r.slice(0, 120));
  check("asks rather than announcing", /Did you win this game\?/.test(r));
  // The whole point of the confirmation: "no" must not be read as "I lost".
  check("says no records nothing at all", /records nothing at all/.test(r), r.slice(0, 240));
  check("and spells out that the losses aren't recorded either",
    /not even the losses/.test(r), r.slice(0, 260));
  check("offers manual entry as the way back", /add the game by hand later/.test(r));
}
{
  const sent = await page.evaluate(() => {
    let captured = null;
    const realSend = window.sendMessage;
    window.sendMessage = (m) => { captured = m; return true; };
    document.querySelector('[data-win="1"]').click();
    window.sendMessage = realSend;
    return captured;
  });
  check("yes claims the win", sent?.type === "claim_win" && sent?.won === true, JSON.stringify(sent));
}
{
  const sent = await page.evaluate(() => {
    openModal("Last one standing", confirmWinHtml(["Sam"]));
    let captured = null;
    const realSend = window.sendMessage;
    window.sendMessage = (m) => { captured = m; return true; };
    document.querySelector('[data-win="0"]').click();
    window.sendMessage = realSend;
    return captured;
  });
  check("no sends a real answer, not silence", sent?.type === "claim_win" && sent?.won === false,
    JSON.stringify(sent));
}
{
  const r = await page.evaluate(() => {
    openModal("Game over", gameOverHtml("Sam", false));
    return document.querySelector("#modal-body").textContent.replace(/\s+/g, " ");
  });
  check("the table is told who won", /Sam won/.test(r), r.slice(0, 120));
  check("and that guests keep no record", /Guests at the table/.test(r), r.slice(0, 200));
}

console.log("\nunreachable");
{
  const r = await page.evaluate(async () => {
    // Force the failure path without touching the mock's session state.
    const real = window.fetch;
    window.fetch = (u, o) => (String(u).includes("/api/records")
      ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) }) : real(u, o));
    await loadRecords();
    window.fetch = real;
    return { state: recordsState, text: document.querySelector("#records-list").textContent.replace(/\s+/g, " ") };
  });
  check("a failed load is 'failed', not 'no records'", r.state === "failed", r.state);
  check("and says so without implying a reset",
    /Couldn't load your records/i.test(r.text) && /isn't a reset/i.test(r.text), r.text.slice(0, 140));
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
