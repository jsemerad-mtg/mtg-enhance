// My Commanders: the two tabs are two views of one list, and tapping a
// commander shows the card before the games.

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
const ACCOUNT = { email: "j@e.com", name: "Jay", all: true, identities: [],
  slotsTotal: 5, slotsUsed: 0, slotsLeft: 5 };

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));

// Scryfall is not reachable from the test environment and would not be a
// dependency worth having anyway. Serve a stand-in card so the layout is real.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAJIAAADMCAIAAAAXnW1eAAAB7klEQVR4nO3RQQ3AIADAwDEhKEAB" +
  "/oXhgQ9pcqegScde86Pmfx3ADduSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuS" +
  "bEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuy" +
  "Lcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2" +
  "JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuS" +
  "bEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuy" +
  "Lcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2" +
  "JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuS" +
  "bEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuyLcm2JNuSbEuy" +
  "Lcm2JNuSbEuyLcm2JNuSbEs6nhwCHIDAEDEAAAAASUVORK5CYII=", "base64");
await page.route("**://api.scryfall.com/cards/named*", (route) =>
  route.request().url().includes("Nonexistent")
    ? route.fulfill({ status: 404, body: "not found" })
    : route.fulfill({ status: 200, contentType: "image/png", body: PNG }));

const toStats = async () => {
  await page.evaluate(() => showScreen("home"));
  await page.click('[data-pick="stats"]');
  await page.waitForFunction(() => recordsState === "ready");
};
const tab = async (which) => {
  await page.click(`[data-view="${which}"]`);
  await page.waitForTimeout(100);
};
const listRows = () => page.evaluate(() =>
  [...document.querySelectorAll("#records-list .fav-row")]
    .map((li) => li.textContent.replace(/\s+/g, " ").trim()));

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthree saved decks, no games finished");
await fetch(`${BASE}/__reset`, { method: "POST" });
await fetch(`${BASE}/__mock`, { method: "POST",
  body: JSON.stringify({ mode: "in", state: ACCOUNT, emptyRecords: true }) });
await page.goto(BASE);
await page.waitForFunction(() => sessionState === "in");
await page.evaluate(async () => {
  // A third deck, so the two tabs have something to disagree about.
  await saveDeckRow("Atraxa, Grand Unifier", "WUBG");
  await loadRecords();
});
await toStats();
{
  const rows = await listRows();
  check("by commander lists all three", rows.length === 3, JSON.stringify(rows));
}
{
  await tab("identity");
  const rows = await listRows();
  // The bug: this tab read the server's GROUP BY over finished games, so three
  // saved decks and no games rendered an empty screen.
  check("by colours is not empty", rows.length > 0, JSON.stringify(rows));
  check("one row per colour combination", rows.length === 3, JSON.stringify(rows));
  check("and it says how many decks each holds",
    rows.every((r) => /1 deck\b/.test(r)), JSON.stringify(rows));
  check("with zero-zero records, not blanks",
    rows.every((r) => /0.*0/.test(r)), JSON.stringify(rows));
}
{
  const pips = await page.evaluate(() =>
    [...document.querySelectorAll("#records-list .fav-row")]
      .map((li) => li.querySelectorAll(".color-dot").length));
  check("each row shows its colours", pips.join() === "4,2,1" || pips.join() === "1,2,4",
    JSON.stringify(pips));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ndecks and games share a colour combination");
await fetch(`${BASE}/__mock`, { method: "POST",
  body: JSON.stringify({ mode: "in", state: ACCOUNT }) });
await page.reload();
await page.waitForFunction(() => sessionState === "in");
await toStats();
{
  await tab("identity");
  const rows = await listRows();
  const wubg = rows.find((r) => /4.*3/.test(r));
  check("a played commander keeps its record", !!wubg, JSON.stringify(rows));
  // Krenko is both a saved deck and a played commander; it must appear once.
  const reds = rows.filter((r) => /^Red/.test(r));
  check("a deck that has also been played counts once", reds.length === 1, JSON.stringify(reds));
  check("and carries its games", /1.*5/.test(reds[0] || ""), reds[0]);
}
{
  // Totals must agree across the two tabs, or one of them is lying.
  const sums = await page.evaluate(() => {
    const add = (rows) => rows.reduce((a, r) => ({ w: a.w + r.wins, l: a.l + r.losses }), { w: 0, l: 0 });
    return { byCommander: add(commanderRows()), byIdentity: add(identityRows()) };
  });
  check("the two tabs add up to the same record",
    JSON.stringify(sums.byCommander) === JSON.stringify(sums.byIdentity), JSON.stringify(sums));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ntapping a commander");
await tab("commander");
{
  await page.click('[data-history="Atraxa, Grand Unifier"]');
  await page.waitForFunction(() => !!document.querySelector(".card-peek .card-image"));
  await page.waitForFunction(() => {
    const b = document.querySelector("#history-body");
    return b && !/Loading/.test(b.textContent);
  });
  const r = await page.evaluate(() => {
    const img = document.querySelector(".card-peek .card-image");
    const body = document.querySelector("#history-body");
    return {
      title: document.querySelector("#modal-title").textContent,
      loaded: img.complete && img.naturalWidth > 0,
      src: img.getAttribute("src"),
      alt: img.getAttribute("alt"),
      // The card must not eat the whole modal — the games are the other half.
      imgBottom: Math.round(img.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
      meta: document.querySelector(".card-peek-meta").textContent.replace(/\s+/g, " ").trim(),
      pips: document.querySelectorAll(".card-peek-meta .color-dot").length,
      games: body.querySelectorAll(".history-entry").length,
      historyVisible: body.getBoundingClientRect().height > 0,
    };
  });
  check("the modal is titled with the commander", r.title === "Atraxa, Grand Unifier", r.title);
  check("the card image loads", r.loaded === true);
  check("from Scryfall, by exact name", /api\.scryfall\.com\/cards\/named\?exact=/.test(r.src), r.src);
  check("and is labelled for a screen reader", r.alt === "Atraxa, Grand Unifier", r.alt);
  check("the card leaves room for the games", r.imgBottom < r.viewport, `${r.imgBottom} / ${r.viewport}`);
  check("its colours are shown beside it", r.pips === 4, String(r.pips));
  check("with the record", /4.*3/.test(r.meta), r.meta);
  check("and the history is still there underneath", r.games === 2, String(r.games));
  check("and visible", r.historyVisible === true);
}
{
  const closed = await page.evaluate(() => {
    document.querySelector("#modal-close").click();
    return document.querySelector("#modal-backdrop").hidden;
  });
  check("and it closes", closed === true);
}
{
  // A deck with no games: the card is the whole point of opening it.
  await page.click('[data-history="Shorikai, Genesis Engine"]');
  await page.waitForFunction(() => !!document.querySelector(".card-peek .card-image"));
  await page.waitForFunction(() => {
    const b = document.querySelector("#history-body");
    return b && !/Loading/.test(b.textContent);
  });
  const r = await page.evaluate(() => ({
    meta: document.querySelector(".card-peek-meta").textContent.replace(/\s+/g, " ").trim(),
    body: document.querySelector("#history-body").textContent.replace(/\s+/g, " ").trim(),
  }));
  check("an unplayed deck says so rather than showing 0–0 as a record",
    /No finished games yet/i.test(r.meta), r.meta);
  check("and the history explains itself", /No games recorded/i.test(r.body), r.body);
  await page.evaluate(() => closeModal());
}
{
  // Scryfall 404s on a name it doesn't have — a typo, or a hand-typed entry.
  const r = await page.evaluate(async () => {
    await saveDeckRow("Nonexistent Commander", "");
    await loadRecords();
    return document.querySelector('[data-history="Nonexistent Commander"]') !== null;
  });
  check("a hand-typed commander still gets a row", r === true);

  await page.click('[data-history="Nonexistent Commander"]');
  await page.waitForFunction(() => {
    const f = document.querySelector(".card-peek");
    return f && !f.querySelector("img");
  }, { timeout: 5000 });
  const after = await page.evaluate(() => ({
    peek: document.querySelector(".card-peek").textContent.replace(/\s+/g, " ").trim(),
    broken: document.querySelectorAll(".card-peek img").length,
    body: !!document.querySelector("#history-body"),
  }));
  // A broken-image glyph in the middle of the modal reads as a broken app.
  check("a missing card drops the image instead of showing a broken one", after.broken === 0);
  check("and says why", /No card image/i.test(after.peek), after.peek);
  check("the history still renders below it", after.body === true);
  await page.evaluate(() => closeModal());
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
