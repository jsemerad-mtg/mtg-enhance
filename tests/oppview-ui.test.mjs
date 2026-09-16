// How opponents are drawn: two layouts, the player's choice, and the ordering
// inside a card — name and life together, commander and colours together.

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

await fetch(`${BASE}/__reset`, { method: "POST" });
await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify({ mode: "in",
  state: { email: "j@e.com", name: "Jay", all: true, identities: [], slotsTotal: 5, slotsUsed: 0, slotsLeft: 5 } }) });

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(BASE);
await page.waitForFunction(() => sessionState === "in");

const SEATS = [
  { id: "sam", displayName: "Sam", lifeTotal: 28, colorIdentity: ["W", "U"],
    commanderName: "Shorikai, Genesis Engine" },
  { id: "ali", displayName: "Ali", lifeTotal: 12, colorIdentity: ["U", "B"],
    commanderName: "Yuriko, the Tiger's Shadow", muted: true },
  { id: "ros", displayName: "Ros", lifeTotal: 40, colorIdentity: ["W", "U", "B", "G"],
    commanderName: "Atraxa, Grand Unifier" },
  { id: "kim", displayName: "Kim", lifeTotal: 7, colorIdentity: ["R", "G"],
    commanderName: "Omnath, Locus of Rage" },
];

const seat = async (n, patch = {}) => {
  await page.evaluate(({ s, patch }) => {
    code = "K4TM"; selfId = "me";
    const players = { me: { id: "me", displayName: "Jay", lifeTotal: 34, colorIdentity: ["R"],
      commanderName: "Krenko, Mob Boss", poison: 2, commanderDamage: {}, commanderCasts: 1 } };
    for (const x of s) players[x.id] = { ...x, ...(patch[x.id] || {}) };
    session = { ...session, mode: "remote", hostId: "me", activePlayerId: "me",
      turnOrder: ["me", ...s.map((x) => x.id)], turnStartedAt: Date.now(), players };
    showScreen("game");
    render();
  }, { s: SEATS.slice(0, n), patch });
  await page.waitForTimeout(120);
};

const state = () => page.evaluate(() => ({
  view: document.querySelector("#opponents").dataset.view,
  toggleShown: !document.querySelector("#opponents-head").hidden,
  toggleVisible: document.querySelector("#opponents-head").offsetParent !== null,
  label: document.querySelector("#btn-opp-view").getAttribute("aria-label"),
  rows: document.querySelectorAll(".opponent-row").length,
  sideways: document.documentElement.scrollWidth > window.innerWidth,
}));

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nwhat a card says, and in what order");
await page.evaluate(() => { localStorage.removeItem("mtge:oppview"); oppView = null; });
await seat(3);
{
  const r = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".opponent-row")]
      .find((el) => el.textContent.includes("Ros"));
    const top = row.querySelector(".opponent-top");
    const deck = row.querySelector(".opponent-deck");
    return {
      topText: top.textContent.replace(/\s+/g, " ").trim(),
      deckText: deck.textContent.replace(/\s+/g, " ").trim(),
      pipsInName: top.querySelectorAll(".color-dot").length,
      pipsInDeck: deck.querySelectorAll(".color-dot").length,
      // Life must follow the name, not sit across the card from it.
      lifeLeft: Math.round(row.querySelector(".opponent-life").getBoundingClientRect().left),
      nameRight: Math.round(row.querySelector(".opponent-name").getBoundingClientRect().right),
      rowRight: Math.round(row.getBoundingClientRect().right),
      // And the pips follow the commander they describe.
      pipsLeft: Math.round(deck.querySelector(".opponent-pips").getBoundingClientRect().left),
      cmdRight: Math.round(deck.querySelector(".opponent-commander").getBoundingClientRect().right),
    };
  });
  check("the top line is the player and their life", r.topText === "Ros 40", r.topText);
  check("the second line is the deck and its colours", /^Atraxa, Grand Unifier/.test(r.deckText), r.deckText);
  check("no pips beside the name any more", r.pipsInName === 0, String(r.pipsInName));
  check("four pips beside the commander", r.pipsInDeck === 4, String(r.pipsInDeck));
  check("life sits next to the name, not at the far edge",
    r.lifeLeft - r.nameRight < 20 && r.rowRight - r.lifeLeft > 100,
    JSON.stringify({ gap: r.lifeLeft - r.nameRight, toEdge: r.rowRight - r.lifeLeft }));
  check("pips come after the commander name", r.pipsLeft >= r.cmdRight - 1,
    JSON.stringify({ pipsLeft: r.pipsLeft, cmdRight: r.cmdRight }));
}
{
  // A player with no commander set yet must not render an empty second line.
  await seat(2, { sam: { commanderName: "", colorIdentity: [] } });
  const r = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".opponent-row")].find((el) => el.textContent.includes("Sam"));
    return { decks: row.querySelectorAll(".opponent-deck").length,
             text: row.textContent.replace(/\s+/g, " ").trim() };
  });
  check("no commander and no colours means no second line", r.decks === 0, r.text);
  check("the name and life still show", r.text === "Sam 28", r.text);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nuntouched, the count picks the view");
{
  await page.evaluate(() => { localStorage.removeItem("mtge:oppview"); oppView = null; });
  await seat(1);
  const r = await state();
  check("one opponent is a full-width row", r.view === "rows", r.view);
  // Rows and boxes draw one opponent identically, so there is nothing to pick.
  check("and the toggle stays out of the way", r.toggleShown === false);
  check("really hidden, not just marked hidden", r.toggleVisible === false);
}
{
  await seat(2); const r = await state();
  check("two opponents pair up", r.view === "boxes", r.view);
  check("and the toggle appears", r.toggleShown === true);
  check("offering the other view", /rows/i.test(r.label || ""), r.label);
}
{
  await seat(3); const r = await state();
  // The whole point: three in a two-column grid leaves a visible hole.
  check("three opponents stack instead of leaving a hole", r.view === "rows", r.view);
  check("and the toggle offers boxes", /boxes/i.test(r.label || ""), r.label);
}
{
  await seat(4); const r = await state();
  check("four opponents pair up again", r.view === "boxes", r.view);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nonce chosen, the choice rules");
{
  await seat(3);
  await page.click("#btn-opp-view");
  await page.waitForTimeout(120);
  const r = await state();
  check("tapping switches the view", r.view === "boxes", r.view);
  check("and the button now offers the way back", /rows/i.test(r.label || ""), r.label);
  const stored = await page.evaluate(() => localStorage.getItem("mtge:oppview"));
  check("the choice is written down", stored === '"boxes"', String(stored));
}
{
  // Parity would have said rows here; the stored choice must win.
  await seat(3);
  const r = await state();
  check("a re-render keeps it", r.view === "boxes", r.view);
}
{
  await seat(4);
  const r = await state();
  check("and so does a different player count", r.view === "boxes", r.view);
}
{
  await page.reload();
  await page.waitForFunction(() => sessionState === "in");
  await seat(3);
  const r = await state();
  check("and it survives a reload", r.view === "boxes", r.view);
}
{
  await page.click("#btn-opp-view");
  await page.waitForTimeout(120);
  const r = await state();
  check("switching back works too", r.view === "rows", r.view);
  const stored = await page.evaluate(() => localStorage.getItem("mtge:oppview"));
  check("and is written down", stored === '"rows"', String(stored));
}
{
  // Storage can be unavailable — private windows, blocked site data. The view
  // should still render, just without remembering.
  const r = await page.evaluate(() => {
    localStorage.setItem("mtge:oppview", "{not json");
    oppView = readJson("mtge:oppview", null);
    render();
    return { view: document.querySelector("#opponents").dataset.view, opp: oppView };
  });
  check("junk in storage falls back to the count", r.view === "rows" && r.opp === null,
    JSON.stringify(r));
  await page.evaluate(() => { localStorage.removeItem("mtge:oppview"); oppView = null; });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nboth views hold up");
{
  await page.evaluate(() => { oppView = "boxes"; render(); });
  await seat(4);
  const r = await page.evaluate(() => ({
    cols: new Set([...document.querySelectorAll(".opponent-row")]
      .map((el) => Math.round(el.getBoundingClientRect().left))).size,
    rows: new Set([...document.querySelectorAll(".opponent-row")]
      .map((el) => Math.round(el.getBoundingClientRect().top))).size,
    namesCut: [...document.querySelectorAll(".opponent-name span:first-child")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1).length,
    pips: document.querySelectorAll(".opponent-pips .color-dot").length,
    sideways: document.documentElement.scrollWidth > window.innerWidth,
  }));
  check("boxes is a 2x2 grid", r.cols === 2 && r.rows === 2, JSON.stringify(r));
  // Commander names give up characters in this view; names and pips must not.
  check("no player name is cut off", r.namesCut === 0, String(r.namesCut));
  check("every colour pip still shows", r.pips === 10, String(r.pips));
  check("and nothing scrolls sideways", r.sideways === false);
}
{
  await page.evaluate(() => { oppView = "rows"; render(); });
  const r = await page.evaluate(() => ({
    cols: new Set([...document.querySelectorAll(".opponent-row")]
      .map((el) => Math.round(el.getBoundingClientRect().left))).size,
    rows: new Set([...document.querySelectorAll(".opponent-row")]
      .map((el) => Math.round(el.getBoundingClientRect().top))).size,
    cut: [...document.querySelectorAll(".opponent-commander")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1).length,
    sideways: document.documentElement.scrollWidth > window.innerWidth,
  }));
  check("rows is one per line", r.cols === 1 && r.rows === 4, JSON.stringify(r));
  // This is what the view buys, and why it's worth the height.
  check("and no commander name is cut off", r.cut === 0, String(r.cut));
  check("still nothing sideways", r.sideways === false);
}
{
  // A long display name must not push the life total out of the card.
  await page.evaluate(() => { oppView = "boxes"; });
  await seat(4, { sam: { displayName: "Bartholomew Winterbottom III" } });
  const r = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".opponent-row")].find((el) => el.textContent.includes("28"));
    const life = row.querySelector(".opponent-life").getBoundingClientRect();
    return { inside: life.right <= row.getBoundingClientRect().right + 1,
             lifeVisible: life.width > 0,
             sideways: document.documentElement.scrollWidth > window.innerWidth };
  });
  check("a very long name keeps the life total inside the card", r.inside === true);
  check("and visible", r.lifeVisible === true);
  check("without pushing the page sideways", r.sideways === false);
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
