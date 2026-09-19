// Two commanders: in the lobby, at the table, in the records, and through the
// importer. The riskiest part is that client.js keeps its OWN copy of the deck
// key — it is a classic script and cannot import — so the first section runs
// the same cases through both copies and fails if they ever drift.

import pw from "playwright";
const { chromium } = pw;
// The actual modules the Worker and the Durable Object use. Imported so the
// browser's copy of the same logic can be diffed against them rather than
// against a second transcription of the rules.
import { deckKey as serverKey, parseDeckKey as serverParse } from "../src/deck-key.js";
import { damageKey as serverDamageKey } from "../src/commander-damage.js";

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
await page.evaluate(() => loadCommanderIndex());
await page.waitForFunction(() => commanderIndexState === "ready");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe browser's copy of the deck key matches the server's");
{
  const CASES = [
    ["Krenko, Mob Boss", "", ""],
    ["Tymna the Weaver", "Thrasios, Triton Hero", ""],
    ["Thrasios, Triton Hero", "Tymna the Weaver", ""],
    ["Ezuri, Claw of Progress", "", "Snakes"],
    ["Nicol Bolas, the Ravager // Nicol Bolas, the Arisen", "", ""],
    ["Nicol Bolas, the Ravager // Nicol Bolas, the Arisen", "Tymna the Weaver", "cEDH"],
    ["  spaced   out  ", "", "  a  label "],
    ["", "", ""],
    ["", "Tymna the Weaver", ""],
  ];
  const mine = await page.evaluate((cases) =>
    cases.map(([a, b, l]) => [deckKey(a, b, l), JSON.stringify(parseDeckKey(deckKey(a, b, l)))]), CASES);
  const theirs = CASES.map(([a, b, l]) =>
    [serverKey(a, b, l), JSON.stringify(serverParse(serverKey(a, b, l)))]);

  const same = JSON.stringify(mine) === JSON.stringify(theirs);
  check("every case produces the same key and splits the same way", same,
    same ? "" : CASES.map((c, i) => mine[i][0] === theirs[i][0] ? "" : `${c[0]}: ${mine[i][0]} vs ${theirs[i][0]}`)
      .filter(Boolean).join(" | "));

  const dmg = await page.evaluate(() => [damageKey("sam", 0), damageKey("sam", 1), damageKey("sam")]);
  check("and so does the damage bucket key",
    dmg[0] === serverDamageKey("sam", 0) && dmg[1] === serverDamageKey("sam", 1)
      && dmg[2] === serverDamageKey("sam"), dmg.join(","));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe lobby");
const toLobby = async () => {
  await page.evaluate(async () => {
    showScreen("home");
    chooseMode("join");
    document.querySelector("#input-code").value = "abcd";
    await startChosenMode();
  });
  await page.waitForFunction(() => currentScreen === "lobby");
};
await toLobby();
{
  const r = await page.evaluate(() => ({
    wrapHidden: document.querySelector("#partner-wrap").hidden,
    buttonShown: !document.querySelector("#btn-add-partner").hidden,
  }));
  // Most decks have one commander. A second empty box on every one of them
  // makes an ordinary deck look half-filled in.
  check("no partner field until it's asked for", r.wrapHidden === true);
  check("just a button offering one", r.buttonShown === true);
}
{
  const r = await page.evaluate(() => {
    applyCommander("Tymna the Weaver", "WB");
    return { ci: currentIdentity(), key: deckKey(expectedCommanderName, partnerCommanderName || "", "") };
  });
  check("one commander sets its own colours", r.ci === "WB", r.ci);
  check("and the deck is just that commander", r.key === "Tymna the Weaver", r.key);
}
{
  const r = await page.evaluate(() => {
    document.querySelector("#btn-add-partner").click();
    applyPartner("Thrasios, Triton Hero", "UG");
    return {
      wrapHidden: document.querySelector("#partner-wrap").hidden,
      buttonShown: !document.querySelector("#btn-add-partner").hidden,
      ci: currentIdentity(),
      note: document.querySelector("#partner-note").textContent,
      key: deckKey(expectedCommanderName, partnerCommanderName, ""),
    };
  });
  check("the field opens", r.wrapHidden === false);
  check("and the offer to add one goes away", r.buttonShown === false);
  // A deck's colour identity is the union of its commanders'. Replacing rather
  // than unioning would have dropped Tymna's white and black.
  check("colours are the union of both", r.ci === "WUBG", r.ci);
  check("the note says they were added", /added to your colors/i.test(r.note), r.note);
  check("and the deck is now the pair",
    r.key === "Thrasios, Triton Hero + Tymna the Weaver", r.key);
}
{
  const r = await page.evaluate(() => {
    document.querySelector("#btn-remove-partner").click();
    return { ci: currentIdentity(), value: document.querySelector("#input-commander-2").value,
             hidden: document.querySelector("#partner-wrap").hidden };
  });
  check("removing the partner puts it away", r.hidden === true && r.value === "");
  // Otherwise the deck keeps pips for a card that is no longer in it.
  check("and takes its colours with it", r.ci === "WB", r.ci);
}

console.log("\nsitting down with two");
{
  const sent = await page.evaluate(async () => {
    const out = [];
    // A fake socket that opens at once. The mock server speaks no websocket,
    // so the real one never reaches "open" and never sends the join — and the
    // join payload is exactly what this is checking.
    const RealWS = window.WebSocket;
    window.WebSocket = class {
      constructor() {
        this.readyState = 1;
        this._on = {};
        setTimeout(() => (this._on.open || []).forEach((fn) => fn()), 0);
      }
      addEventListener(type, fn) { (this._on[type] ||= []).push(fn); }
      send(data) { out.push(data); }
      close() {}
    };
    window.WebSocket.OPEN = 1;
    document.querySelector("#input-name").value = "Jay";
    setBracket("3");
    applyCommander("Tymna the Weaver", "WB");
    document.querySelector("#btn-add-partner").click();
    applyPartner("Thrasios, Triton Hero", "UG");
    document.querySelector("#form-lobby").dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 600));
    window.WebSocket = RealWS;
    const join = out.map((d) => JSON.parse(d)).find((m) => m.type === "join");
    const post = await fetch("/__decks").then((r) => r.json());
    return { join, post: post.lastDeckPost };
  });
  check("the join carries both commanders",
    sent.join?.commanderName && sent.join?.commanderName2, JSON.stringify(sent.join));
  // Ordered on the way out, so the same pair typed either way round is one
  // deck rather than two.
  check("in canonical order",
    sent.join.commanderName === "Thrasios, Triton Hero"
      && sent.join.commanderName2 === "Tymna the Weaver", JSON.stringify(sent.join));
  check("with the union of their colours",
    (sent.join.colorIdentity || []).join("") === "WUBG", String(sent.join.colorIdentity));
  check("and the deck row saves both",
    sent.post?.commander === "Thrasios, Triton Hero" && sent.post?.commander2 === "Tymna the Weaver",
    JSON.stringify(sent.post));
  check("as one row, not two", sent.post?.identity === "WUBG", String(sent.post?.identity));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nat the table");
const seatTable = async (partners) => page.evaluate((partners) => {
  code = "K4TM"; selfId = "me"; muted = true;
  session = { ...session, mode: "remote", hostId: "me", activePlayerId: "me",
    turnOrder: ["me", "sam", "ali"], turnStartedAt: Date.now(), players: {
      me: { id: "me", displayName: "Jay", lifeTotal: 40, colorIdentity: ["W", "U", "B", "G"],
            commanderName: "Thrasios, Triton Hero", commanderName2: "Tymna the Weaver",
            poison: 0, commanderDamage: {}, commanderCasts: { 0: 0, 1: 0 } },
      sam: { id: "sam", displayName: "Sam", lifeTotal: 30, colorIdentity: ["W", "U"],
             commanderName: partners ? "Pir, Imaginative Rascal" : "Shorikai, Genesis Engine",
             commanderName2: partners ? "Toothy, Imaginary Friend" : "" },
      ali: { id: "ali", displayName: "Ali", lifeTotal: 25, colorIdentity: ["U", "B"],
             commanderName: "Yuriko, the Tiger's Shadow", commanderName2: "" } } };
  showScreen("game"); render();
  return {
    self: document.querySelector("#self-commander").textContent,
    opponents: [...document.querySelectorAll(".opponent-commander")].map((e) => e.textContent),
  };
}, partners);
{
  const r = await seatTable(true);
  check("your own seat shows both commanders",
    r.self === "Thrasios, Triton Hero + Tymna the Weaver", r.self);
  check("and so does an opponent's",
    r.opponents.some((t) => /Pir, Imaginative Rascal \+ Toothy, Imaginary Friend/.test(t)),
    r.opponents.join(" | "));
  check("while a single-commander seat is unchanged",
    r.opponents.some((t) => t === "Yuriko, the Tiger's Shadow"), r.opponents.join(" | "));
}

console.log("\ncommander damage, which is the point of all this");
const counters = () => page.evaluate(() => {
  openModal("Counters", countersHtml());
  return {
    rows: [...document.querySelectorAll('[data-step="cmdr"]')]
      .map((b) => b.dataset.id).filter((v, i, a) => a.indexOf(v) === i),
    labels: [...document.querySelectorAll(".stepper-label")]
      .map((e) => e.firstChild?.textContent.trim() || ""),
    subs: [...document.querySelectorAll(".stepper-sub")].map((e) => e.textContent.trim()),
    banner: document.querySelector(".lethal-banner")?.textContent.trim() || null,
  };
});
{
  const r = await counters();
  // Two rows for the pair, one each for the others: four clocks, not three.
  check("an opponent with partners gets a row each",
    r.rows.filter((id) => id.startsWith("sam:")).length === 2, JSON.stringify(r.rows));
  check("labelled by commander, not by player",
    r.labels.includes("Pir, Imaginative Rascal") && r.labels.includes("Toothy, Imaginary Friend"),
    r.labels.join(" | "));
  // The player's name moves to the sub line: "Sam: Pir, Imaginative Rascal"
  // wrapped at 390px and made the partnered rows taller than the rest.
  check("with whose they are underneath",
    r.subs.filter((t) => /^Sam — /.test(t)).length === 2, r.subs.join(" | "));
  check("a single-commander opponent still gets exactly one",
    r.rows.filter((id) => id.startsWith("ali:")).length === 1, JSON.stringify(r.rows));
  check("and reads the way it always did",
    r.labels.some((l) => /Ali's commander/.test(l)), r.labels.join(" | "));
}
{
  // The bug this whole change exists to prevent.
  const r = await page.evaluate(() => {
    const me = session.players.me;
    me.commanderDamage = { [damageKey("sam", 0)]: 11, [damageKey("sam", 1)]: 11 };
    openModal("Counters", countersHtml());
    return { banner: document.querySelector(".lethal-banner")?.textContent.trim() || null,
             worst: worstCommanderDamage(me), lethal: isLethal(me),
             fromSam: damageFrom(me, "sam") };
  });
  check("eleven from each partner is twenty-two dealt", r.fromSam === 22, String(r.fromSam));
  check("but the worst single clock is eleven", r.worst === 11, String(r.worst));
  check("so it is not lethal", r.lethal === false, String(r.lethal));
  check("and nothing announces that it is", r.banner === null, String(r.banner));
}
{
  const r = await page.evaluate(() => {
    const me = session.players.me;
    me.commanderDamage = { [damageKey("sam", 0)]: 21, [damageKey("sam", 1)]: 3 };
    openModal("Counters", countersHtml());
    return { banner: document.querySelector(".lethal-banner")?.textContent.trim() || null,
             lethal: isLethal(me) };
  });
  check("twenty-one from ONE partner is lethal", r.lethal === true);
  check("and says which rule it was",
    /21 commander damage from one commander/.test(r.banner || ""), String(r.banner));
}
{
  // What the stepper actually sends.
  const sent = await page.evaluate(() => {
    const out = [];
    const real = sendMessage;
    window.sendMessage = (m) => out.push(m);
    openModal("Counters", countersHtml());
    document.querySelector('[data-step="cmdr"][data-id="sam:1"][data-delta="1"]').click();
    window.sendMessage = real;
    return out;
  });
  check("the stepper names the commander that dealt it",
    sent[0]?.sourcePlayerId === "sam" && sent[0]?.sourceSlot === 1, JSON.stringify(sent[0]));
  check("and still records it on yourself",
    sent[0]?.targetPlayerId === "me", JSON.stringify(sent[0]));
}

console.log("\ncommander tax, which is also per commander");
{
  const r = await page.evaluate(() => {
    const me = session.players.me;
    me.commanderDamage = {};
    me.commanderCasts = { 0: 2, 1: 0 };
    openModal("Counters", countersHtml());
    const rows = [...document.querySelectorAll('[data-step="casts"]')]
      .map((b) => b.dataset.id).filter((v, i, a) => a.indexOf(v) === i);
    return { rows,
      labels: [...document.querySelectorAll(".stepper-label")].map((e) => e.textContent.trim())
        .filter((l) => /Tax|tax/.test(l)),
      subs: [...document.querySelectorAll(".stepper-sub")].map((e) => e.textContent.trim())
        .filter((l) => /costs/.test(l)),
      tax0: commanderTax(me, 0), tax1: commanderTax(me, 1) };
  });
  check("two commanders, two tax rows", r.rows.length === 2, JSON.stringify(r.rows));
  check("each named", r.labels.some((l) => /Thrasios/.test(l)) && r.labels.some((l) => /Tymna/.test(l)),
    r.labels.join(" | "));
  // Casting one does not make the other more expensive.
  check("the one you've cast twice costs four", r.tax0 === 4, String(r.tax0));
  check("and its partner is still free", r.tax1 === 0, String(r.tax1));
  check("which the rows say", r.subs.some((t) => /costs 4 more/.test(t))
    && r.subs.some((t) => /costs 0 more/.test(t)), r.subs.join(" | "));
}
{
  // A session that was already running when this shipped holds a single number.
  const r = await page.evaluate(() => {
    const me = session.players.me;
    me.commanderCasts = 3;
    return { tax: commanderTax(me, 0), partner: commanderTax(me, 1) };
  });
  check("an old numeric cast count still reads", r.tax === 6, String(r.tax));
  check("without leaking onto the partner", r.partner === 0, String(r.partner));
}

console.log("\nviewing either card");
{
  const r = await page.evaluate(() => {
    session.players.me.commanderCasts = { 0: 0, 1: 0 };
    openPlayerMenu("sam");
    return {
      views: [...document.querySelectorAll('[data-menu="view"]')]
        .map((b) => ({ text: b.textContent.trim(), slot: b.dataset.slot })),
      damageRows: [...document.querySelectorAll('[data-step="cmdr"]')]
        .map((b) => b.dataset.id).filter((v, i, a) => a.indexOf(v) === i),
    };
  });
  check("the menu offers both of their commanders", r.views.length === 2, JSON.stringify(r.views));
  check("named separately", /Pir/.test(r.views[0].text) && /Toothy/.test(r.views[1].text),
    JSON.stringify(r.views));
  check("with a slot each", r.views[0].slot === "0" && r.views[1].slot === "1",
    JSON.stringify(r.views));
  check("and two damage rows to match", r.damageRows.length === 2, JSON.stringify(r.damageRows));
}
{
  const r = await page.evaluate(() => {
    closeModal();
    openPlayerMenu("ali");
    return [...document.querySelectorAll('[data-menu="view"]')].map((b) => b.textContent.trim());
  });
  check("a single-commander opponent gets one button, worded as before",
    r.length === 1 && /View commander/.test(r[0]), JSON.stringify(r));
  await page.evaluate(() => closeModal());
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe importer takes a pair");
{
  const rows = await page.evaluate(() => resolveImportRows(parseDeckLines(
    "Thrasios, Triton Hero // Tymna the Weaver\thttps://moxfield.com/decks/a\n" +
    "Nicol Bolas, the Ravager // Nicol Bolas, the Arisen\thttps://moxfield.com/decks/b\n" +
    "Krenko, Mob Boss + Tymna the Weaver\thttps://moxfield.com/decks/c"
  )));
  check("a pair written with // becomes one deck of two",
    rows[0].commander === "Thrasios, Triton Hero + Tymna the Weaver", rows[0].commander);
  check("with the union of their colours", rows[0].identity === "WUBG", rows[0].identity);
  check("and is flagged as a pair", rows[0].pair === true);
  // The whole reason the separator isn't "//": this is ONE card.
  check("a double-faced card is NOT split in half",
    rows[1].commander === "Nicol Bolas, the Ravager // Nicol Bolas, the Arisen",
    rows[1].commander);
  check("and keeps its own colours", rows[1].identity === "UBR", rows[1].identity);
  check("a pair written with + works too", rows[2].pair === true, rows[2].commander);
}
{
  const rows = await page.evaluate(() => resolveImportRows(parseDeckLines(
    "Deck\tCommander\tLabel\tLink\n" +
    "Snakes\tEzuri, Claw of Progress\tSnakes\thttps://moxfield.com/decks/s\n" +
    "Counters\tEzuri, Claw of Progress\tCounters\thttps://moxfield.com/decks/c\n" +
    "Plain\tEzuri, Claw of Progress\t\thttps://moxfield.com/decks/p"
  )));
  // The three decks that could not be imported before labels existed.
  check("a Label column makes them separate decks",
    rows.every((r) => r.status === "ok"), rows.map((r) => r.status).join(","));
  check("each keyed by its label",
    rows[0].commander === "Ezuri, Claw of Progress (Snakes)"
      && rows[1].commander === "Ezuri, Claw of Progress (Counters)", rows.map((r) => r.commander).join(" | "));
  check("and an unlabelled one is a third deck",
    rows[2].commander === "Ezuri, Claw of Progress", rows[2].commander);
  check("all three keep their colours", rows.every((r) => r.identity === "UG"),
    rows.map((r) => r.identity).join(","));
}
{
  // Without a Label column nothing is invented, or every deck nickname would
  // become one.
  const rows = await page.evaluate(() => resolveImportRows(parseDeckLines(
    "Snakes\tEzuri, Claw of Progress\thttps://moxfield.com/decks/s\n" +
    "Counters\tEzuri, Claw of Progress\thttps://moxfield.com/decks/c"
  )));
  check("no Label column means no labels", rows[0].commander === "Ezuri, Claw of Progress",
    rows[0].commander);
  check("so the repeat is still flagged", rows[1].status === "duplicate", rows[1].status);
}

console.log("\na pair round-trips through a deck chip");
{
  const r = await page.evaluate(async () => {
    await fetch("/__reset", { method: "POST" });
    await saveDeckRow("Thrasios, Triton Hero + Tymna the Weaver (cEDH)", "WUBG",
      "https://moxfield.com/decks/pair");
    await loadRecords();
    showScreen("home");
    chooseMode("join");
    document.querySelector("#input-code").value = "abcd";
    await startChosenMode();
    const chip = [...document.querySelectorAll(".fav-chip")].find((c) => /Thrasios/.test(c.textContent));
    chip?.click();
    return {
      chipText: chip?.textContent.replace(/\s+/g, " ").trim(),
      primary: document.querySelector("#input-commander").value,
      partner: document.querySelector("#input-commander-2").value,
      partnerShown: !document.querySelector("#partner-wrap").hidden,
      label: pendingDeckLabel,
      ci: currentIdentity(),
    };
  });
  check("the chip shows the whole deck", /Thrasios, Triton Hero \+ Tymna the Weaver \(cEDH\)/.test(r.chipText || ""),
    r.chipText);
  // Tapping it used to fill in one name. A partner deck would have silently
  // lost its partner on the way to the table.
  check("tapping it fills in the first commander", r.primary === "Thrasios, Triton Hero", r.primary);
  check("and the second", r.partner === "Tymna the Weaver", r.partner);
  check("opening the partner field to show it", r.partnerShown === true);
  check("keeps the label for the deck row", r.label === "cEDH", r.label);
  check("and sets the pair's colours", r.ci === "WUBG", r.ci);
}
{
  const r = await page.evaluate(async () => {
    const decksNow = await fetch("/__decks").then((r) => r.json());
    return decksNow.decks.find((d) => d.commander === "Thrasios, Triton Hero");
  });
  check("the saved row keeps the pair apart from the label",
    r?.commander2 === "Tymna the Weaver" && r?.label === "cEDH", JSON.stringify(r));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\nstill fits a small phone");
{
  await page.evaluate(() => closeModal());
  await seatTable(true);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => {
    const me = session.players.me;
    me.commanderDamage = { [damageKey("sam", 0)]: 7 };
    openModal("Counters", countersHtml());
    const card = document.querySelector("#modal-body").getBoundingClientRect();
    const rows = [...document.querySelectorAll(".stepper-row")];
    return {
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      overflows: rows.some((x) => x.getBoundingClientRect().right > card.right + 1),
      clipped: [...document.querySelectorAll(".stepper-label")]
        .some((e) => e.scrollHeight > e.clientHeight + 2),
      rowHeights: new Set([...document.querySelectorAll('[data-step="cmdr"]')]
        .map((b) => Math.round(b.closest(".stepper-row").getBoundingClientRect().height))).size,
      seatSideways: false,
    };
  });
  check("the extra rows don't push the page sideways", r.sideways === false);
  check("nor escape the modal", r.overflows === false);
  check("and no label is clipped vertically", r.clipped === false);
  // Uniform heights are the tell that no commander name wrapped: a partnered
  // opponent's rows must look like the rest of the list, not taller.
  check("every commander-damage row is the same height", r.rowHeights === 1, String(r.rowHeights));

  await page.evaluate(() => closeModal());
  const seat = await page.evaluate(() => ({
    sideways: document.documentElement.scrollWidth > window.innerWidth,
    // A pair is a long string. It must truncate rather than wrap, or one seat
    // becomes taller than the others and the table stops lining up.
    lines: new Set([...document.querySelectorAll(".opponent-row")]
      .map((e) => Math.round(e.getBoundingClientRect().height))).size,
  }));
  check("two commanders at a seat don't widen the table", seat.sideways === false);
  check("and every opponent row is still the same height", seat.lines === 1, String(seat.lines));
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
