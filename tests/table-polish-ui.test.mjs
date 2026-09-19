// Three table-side fixes: life totals in a column, one player silenced, and a
// long Oracle answer that doesn't take the screen.

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

await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify({ mode: "in",
  state: { email: "j@e.com", name: "Jay", all: true, identities: [], slotsTotal: 5, slotsUsed: 0, slotsLeft: 5 } }) });

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(BASE);
await page.waitForFunction(() => sessionState === "in");

// 20 characters is the cap the name field and the server both enforce, so this
// is the worst case that can actually reach a table.
const LONG = "Maximilian Thornbur";
const SEATS = [
  { id: "a", displayName: "Jo", lifeTotal: 7, colorIdentity: ["R"],
    commanderName: "Krenko, Mob Boss" },
  { id: "b", displayName: "Bartholomew", lifeTotal: 28, colorIdentity: ["W", "U"],
    commanderName: "Shorikai, Genesis Engine" },
  { id: "c", displayName: LONG, lifeTotal: 140, colorIdentity: ["W", "U", "B", "G"],
    commanderName: "Atraxa, Grand Unifier" },
  { id: "d", displayName: "Ali", lifeTotal: 12, colorIdentity: ["U", "B"],
    commanderName: "Yuriko, the Tiger's Shadow", muted: true },
];
const seat = (n, view) => page.evaluate(({ s, view }) => {
  code = "K4TM"; selfId = "me"; oppView = view;
  const players = { me: { id: "me", displayName: "Jay", lifeTotal: 34, colorIdentity: ["R"],
    commanderName: "Krenko, Mob Boss", poison: 2, commanderDamage: {}, commanderCasts: 1 } };
  for (const x of s) players[x.id] = x;
  session = { ...session, mode: "remote", hostId: "me", activePlayerId: "me",
    turnOrder: ["me", ...s.map((x) => x.id)], turnStartedAt: Date.now(), players };
  showScreen("game"); render();
}, { s: SEATS.slice(0, n), view });

const columns = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll(".opponent-row")];
  const box = (r, sel) => r.querySelector(sel)?.getBoundingClientRect();
  const lefts = rows.map((r) => Math.round(box(r, ".opponent-life").left));
  const rights = rows.map((r) => Math.round(box(r, ".opponent-life").right));
  return {
    leftSpread: Math.max(...lefts) - Math.min(...lefts),
    rightSpread: Math.max(...rights) - Math.min(...rights),
    nameWidths: rows.map((r) => Math.round(box(r, ".opponent-name").width)),
    everyLifeVisible: rows.every((r) => box(r, ".opponent-life").width > 0),
    everyCommanderVisible: rows.every((r) => (box(r, ".opponent-commander")?.width || 0) > 30),
    sideways: document.documentElement.scrollWidth > window.innerWidth,
  };
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nlife totals line up, whatever people are called");
await seat(4, "rows");
{
  const r = await columns();
  // Before: a two-letter name and a nineteen-character one put their totals
  // 153px apart, so there was no column to read at all.
  check("every life total starts at the same x", r.leftSpread === 0, `spread ${r.leftSpread}`);
  check("and ends at the same x", r.rightSpread === 0, `spread ${r.rightSpread}`);
  check("all four are visible", r.everyLifeVisible === true);
  check("and so is every commander", r.everyCommanderVisible === true);
  check("nothing scrolls sideways", r.sideways === false);
}
{
  const widths = (await columns()).nameWidths;
  // One shared set of tracks, so the name column is one width for everyone.
  check("the name column is one width", new Set(widths).size === 1, JSON.stringify(widths));
}
{
  // The point of subgrid over a fixed width: with only short names at the
  // table, the name column shrinks and the commanders get the room back.
  const wide = (await columns()).nameWidths[0];
  await seat(2, "rows");
  const narrow = (await columns()).nameWidths[0];
  check("a table of short names uses a narrower name column", narrow < wide,
    `${narrow} vs ${wide}`);
  const r = await columns();
  check("and still lines up", r.leftSpread === 0, `spread ${r.leftSpread}`);
}
{
  // A long name must give up characters rather than push the number off-screen.
  await seat(4, "rows");
  const r = await page.evaluate((LONG) => {
    const row = [...document.querySelectorAll(".opponent-row")]
      .find((el) => el.textContent.includes("140"));
    const name = row.querySelector(".opponent-name span");
    const life = row.querySelector(".opponent-life").getBoundingClientRect();
    return { clipped: name.scrollWidth > name.clientWidth + 1,
             full: name.textContent === LONG,
             lifeInside: life.right <= row.getBoundingClientRect().right + 1 };
  }, LONG);
  check("a 19-character name is clipped, not dropped", r.clipped === true);
  check("the full name is still in the DOM for a screen reader", r.full === true);
  check("and the life total stays inside the row", r.lifeInside === true);
}
{
  // Five players on a 360px phone pushed the Send button 7px off the screen —
  // grid items default to min-width:auto, so "All players" refused to shrink.
  for (const [w, h] of [[360, 780], [375, 667], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      sendInside: document.querySelector(".send-btn").getBoundingClientRect().right
                  <= window.innerWidth + 1,
    }));
    check(`5 players at ${w}px: nothing sideways`, r.sideways === false);
    check(`5 players at ${w}px: Send is on screen`, r.sendInside === true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nmuting one player");
await seat(4, "rows");
const heard = () => page.evaluate(() => window.__heard || []);
await page.evaluate(() => {
  window.__heard = [];
  // Stand in for the audio layer: the question is which sounds get that far.
  for (const fn of ["playTaunt", "playBroadcast", "playDrawCard", "playPoke"]) {
    const name = fn;
    window[name] = () => window.__heard.push(name);
  }
  window.stopAmbient = () => window.__heard.push("stopAmbient");
});
const incoming = (from, soundId) => page.evaluate(({ from, soundId }) =>
  handleMessage({ type: "play_sound", soundId, fromPlayerId: from }), { from, soundId });
{
  await incoming("b", "taunt");
  check("an unmuted player is heard", (await heard()).includes("playTaunt"));
}
{
  const r = await page.evaluate(() => {
    openPlayerMenu("b");
    const label = [...document.querySelectorAll("[data-menu]")]
      .find((b) => b.dataset.menu === "mute").textContent.trim();
    return label;
  });
  check("their menu offers to mute them", /^Mute their sounds$/.test(r), r);
}
{
  await page.evaluate(() => { window.__heard = []; document.querySelector('[data-menu="mute"]').click(); });
  await page.waitForTimeout(100);
  const r = await page.evaluate(() => ({
    open: !document.querySelector("#modal-backdrop").hidden,
    label: document.querySelector('[data-menu="mute"]').textContent.trim(),
    muted: [...mutedPlayers],
  }));
  check("tapping it mutes them", r.muted.join() === "b", r.muted.join());
  check("the menu stays open", r.open === true);
  check("and the label flips", /^Unmute their sounds$/.test(r.label), r.label);
}
{
  await page.evaluate(() => { closeModal(); window.__heard = []; });
  await incoming("b", "taunt");
  await incoming("b", "broadcast");
  check("nothing they trigger is heard", (await heard()).length === 0,
    JSON.stringify(await heard()));
}
{
  await page.evaluate(() => { window.__heard = []; });
  await incoming("d", "taunt");
  await incoming("me", "draw_card");
  const h = await heard();
  // One player, not the table. Muting Bartholomew must not mute Ali.
  check("everyone else is still heard", h.includes("playTaunt") && h.includes("playDrawCard"),
    JSON.stringify(h));
}
{
  await page.evaluate(() => { window.__heard = []; });
  await incoming("b", "ambient_off");
  // Their music is already playing here. Blocking the stop would leave it
  // running with nothing left to end it.
  check("but a muted player can still stop their own ambient",
    (await heard()).includes("stopAmbient"), JSON.stringify(await heard()));
}
{
  const r = await page.evaluate(() => {
    render();
    const row = [...document.querySelectorAll(".opponent-row")]
      .find((el) => el.textContent.includes("Bartholomew"));
    const ali = [...document.querySelectorAll(".opponent-row")]
      .find((el) => el.textContent.includes("Ali"));
    return {
      mark: row.querySelectorAll(".muted-pip.muted-by-me").length,
      title: row.querySelector(".muted-pip.muted-by-me")?.getAttribute("title"),
      // Ali muted herself: a different fact, shown differently.
      theirs: ali.querySelectorAll(".muted-pip:not(.muted-by-me)").length,
      theirTitle: ali.querySelector(".muted-pip:not(.muted-by-me)")?.getAttribute("title"),
    };
  });
  check("their row is marked so you remember", r.mark === 1, String(r.mark));
  check("saying it was your doing", /You've muted/i.test(r.title || ""), r.title);
  check("and their own mute is still shown separately", r.theirs === 1, String(r.theirs));
  check("with its own meaning", /Their sounds are off/i.test(r.theirTitle || ""), r.theirTitle);
}
{
  const r = await page.evaluate(() => {
    openPlayerMenu("b");
    document.querySelector('[data-menu="mute"]').click();
    closeModal();
    return [...mutedPlayers];
  });
  check("and it can be undone", r.length === 0, JSON.stringify(r));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\na long Oracle answer");
{
  const short = "Yes — the trigger still resolves.";
  const long = ("The ability triggers on the sacrifice, and sacrificing the creature "
    + "in response does not counter it. ").repeat(6);
  const r = await page.evaluate(({ short, long }) => {
    muted = true;
    oracleFeed = [];
    receiveOracleEvent({ kind: "rules", askedBy: "Sam", question: "Short one?", answer: short });
    receiveOracleEvent({ kind: "rules", askedBy: "Ali", question: "Long one?", answer: long });
    openOracle("rules");
    const entries = [...document.querySelectorAll(".oracle-entry")];
    return {
      clipped: entries.filter((el) => el.querySelector(".oracle-a.is-clipped")).length,
      buttons: document.querySelectorAll("[data-expand]").length,
      // Clipped, never truncated: the whole answer is in the DOM.
      longestRendered: Math.max(...entries.map((el) => el.querySelector(".oracle-a").textContent.length)),
      longLength: long.length,
    };
  }, { short, long });
  check("a long answer is clipped", r.clipped === 1, String(r.clipped));
  check("a short one isn't", r.buttons === 1, String(r.buttons));
  check("and the full text is still there, not cut", r.longestRendered >= r.longLength - 2,
    `${r.longestRendered} vs ${r.longLength}`);
}
{
  const r = await page.evaluate(() => {
    document.querySelector("[data-expand]").click();
    return {
      clipped: document.querySelectorAll(".oracle-a.is-clipped").length,
      buttons: document.querySelectorAll("[data-expand]").length,
    };
  });
  check("tapping 'show the rest' unclips it", r.clipped === 0, String(r.clipped));
  check("and the button goes away", r.buttons === 0, String(r.buttons));
}
{
  // A new answer re-renders the feed. It must not re-collapse the one being read.
  const r = await page.evaluate(() => {
    receiveOracleEvent({ kind: "rules", askedBy: "Ros", question: "Another?", answer: "Short." });
    return document.querySelectorAll(".oracle-a.is-clipped").length;
  });
  check("and a new answer arriving doesn't re-collapse it", r === 0, String(r));
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
