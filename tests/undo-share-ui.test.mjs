// Two things that need the table: putting back a life total someone else
// moved, and handing your decklist round.

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
await page.waitForFunction(() => recordsState === "ready");

// Shorikai is the deck with a saved link in the mock; Krenko has none.
const seat = (commander) => page.evaluate((commander) => {
  code = "K4TM"; selfId = "me"; muted = true;
  session = { ...session, mode: "remote", hostId: "me", activePlayerId: "me",
    turnOrder: ["me", "sam", "ali"], turnStartedAt: Date.now(), players: {
      me: { id: "me", displayName: "Jay", lifeTotal: 34, colorIdentity: ["W", "U"],
            commanderName: commander, poison: 0, commanderDamage: {}, commanderCasts: 0 },
      sam: { id: "sam", displayName: "Sam", lifeTotal: 28, colorIdentity: ["R"],
             commanderName: "Krenko, Mob Boss" },
      ali: { id: "ali", displayName: "Ali", lifeTotal: 12, colorIdentity: ["U", "B"],
             commanderName: "Yuriko, the Tiger's Shadow" } } };
  showScreen("game"); render();
}, commander);

const sent = [];
await page.exposeFunction("__record", (m) => sent.push(m));
await page.evaluate(() => {
  // Stand in for the socket: what matters here is what the client says, and
  // what it does with what the server says back.
  window.sendMessage = (m) => { window.__record(JSON.stringify(m)); return true; };
});

const chip = () => page.evaluate(() => {
  const el = document.querySelector("#undo-chip");
  return { hidden: el.hidden, text: document.querySelector("#undo-text").textContent,
           visible: el.offsetParent !== null };
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nsomeone takes three off you");
await seat("Shorikai, Genesis Engine");
{
  const before = await chip();
  check("no undo offered out of nowhere", before.hidden === true);
}
{
  await page.evaluate(() => handleMessage({
    type: "life_changed_by", eventId: "e1", byPlayerId: "sam", byName: "Sam", delta: -3 }));
  const r = await chip();
  check("the chip appears", r.hidden === false && r.visible === true, JSON.stringify(r));
  check("naming the amount and who", r.text === "−3 from Sam", JSON.stringify(r.text));
}
{
  // It overlays the panel rather than taking a row: the game screen has no
  // spare height, and this control lives for ten seconds.
  const r = await page.evaluate(() => {
    const el = document.querySelector("#undo-chip");
    const panel = document.querySelector(".self-panel");
    const before = panel.getBoundingClientRect().height;
    el.hidden = true;
    const without = panel.getBoundingClientRect().height;
    el.hidden = false;
    return { before, without, position: getComputedStyle(el).position };
  });
  check("and costs the layout nothing", r.before === r.without, `${r.before} vs ${r.without}`);
  check("because it's overlaid", r.position === "absolute", r.position);
}
{
  sent.length = 0;
  await page.click("#btn-undo-life");
  await page.waitForTimeout(80);
  check("tapping it asks the server to reverse", sent.length === 1, JSON.stringify(sent));
  check("by event id, carrying no life total of its own",
    sent[0] === JSON.stringify({ type: "undo_life", eventId: "e1" }), sent[0]);
  const r = await chip();
  // Gone on press, not on the echo: a button still sitting there after you
  // pressed it invites a second press.
  check("and the chip goes immediately", r.hidden === true);
}
{
  sent.length = 0;
  await page.evaluate(() => document.querySelector("#btn-undo-life").click());
  await page.waitForTimeout(80);
  check("pressing a spent chip sends nothing", sent.length === 0, JSON.stringify(sent));
}
{
  // Gaining life from an opponent's effect is just as undoable, and the sign
  // has to read correctly.
  await page.evaluate(() => handleMessage({
    type: "life_changed_by", eventId: "e2", byPlayerId: "ali", byName: "Ali", delta: 5 }));
  const r = await chip();
  check("a gain reads as a gain", r.text === "+5 from Ali", r.text);
}
{
  // Two changes in five seconds: one chip, the most recent. A queue of them
  // mid-combat is its own problem.
  await page.evaluate(() => handleMessage({
    type: "life_changed_by", eventId: "e3", byPlayerId: "sam", byName: "Sam", delta: -2 }));
  const r = await chip();
  check("a second change replaces the first", r.text === "−2 from Sam", r.text);
  sent.length = 0;
  await page.click("#btn-undo-life");
  await page.waitForTimeout(80);
  check("and it's the newer one that gets undone", /e3/.test(sent[0] || ""), sent[0]);
}
{
  const r = await page.evaluate(async () => {
    handleMessage({ type: "life_changed_by", eventId: "e4", byPlayerId: "sam", byName: "Sam", delta: -1 });
    const shownFor = UNDO_VISIBLE_MS;
    // Rather than waiting ten real seconds, fire what the timer would.
    clearUndo();
    return { shownFor, hidden: document.querySelector("#undo-chip").hidden };
  });
  check("it expires on its own", r.hidden === true);
  check("before the server's window closes", r.shownFor < 12000, String(r.shownFor));
}
{
  // The rest of the table sees the number move back, which is the whole reason
  // to broadcast it: a total that changes twice with no explanation is how
  // four people end up disagreeing about the board.
  const r = await page.evaluate(() => {
    handleMessage({ type: "life_changed_by", eventId: "e5", byPlayerId: "sam", byName: "Sam", delta: -3 });
    const before = !document.querySelector("#undo-chip").hidden;
    handleMessage({ type: "life_undone", playerId: "me", name: "Jay", delta: -3 });
    return { before, after: document.querySelector("#undo-chip").hidden };
  });
  check("an undo landing clears your own chip", r.before === true && r.after === true,
    JSON.stringify(r));
}
{
  const flashed = await page.evaluate(() => {
    const row = document.querySelector('.opponent-row[data-player-id="sam"]');
    handleMessage({ type: "life_undone", playerId: "sam", name: "Sam", delta: -3 });
    return row.className;
  });
  // flash() adds "glow" — the same class every other table event uses, so an
  // undo reads like anything else happening rather than a special case.
  check("and someone else's flashes their row", /\bglow\b/.test(flashed), flashed);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nhanding your decklist round");
{
  const r = await page.evaluate(() =>
    document.querySelectorAll("[data-share-deck]").length);
  check("the share button is offered for a deck that has a link", r === 1, String(r));
}
{
  // Krenko has no saved link in the mock. A button that always shows and
  // usually errors teaches people to ignore it.
  await seat("Krenko, Mob Boss");
  const r = await page.evaluate(() => document.querySelectorAll("[data-share-deck]").length);
  check("and hidden for one that doesn't", r === 0, String(r));
  await seat("Shorikai, Genesis Engine");
}
{
  await page.click("[data-share-deck]");
  await page.waitForTimeout(250);
  const r = await fetch(`${BASE}/__decks`).then((x) => x.json());
  check("sharing reaches the server", !!r.lastShare, JSON.stringify(r.lastShare));
  check("naming the table and the commander",
    r.lastShare?.code === "K4TM" && r.lastShare?.commander === "Shorikai, Genesis Engine",
    JSON.stringify(r.lastShare));
  // The whole point of the endpoint: the client asks, the server supplies the
  // link. A URL from a browser must never reach three other people's screens.
  check("and sending no URL of its own", !("url" in (r.lastShare || {})) && !("deckUrl" in (r.lastShare || {})),
    JSON.stringify(r.lastShare));
}
{
  const r = await page.evaluate(() => {
    handleMessage({ type: "deck_shared", byPlayerId: "sam", byName: "Sam",
      commander: "Krenko, Mob Boss", url: "https://moxfield.com/decks/abc123456789/very/long/path",
      at: Date.now() });
    openOracle("card");
    const link = document.querySelector(".deck-link");
    return { href: link?.getAttribute("href"), text: link?.textContent,
             rel: link?.getAttribute("rel"), target: link?.getAttribute("target"),
             note: document.querySelector(".oracle-entry .field-note")?.textContent.replace(/\s+/g, " ").trim() };
  });
  check("a shared link lands in the feed", /moxfield\.com/.test(r.href || ""), r.href);
  check("saying who shared it and what", /Sam shared a decklist/.test(r.note || "")
    && /Krenko/.test(r.note || ""), r.note);
  // The host leads, because that's what tells you whether to trust a link.
  check("the host is what you read first", /^moxfield\.com/.test(r.text || ""), r.text);
  check("a long path is shortened", (r.text || "").length < 45, `${r.text?.length}`);
  check("and it opens away from the game", r.target === "_blank", r.target);
  check("with no window handle back to us", /noopener/.test(r.rel || ""), r.rel);
}
{
  // Sharing is broadcast, so it marks the card button the same way a card does.
  const r = await page.evaluate(() => {
    closeModal();
    oracleUnread = { card: 0, rules: 0 };
    handleMessage({ type: "deck_shared", byPlayerId: "ali", byName: "Ali",
      commander: "Yuriko", url: "https://archidekt.com/decks/1", at: Date.now() });
    return { unread: { ...oracleUnread },
             glowing: document.querySelector("#btn-card-lookup").classList.contains("has-news") };
  });
  check("an unopened share marks the card button", r.unread.card === 1, JSON.stringify(r.unread));
  check("and makes it glow", r.glowing === true);
}
{
  // Muting a player is about not hearing them, and a shared link is a sound
  // as well as an entry.
  const r = await page.evaluate(() => {
    let chimes = 0;
    window.playOracleChime = () => { chimes += 1; };
    muted = false;
    mutedPlayers.add("ali");
    handleMessage({ type: "deck_shared", byPlayerId: "ali", byName: "Ali",
      commander: "Yuriko", url: "https://archidekt.com/decks/2", at: Date.now() });
    const mutedChimes = chimes;
    handleMessage({ type: "deck_shared", byPlayerId: "sam", byName: "Sam",
      commander: "Krenko", url: "https://archidekt.com/decks/3", at: Date.now() });
    mutedPlayers.delete("ali");
    muted = true;
    return { mutedChimes, after: chimes };
  });
  check("a muted player's share is silent", r.mutedChimes === 0, String(r.mutedChimes));
  check("but it still lands in the feed", true);
  check("and an unmuted one still chimes", r.after === 1, String(r.after));
}
{
  // A commander with no saved link, asked for anyway — the error has to say
  // what to do about it.
  await seat("Krenko, Mob Boss");
  const r = await page.evaluate(async () => {
    const res = await fetch("/api/decks/share", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "K4TM", commander: "Krenko, Mob Boss", playerId: "me" }),
    });
    return { status: res.status, body: await res.json() };
  });
  check("no saved link is a clear refusal", r.status === 404 && r.body.ok === false,
    JSON.stringify(r));
  check("that says where to add one", /My Commanders/.test(r.body.error || ""), r.body.error);
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
