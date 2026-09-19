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
const chip = async (c) => {
  await page.click(`[data-cifilter="${c}"]`);
  await page.waitForTimeout(100);
};
const filterState = () => page.evaluate(() => ({
  chips: [...document.querySelectorAll("[data-cifilter]")].map((b) => b.dataset.cifilter),
  on: [...document.querySelectorAll("[data-cifilter].is-on")].map((b) => b.dataset.cifilter),
  count: document.querySelector(".ci-count")?.textContent.trim() || "",
  exact: document.querySelector("[data-ciexact]")?.textContent.trim() || null,
  clear: !!document.querySelector("[data-ciclear]"),
}));
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
  // A third deck, so the colour filter has something to narrow.
  await saveDeckRow("Atraxa, Grand Unifier", "WUBG");
  await loadRecords();
});
await toStats();
{
  const rows = await listRows();
  check("one list, every deck on it", rows.length === 3, JSON.stringify(rows));
  // Decks saved but never played used to vanish under a By colours tab that
  // read the server's GROUP BY over finished games. There is one list now, and
  // a saved deck is on it whether or not a game has finished.
  check("including ones with no games yet",
    rows.every((r) => /0.*0/.test(r)), JSON.stringify(rows));
}
{
  const f = await filterState();
  // Only colours actually in the collection get a chip: a control that can
  // only ever return nothing is worse than no control. Derived from the data
  // rather than hard-coded, so it keeps testing that as the fixtures change.
  const present = await page.evaluate(() => {
    const seen = new Set();
    for (const r of commanderRows()) {
      const ci = r.identity === "C" ? "" : canonicalIdentity(r.identity || "");
      if (ci === "") seen.add("C");
      for (const c of ci) seen.add(c);
    }
    return ["W", "U", "B", "R", "G", "C"].filter((c) => seen.has(c));
  });
  check("a chip per colour present, and no others",
    f.chips.join("") === present.join(""), `${f.chips.join("")} vs ${present.join("")}`);
  check("and there is more than one to choose from", f.chips.length > 1, f.chips.join(""));
  check("none picked to begin with", f.on.length === 0, JSON.stringify(f.on));
  check("and it says what the chips are for", /Tap a colour/i.test(f.count), f.count);
  check("with nothing to clear yet", f.clear === false);
}
{
  const pips = await page.evaluate(() =>
    [...document.querySelectorAll("#records-list .fav-row")]
      .map((li) => li.querySelectorAll(".color-dot").length));
  check("each deck shows its colours", pips.sort().join() === "1,2,4",
    JSON.stringify(pips));
}

console.log("\nnarrowing by colour");
{
  await chip("U");
  const rows = await listRows();
  const f = await filterState();
  check("blue narrows to the blue decks", rows.length === 2, JSON.stringify(rows));
  check("the chip reads as picked", f.on.join("") === "U", f.on.join(""));
  check("and the count says how far it narrowed", /2 of 3 decks/.test(f.count), f.count);
  check("with a way back to everything", f.clear === true);
  // One colour can't be "exact" in any useful sense.
  check("and no exact toggle on a single colour", f.exact === null, String(f.exact));
}
{
  await chip("B");
  const rows = await listRows();
  const f = await filterState();
  // Contains, not equals: each tap narrows, which is what a chip row implies.
  check("a second colour narrows further", rows.length === 1, JSON.stringify(rows));
  check("to the deck that has both", /Shorikai|Atraxa/.test(rows[0] || ""), rows[0]);
  check("now the exact toggle appears", f.exact !== null, String(f.exact));
  check("offering the other reading", /Any deck with these/i.test(f.exact), f.exact);
}
{
  await page.click("[data-ciexact]");
  await page.waitForTimeout(100);
  const rows = await listRows();
  const f = await filterState();
  // Exactly UB is a deck nobody here has — and saying so beats an empty list
  // that reads like the decks went missing.
  check("exactly those colours can be none of them", rows.length === 0, JSON.stringify(rows));
  check("and the screen says why", await page.evaluate(() =>
    /No decks in those colours/i.test(document.querySelector("#records-list").textContent)));
  check("offering the way out", await page.evaluate(() =>
    /Any deck with these/i.test(document.querySelector("#records-list").textContent)));
  check("the toggle now reads the other way", /Exactly these colours/i.test(f.exact), f.exact);
}
{
  await chip("B");
  const f = await filterState();
  // Dropping back to one colour makes "exact" meaningless, so it must not
  // linger and silently keep filtering.
  check("dropping to one colour retires the exact toggle", f.exact === null, String(f.exact));
  const rows = await listRows();
  check("and the list is the contains list again", rows.length === 2, JSON.stringify(rows));
}
{
  await page.click("[data-ciclear]");
  await page.waitForTimeout(100);
  const rows = await listRows();
  const f = await filterState();
  check("show all brings everything back", rows.length === 3, JSON.stringify(rows));
  check("and clears the chips", f.on.length === 0, JSON.stringify(f.on));
}
{
  // A filter left on from a previous visit reads as missing decks.
  await chip("U");
  await page.evaluate(() => showScreen("home"));
  await toStats();
  const f = await filterState();
  check("the screen opens showing everything", f.on.length === 0, JSON.stringify(f.on));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ndecks and games share a colour combination");
await fetch(`${BASE}/__mock`, { method: "POST",
  body: JSON.stringify({ mode: "in", state: ACCOUNT }) });
await page.reload();
await page.waitForFunction(() => sessionState === "in");
await toStats();
{
  const rows = await listRows();
  const atraxa = rows.find((r) => /Atraxa/.test(r));
  check("a played commander keeps its record", /4.*3/.test(atraxa || ""), atraxa);
  // Krenko is both a saved deck and a played commander; it must appear once.
  const krenko = rows.filter((r) => /Krenko/.test(r));
  check("a deck that has also been played is listed once", krenko.length === 1,
    JSON.stringify(krenko));
  check("and carries its games", /1.*5/.test(krenko[0] || ""), krenko[0]);
}
{
  // Filtering must never change a record — only which rows you can see.
  const before = await page.evaluate(() =>
    commanderRows().reduce((a, r) => ({ w: a.w + r.wins, l: a.l + r.losses }), { w: 0, l: 0 }));
  await chip("R");
  const filtered = await page.evaluate(() => ({
    shown: document.querySelectorAll("#records-list .fav-row").length,
    all: commanderRows().length,
  }));
  await page.click("[data-ciclear]");
  await page.waitForTimeout(100);
  const after = await page.evaluate(() =>
    commanderRows().reduce((a, r) => ({ w: a.w + r.wins, l: a.l + r.losses }), { w: 0, l: 0 }));
  check("a filter hides rows rather than changing them",
    JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
  check("and it really was hiding some", filtered.shown < filtered.all,
    JSON.stringify(filtered));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ntapping a commander");
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
