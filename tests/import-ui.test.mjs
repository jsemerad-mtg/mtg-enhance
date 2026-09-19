// Bulk import: paste two columns out of a spreadsheet and get decks.
//
// The parser is the risky part, and it is pure, so most of this exercises it
// directly with the lines a real sheet actually produces — tabs from a copy,
// quoted commas from a CSV download, price columns nobody asked for, and a
// header row on top.

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

await fetch(`${BASE}/__reset`, { method: "POST" });
await fetch(`${BASE}/__mock`, { method: "POST",
  body: JSON.stringify({ mode: "in", state: ACCOUNT }) });

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(BASE);
await page.waitForFunction(() => sessionState === "in");

// The index gives the importer its colours and its spelling. Load it once.
await page.evaluate(() => loadCommanderIndex());
await page.waitForFunction(() => commanderIndexState === "ready");

const parse = (text) => page.evaluate((t) => parseDeckLines(t), text);
// What the preview actually shows: parsed, then given the index's opinion.
const resolve = (text) => page.evaluate((t) => resolveImportRows(parseDeckLines(t)), text);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\ntwo columns copied out of a spreadsheet");
{
  // This is what a copy out of Google Sheets puts on the clipboard: tabs.
  const rows = await parse(
    "Krenko, Mob Boss\thttps://moxfield.com/decks/abc\n" +
    "Miirym, Sentinel Wyrm\thttps://archidekt.com/decks/123"
  );
  check("both lines parse", rows.length === 2, String(rows.length));
  check("the commander keeps its comma", rows[0].commander === "Krenko, Mob Boss", rows[0].commander);
  check("and the link comes through", rows[0].url === "https://moxfield.com/decks/abc", rows[0].url);
  check("both are usable", rows.every((r) => r.status === "ok"), rows.map((r) => r.status).join(","));
}

console.log("\na CSV download instead of a copy");
{
  // File → Download → CSV quotes any cell containing a comma. A naive split on
  // "," cuts Krenko's name in half, which is the whole reason for the quote
  // handling.
  const rows = await parse(
    '"Krenko, Mob Boss",https://moxfield.com/decks/abc\n' +
    'Shorikai, Genesis Engine,https://moxfield.com/decks/def'
  );
  check("a quoted name survives the comma", rows[0].commander === "Krenko, Mob Boss", rows[0].commander);
  check("its link is still the link", rows[0].url === "https://moxfield.com/decks/abc", rows[0].url);
  // Unquoted, the comma really is a separator, so the name splits — and the
  // first non-link cell is what's left. Worth knowing rather than pretending.
  check("an unquoted comma splits, as CSV says it must",
    rows[1].commander === "Shorikai", rows[1].commander);
}

console.log("\nthe pricing sheet as it actually is");
{
  const rows = await parse(
    "Deck\tCommander\tPrice\tLink\n" +
    "Goblins\tKrenko, Mob Boss\t$412.55\thttps://moxfield.com/decks/abc\n" +
    "https://archidekt.com/decks/9\tMiirym, Sentinel Wyrm\t1,204.00"
  );
  check("the header row is skipped", rows.length === 2, String(rows.length));
  // The deck's nickname sits in the first text column. Taking the first cell
  // that isn't a link or a number imported five decks called "Goblins",
  // "Dragons" and "Superfriends" — the header row says which column is which,
  // so believe it.
  check("the header says which column the commander is in",
    rows[0].commander === "Krenko, Mob Boss", rows[0].commander);
  check("and a money column is never mistaken for a name",
    !rows.some((r) => /^[$\d]/.test(r.commander)), rows.map((r) => r.commander).join(" | "));
  // Column order is not assumed: the URL is whichever cell looks like one.
  check("the link is found wherever it sits",
    rows[1].url === "https://archidekt.com/decks/9", rows[1].url);
  check("and the name is found beside it",
    rows[1].commander === "Miirym, Sentinel Wyrm", rows[1].commander);
}

console.log("\nthe same sheet with its header row left behind");
{
  // Pasting a selection rather than the whole sheet loses the header. Nothing
  // structural says which of "Goblins" and "Krenko, Mob Boss" is the deck and
  // which is the commander — but the index knows one of them.
  const rows = await resolve(
    "Goblins\tKrenko, Mob Boss\t$412.55\thttps://moxfield.com/decks/abc\n" +
    "Dragons\tMiirym, Sentinel Wyrm\t$688.10\thttps://archidekt.com/decks/123"
  );
  check("the commander wins over the deck's nickname",
    rows[0].commander === "Krenko, Mob Boss", rows[0].commander);
  check("and brings its colours with it", rows[0].identity === "R", rows[0].identity);
  check("on every row", rows[1].commander === "Miirym, Sentinel Wyrm", rows[1].commander);
}

console.log("\ntwo nicknames, one deck");
{
  // "Dragons" and "Dragons again" look different to the parser and identical
  // once the index has spoken. The second must not be sent.
  const rows = await resolve(
    "Dragons\tMiirym, Sentinel Wyrm\thttps://archidekt.com/decks/123\n" +
    "Dragons again\tMiirym, Sentinel Wyrm\thttps://archidekt.com/decks/123"
  );
  check("the repeat is caught after resolution",
    rows[1].status === "duplicate", rows[1].status);
  check("and the first is still usable", rows[0].status === "ok", rows[0].status);
}

console.log("\nlines that need saying something about");
{
  const rows = await parse(
    "Krenko, Mob Boss\thttps://moxfield.com/decks/abc\n" +
    "\n" +
    "   \n" +
    "krenko, mob boss\thttps://moxfield.com/decks/zzz\n" +
    "Miirym, Sentinel Wyrm\twww.moxfield.com/decks/999\n" +
    "https://moxfield.com/decks/orphan"
  );
  check("blank lines are dropped", rows.length === 4, String(rows.length));
  check("a repeat is flagged, not silently doubled",
    rows[1].status === "duplicate", rows[1].status);
  check("a link missing its scheme is flagged",
    rows[2].status === "bad-url", rows[2].status);
  check("and is not read as a commander name",
    rows[2].commander === "Miirym, Sentinel Wyrm", rows[2].commander);
  check("a link with no name is flagged",
    rows[3].status === "no-commander", rows[3].status);
}

console.log("\na name with no link is still a deck");
{
  const rows = await parse("Atraxa, Grand Unifier");
  check("it parses", rows.length === 1, String(rows.length));
  check("as usable", rows[0].status === "ok", rows[0].status);
  check("with no url", rows[0].url === "", rows[0].url);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe preview");

const openImport = async () => {
  await page.evaluate(() => { recordsState = "idle"; showScreen("home"); });
  await page.click('[data-pick="stats"]');
  await page.waitForFunction(() => recordsState !== "loading" && recordsState !== "idle");
  await page.click('[data-records="import"]');
  await page.waitForSelector("#import-box");
};

const typeAndPreview = async (text) => {
  // Sheets pastes tabs; typing them would move focus, so set the value and
  // fire the same input event a paste fires.
  await page.evaluate((t) => {
    const box = document.querySelector("#import-box");
    box.value = t;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.waitForTimeout(80);
};

const preview = () => page.evaluate(() => ({
  rows: [...document.querySelectorAll(".import-row")].map((el) => ({
    name: el.querySelector(".import-name").textContent.trim(),
    note: el.querySelector(".field-note").textContent.trim(),
    flagged: el.classList.contains("is-flagged"),
    pips: el.querySelectorAll(".color-dot").length,
  })),
  summary: [...document.querySelectorAll("#import-preview > .field-note")]
    .map((e) => e.textContent.trim()).join(" "),
  button: document.querySelector('[data-import="go"]')?.textContent.trim() || null,
  disabled: document.querySelector('[data-import="go"]')?.disabled ?? null,
}));

await openImport();
{
  const p = await preview();
  check("an empty box says so", /Nothing pasted yet/i.test(p.summary), p.summary);
  check("and offers no import button", p.button === null, String(p.button));
}

await typeAndPreview(
  "krenko, mob boss\thttps://moxfield.com/decks/new\n" +
  "Miirym, Sentinel Wyrm\thttps://archidekt.com/decks/123\n" +
  "Sam's Homebrew\thttps://moxfield.com/decks/home\n" +
  "Miirym, Sentinel Wyrm\thttps://archidekt.com/decks/dupe"
);
{
  const p = await preview();
  check("every line gets a row", p.rows.length === 4, String(p.rows.length));
  // The snapshot's spelling wins, so a lowercase paste matches the deck the
  // account already has instead of creating a second Krenko.
  check("a lowercase paste is corrected to the real spelling",
    p.rows[0].name === "Krenko, Mob Boss", p.rows[0].name);
  check("and is recognised as one you already own",
    /already yours/i.test(p.rows[0].note), p.rows[0].note);
  check("its colours come from the index", p.rows[0].pips === 1, String(p.rows[0].pips));
  check("a new commander reads as new", /^new/i.test(p.rows[1].note), p.rows[1].note);
  check("with its colours resolved", p.rows[1].pips === 3, String(p.rows[1].pips));
  check("a name not in the index says so",
    /colours unknown/i.test(p.rows[2].note), p.rows[2].note);
  check("the repeat is flagged", p.rows[3].flagged === true);
  check("and says only the first is used",
    /more than once/i.test(p.rows[3].note), p.rows[3].note);
  check("the count says what will happen",
    /2 to add, 1 to update/.test(p.summary), p.summary);
  check("and names the one it doesn't know",
    /1 not in the commander list/.test(p.summary), p.summary);
  // Three, not four: the duplicate is not offered.
  check("the button counts only what it will send",
    /Import 3 decks/.test(p.button), p.button);
}

console.log("\nrunning it");
{
  const before = await fetch(`${BASE}/__decks`).then((r) => r.json());
  await page.click('[data-import="go"]');
  await page.waitForFunction(() => document.querySelector("#modal-backdrop").hidden === true,
    null, { timeout: 5000 });
  const after = await fetch(`${BASE}/__decks`).then((r) => r.json());
  const by = (n) => after.decks.find((d) => d.commander === n);

  check("the modal closes when it's done", true);
  check("two new decks arrived", after.decks.length === before.decks.length + 2,
    `${before.decks.length} → ${after.decks.length}`);
  check("the existing Krenko was updated, not duplicated",
    after.decks.filter((d) => /^krenko/i.test(d.commander)).length === 1,
    String(after.decks.filter((d) => /^krenko/i.test(d.commander)).length));
  check("with its new link", by("Krenko, Mob Boss")?.deck_url === "https://moxfield.com/decks/new",
    String(by("Krenko, Mob Boss")?.deck_url));
  // The bracket is the one thing the sheet doesn't know, and losing it on every
  // import would be a quiet way to wreck a year of records.
  check("and its bracket untouched", by("Krenko, Mob Boss")?.bracket === 4,
    String(by("Krenko, Mob Boss")?.bracket));
  check("the new commander landed with its colours",
    by("Miirym, Sentinel Wyrm")?.identity === "URG", String(by("Miirym, Sentinel Wyrm")?.identity));
  check("the unknown name landed too", !!by("Sam's Homebrew"));
  check("with no colours claimed for it", by("Sam's Homebrew")?.identity === "",
    String(by("Sam's Homebrew")?.identity));
  check("and the duplicate was sent once",
    after.decks.filter((d) => d.commander === "Miirym, Sentinel Wyrm").length === 1);
  check("the last link wins on the row that was sent",
    by("Miirym, Sentinel Wyrm")?.deck_url === "https://archidekt.com/decks/123",
    String(by("Miirym, Sentinel Wyrm")?.deck_url));
}

console.log("\na link the server would reject");
{
  // The preview flags it, and the importer drops the link rather than the
  // deck — a 400 from /api/decks would cost the whole row for a typo.
  await openImport();
  await typeAndPreview("Yuriko, the Tiger's Shadow\twww.moxfield.com/decks/777");
  const p = await preview();
  check("the row is flagged", p.rows[0].flagged === true);
  check("saying what's wrong with the link",
    /start with https/i.test(p.rows[0].note), p.rows[0].note);
  check("but it is still importable", /Import 1 deck\b/.test(p.button), p.button);

  await page.click('[data-import="go"]');
  await page.waitForFunction(() => document.querySelector("#modal-backdrop").hidden === true,
    null, { timeout: 5000 });
  const after = await fetch(`${BASE}/__decks`).then((r) => r.json());
  const row = after.decks.find((d) => d.commander === "Yuriko, the Tiger's Shadow");
  check("the deck is saved", !!row);
  check("without the broken link", !row?.deck_url, String(row?.deck_url));
  check("and its colours are right", row?.identity === "UB", String(row?.identity));
}

console.log("\nwhen a save fails");
{
  await openImport();
  await typeAndPreview(
    "Atraxa, Grand Unifier\thttps://moxfield.com/decks/a\n" +
    "Miirym, Sentinel Wyrm\thttps://moxfield.com/decks/b"
  );
  // Fail the second POST only. Partial success is the normal outcome of a
  // forty-row import over a flaky connection, and the report has to be true.
  await page.evaluate(() => {
    const real = window.fetch;
    let deckPosts = 0;
    window.fetch = (url, opts) => {
      if (String(url) === "/api/decks" && opts?.method === "POST") {
        deckPosts += 1;
        if (deckPosts === 2) return Promise.resolve(new Response(
          JSON.stringify({ ok: false, error: "Nope." }),
          { status: 500, headers: { "Content-Type": "application/json" } }));
      }
      return real(url, opts);
    };
  });
  await page.click('[data-import="go"]');
  await page.waitForFunction(() => {
    const e = document.querySelector("#import-error");
    return e && !e.hidden;
  }, null, { timeout: 5000 });
  const r = await page.evaluate(() => ({
    stayed: document.querySelector("#modal-backdrop").hidden === false,
    error: document.querySelector("#import-error").textContent.trim(),
    button: document.querySelector('[data-import="go"]').textContent.trim(),
    disabled: document.querySelector('[data-import="go"]').disabled,
  }));
  check("the modal stays open", r.stayed === true);
  check("and reports how many landed", /1 imported, 1 failed/.test(r.error), r.error);
  check("naming the one that didn't", /Miirym/.test(r.error), r.error);
  check("the button offers another go", /Try the rest again/i.test(r.button), r.button);
  check("and is clickable again", r.disabled === false);

  const after = await fetch(`${BASE}/__decks`).then((r) => r.json());
  check("the one that succeeded stayed saved",
    !!after.decks.find((d) => d.commander === "Atraxa, Grand Unifier"));
  await page.evaluate(() => { location.reload(); });
  await page.waitForFunction(() => typeof sessionState !== "undefined" && sessionState === "in");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe preview at phone width");
{
  await page.evaluate(() => loadCommanderIndex());
  await page.waitForFunction(() => commanderIndexState === "ready");
  await page.setViewportSize({ width: 360, height: 780 });
  await openImport();
  // Eight rows, long names, a flag and a duplicate: the list a real sheet
  // produces, not two tidy lines.
  await typeAndPreview(
    "Kotori, Pilot Prodigy\thttps://moxfield.com/decks/aaaaaaaaaaaaaaaaaaaa\n" +
    "Krenko, Mob Boss\thttps://moxfield.com/decks/b\n" +
    "Yuriko, the Tiger's Shadow\twww.moxfield.com/decks/c\n" +
    "Atraxa, Grand Unifier\thttps://moxfield.com/decks/d\n" +
    "Miirym, Sentinel Wyrm\thttps://moxfield.com/decks/e\n" +
    "Shorikai, Genesis Engine\thttps://moxfield.com/decks/f\n" +
    "Sam's Extremely Long Kitchen Table Pile of Cards\thttps://moxfield.com/decks/g\n" +
    "Krenko, Mob Boss\thttps://moxfield.com/decks/h"
  );
  const fit = await page.evaluate(() => {
    const card = document.querySelector("#modal-body");
    const rows = [...document.querySelectorAll(".import-row")];
    const go = document.querySelector('[data-import="go"]').getBoundingClientRect();
    return {
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      overflows: rows.some((r) => r.getBoundingClientRect().right
        > card.getBoundingClientRect().right + 1),
      heights: new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height))).size,
      buttonBottom: Math.round(go.bottom),
      viewport: window.innerHeight,
    };
  });
  check("nothing pushes the page sideways", fit.sideways === false);
  check("no row escapes the modal", fit.overflows === false);
  // A note that wraps makes one row taller than the rest, which reads as a
  // broken list long before anyone reads the words.
  check("every row is the same height", fit.heights === 1, String(fit.heights));
  // The list scrolls inside the modal, so this stays true at forty decks. Let
  // the preview grow instead and the only button on the screen ends up below
  // the fold.
  check("the import button is on screen without scrolling",
    fit.buttonBottom <= fit.viewport, `${fit.buttonBottom} vs ${fit.viewport}`);
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
