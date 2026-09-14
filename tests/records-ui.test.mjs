// My Commanders: records, the guest case, and the unreachable case.

import pw from "playwright";
const { chromium } = pw;

const BASE = process.env.MTGE_TEST_BASE || "http://127.0.0.1:8232";
let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}
const SIGNED_IN = { mode: "in", state: { email: "jay@example.com", name: "Jay", all: false,
  identities: ["WUBG"], slotsTotal: 5, slotsUsed: 1, slotsLeft: 4 } };

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
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
