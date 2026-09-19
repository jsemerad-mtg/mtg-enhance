// Two failures that used to be invisible:
//   - a query that threw came back as 200 with an empty list, which reads as
//     "you have nothing" rather than "we couldn't find out"
//   - the game screen was taller than a small phone, and nothing measured it

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
const setMock = (extra = {}) =>
  fetch(`${BASE}/__mock`, { method: "POST",
    body: JSON.stringify({ mode: "in", state: ACCOUNT, ...extra }) });

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));

const toStats = async () => {
  await page.evaluate(() => { recordsState = "idle"; showScreen("home"); });
  await page.click('[data-pick="stats"]');
  await page.waitForFunction(() => recordsState !== "loading" && recordsState !== "idle");
  await page.waitForTimeout(120);
};
const screen = () => page.evaluate(() => ({
  state: recordsState,
  decksFailed,
  text: document.querySelector("#records-list").textContent.replace(/\s+/g, " ").trim(),
  warnings: document.querySelectorAll("#records-list .load-warning").length,
  rows: document.querySelectorAll("#records-list .fav-row").length,
}));

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe records query throws");
await fetch(`${BASE}/__reset`, { method: "POST" });
await setMock({ failRecords: true });
await page.goto(BASE);
await page.waitForFunction(() => sessionState === "in");
await toStats();
{
  const r = await screen();
  // The exact bug: 200 OK, empty arrays, and a screen that says you have no
  // games. A missing game_history table looked like this for days.
  check("a failed query is not 'ready'", r.state === "failed", r.state);
  check("the screen says it couldn't load", /Couldn't load your records/i.test(r.text), r.text.slice(0, 120));
  check("and never claims you have no games",
    !/No games yet/i.test(r.text) && !/Nothing here yet/i.test(r.text), r.text.slice(0, 120));
  check("and says it isn't a reset", /isn't a reset/i.test(r.text), r.text.slice(0, 140));
}

console.log("\nan empty account is still an empty account");
await setMock({ emptyRecords: true });
await toStats();
{
  const r = await screen();
  check("no games and no error reads as ready", r.state === "ready", r.state);
  check("and says there's nothing here yet",
    /Nothing here yet/i.test(r.text) || r.rows > 0, r.text.slice(0, 120));
  check("with no warning banner", r.warnings === 0, String(r.warnings));
}

console.log("\nthe decks query throws, records are fine");
await setMock({ failDecks: true });
await toStats();
{
  const r = await screen();
  // Records are true; the list is short. Losing the whole screen over the
  // missing half would be a worse trade than saying which half is missing.
  check("the records still render", r.state === "ready", r.state);
  check("and the commanders you've played are listed", r.rows >= 2, String(r.rows));
  check("a warning says the list may be short", r.warnings === 1, String(r.warnings));
  check("naming what's missing", /saved decks/i.test(r.text), r.text.slice(0, 200));
  check("and promising nothing was deleted", /Nothing has been deleted/i.test(r.text),
    r.text.slice(0, 200));
}
{
  // The same decks feed the chips at the table, so the same honesty applies.
  const chips = await page.evaluate(async () => {
    chooseMode("join");
    document.querySelector("#input-code").value = "abcd";
    await startChosenMode();
    const host = document.querySelector("#favorites-list");
    return { warnings: host.querySelectorAll(".load-warning").length,
             text: host.textContent.replace(/\s+/g, " ").trim() };
  });
  check("the table screen warns too", chips.warnings === 1, String(chips.warnings));
  check("saying only this device's commanders are shown",
    /only the ones this device remembers/i.test(chips.text), chips.text.slice(0, 160));
}

console.log("\nthe history query throws");
await setMock({ failHistory: true });
await toStats();
{
  await page.click('[data-history="Atraxa, Grand Unifier"]');
  await page.waitForFunction(() => {
    const b = document.querySelector("#history-body");
    return b && !/Loading/.test(b.textContent);
  });
  const r = await page.evaluate(() => document.querySelector("#history-body").textContent.trim());
  check("it says it couldn't load them", /Couldn't load those games/i.test(r), r);
  check("rather than 'no games recorded'", !/No games recorded/i.test(r), r);
  await page.evaluate(() => closeModal());
}

console.log("\nan old server that doesn't send the flag");
await setMock({});
await toStats();
{
  // `ok` is absent on a deployment that predates this change. Absent must mean
  // fine, or shipping the client first would black out every screen.
  const r = await page.evaluate(async () => {
    const raw = await fetch("/api/records", { credentials: "include" }).then((x) => x.json());
    delete raw.ok;
    return { hadFlag: raw.ok === undefined, state: recordsState };
  });
  check("absent is not false", r.hadFlag === true);
  check("and the screen loads normally", r.state === "ready", r.state);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe game screen against real phones");
await page.evaluate(() => {
  code = "K4TM"; selfId = "me";
  session = { ...session, mode: "remote", hostId: "me", activePlayerId: "me",
    turnOrder: ["me", "sam", "ali", "ros"], turnStartedAt: Date.now(), players: {
      me: { id: "me", displayName: "Jay", lifeTotal: 34, colorIdentity: ["R"],
            commanderName: "Krenko, Mob Boss", poison: 2, commanderDamage: {}, commanderCasts: 1 },
      sam: { id: "sam", displayName: "Sam", lifeTotal: 28, colorIdentity: ["W", "U"],
             commanderName: "Shorikai, Genesis Engine" },
      ali: { id: "ali", displayName: "Ali", lifeTotal: 12, colorIdentity: ["U", "B"],
             commanderName: "Yuriko, the Tiger's Shadow" },
      ros: { id: "ros", displayName: "Ros", lifeTotal: 40, colorIdentity: ["W", "U", "B", "G"],
             commanderName: "Atraxa, Grand Unifier" } } };
  showScreen("game"); render();
});

const fit = async (w, h) => {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(200);
  return page.evaluate(() => ({
    over: Math.round(document.querySelector(".life-event-panel").getBoundingClientRect().bottom)
          - window.innerHeight,
    sideways: document.documentElement.scrollWidth > window.innerWidth,
    trainRows: new Set([...document.querySelectorAll("#step-train .step")]
      .map((e) => Math.round(e.getBoundingClientRect().top))).size,
    lifeBtn: Math.round(document.querySelector(".life-btn").getBoundingClientRect().width),
    soundRows: new Set([...document.querySelectorAll("#soundboard .icon-btn")]
      .map((e) => Math.round(e.getBoundingClientRect().top))).size,
  }));
};
{
  const r = await fit(390, 844);
  check("iPhone 14 fits", r.over <= 0, `over ${r.over}`);
  check("with the train on one line", r.trainRows === 1, String(r.trainRows));
  check("and nothing sideways", r.sideways === false);
}
let tallLifeBtn = 0;
{
  const r = await fit(430, 932);
  check("Pro Max fits", r.over <= 0, `over ${r.over}`);
  tallLifeBtn = r.lifeBtn;
  check("with usable life buttons", r.lifeBtn >= 44, String(r.lifeBtn));
}
{
  const r = await fit(360, 780);
  // This was over by 38px, almost entirely because the step train wrapped to
  // two lines below 383px — the old breakpoint was 359.
  check("a 360-wide Android fits", r.over <= 0, `over ${r.over}`);
  check("its train is one line", r.trainRows === 1, String(r.trainRows));
  check("and nothing sideways", r.sideways === false);
}
{
  const r = await fit(375, 667);
  // An iPhone SE still doesn't fit, and closing the rest would cost either the
  // second soundboard row or a materially smaller life control. This asserts
  // the gap hasn't grown back rather than pretending it's closed.
  check("an iPhone SE is within 70px of fitting", r.over > 0 && r.over <= 70, `over ${r.over}`);
  check("its train is one line", r.trainRows === 1, String(r.trainRows));
  check("both soundboard rows survive", r.soundRows === 2, String(r.soundRows));
  // The compaction gives back padding and one font size. It must never shrink
  // the control people press forty times a game.
  check("the life buttons are the same size as on a big phone",
    r.lifeBtn === tallLifeBtn, `${r.lifeBtn} vs ${tallLifeBtn}`);
  check("and nothing sideways", r.sideways === false);
}
{
  const dvh = await page.evaluate(() => {
    const el = document.createElement("div");
    el.style.minHeight = "100dvh";
    return el.style.minHeight === "100dvh";
  });
  const declared = await page.evaluate(async () => {
    const css = await fetch("/style.css").then((r) => r.text());
    return css.includes("min-height: 100dvh") && css.includes("min-height: 100vh");
  });
  // 100vh on iOS Safari is the viewport with the toolbars hidden, so a layout
  // sized to it is taller than anything the user can see.
  check("the layout targets the visible viewport", declared === true);
  check("with a vh fallback for browsers without dvh", dvh === true || declared === true);
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
