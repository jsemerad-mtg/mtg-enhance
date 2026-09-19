// The paperclip: attaching, editing and copying a decklist link.

import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pw;
const BASE = "http://127.0.0.1:8232";
let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}
const SIGNED_IN = { mode: "in", state: { email: "jay@example.com", name: "Jay", all: false,
  identities: ["WUBG"], slotsTotal: 5, slotsUsed: 1, slotsLeft: 4 } };
await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify(SIGNED_IN) });

// The mock server outlives any one suite, so reset its decks first — otherwise
// whatever the last suite wrote is still here and the row counts drift.
await fetch(`${BASE}/__reset`, { method: "POST" });

const browser = await chromium.launch(LAUNCH);
const ctx = await browser.newContext({ viewport: { width: 390, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(BASE);
await page.waitForFunction(() => sessionState === "in");
await page.click('[data-pick="stats"]');
await page.waitForFunction(() => recordsState === "ready" && decks.length > 0);

console.log("\nthe list merges games and decks");
{
  const names = await page.evaluate(() => commanderRows().map((r) => r.commander));
  check("a commander with games appears", names.includes("Atraxa, Grand Unifier"), names.join("|"));
  // The case that matters: a deck saved but never played to a finish is
  // exactly when someone wants to paste the list in.
  check("so does a saved deck with no finished games",
    names.includes("Shorikai, Genesis Engine"), names.join("|"));
  check("and a commander that is both isn't duplicated",
    names.filter((n) => n === "Krenko, Mob Boss").length === 1, names.join("|"));
}
{
  const r = await page.evaluate(() => {
    const clips = [...document.querySelectorAll("[data-deck]")];
    return {
      count: clips.length,
      attached: clips.filter((c) => c.classList.contains("has-link")).map((c) => c.dataset.deck),
      label: clips.find((c) => c.dataset.deck === "Atraxa, Grand Unifier")?.getAttribute("aria-label"),
    };
  });
  check("every row has a paperclip", r.count === 3, String(r.count));
  check("only the one with a link is marked",
    r.attached.join() === "Shorikai, Genesis Engine", r.attached.join());
  check("the label says which commander, and add vs edit",
    /Add a decklist link for Atraxa/.test(r.label || ""), String(r.label));
}

console.log("\nattaching a link");
{
  await page.evaluate(() => document.querySelector('[data-deck="Atraxa, Grand Unifier"]').click());
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => ({
    title: document.querySelector(".modal-title")?.textContent || document.querySelector("#modal-body").textContent,
    value: document.querySelector("#deck-url").value,
    copyDisabled: document.querySelector("[data-deck-copy]").disabled,
    openDisabled: document.querySelector("[data-deck-open]").disabled,
    text: document.querySelector("#modal-body").textContent.replace(/\s+/g, " "),
  }));
  check("opens empty for a deck with no link", r.value === "");
  check("copy is disabled while there's nothing to copy", r.copyDisabled === true);
  check("and so is open", r.openDisabled === true);
  check("says the servers never fetch it",
    /never fetch or read it/.test(r.text), r.text.slice(0, 200));
  check("while saying what Open does do",
    /takes you there in a new tab/.test(r.text), r.text.slice(0, 220));
}
{
  // Both buttons act on the FIELD, so they have to follow it. Copy used to be
  // enabled from the saved row, which left it dead right after pasting a link.
  const r = await page.evaluate(async () => {
    const box = document.querySelector("#deck-url");
    box.value = "https://moxfield.com/decks/typed";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((res) => setTimeout(res, 60));
    return { copy: document.querySelector("[data-deck-copy]").disabled,
             open: document.querySelector("[data-deck-open]").disabled };
  });
  check("typing a link enables copy before it is saved", r.copy === false);
  check("and open with it", r.open === false);
}
{
  const r = await page.evaluate(async () => {
    const box = document.querySelector("#deck-url");
    box.value = "moxfield.com/decks/typed";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((res) => setTimeout(res, 60));
    return { copy: document.querySelector("[data-deck-copy]").disabled,
             open: document.querySelector("[data-deck-open]").disabled };
  });
  // Copy is still fine — you may well want to copy a half-typed link and fix
  // it elsewhere. Opening one is not a thing a browser can do.
  check("a link with no scheme can still be copied", r.copy === false);
  check("but not opened", r.open === true);
}
{
  const r = await page.evaluate(async () => {
    document.querySelector("#deck-url").value = "not a url";
    await saveDeckLink("Atraxa, Grand Unifier", "not a url");
    const err = document.querySelector("#deck-error");
    return { hidden: err.hidden, text: err.textContent };
  });
  check("a non-URL is refused before any round trip",
    r.hidden === false && /should start with https/.test(r.text), r.text);
}
{
  // The bug worth guarding: the deck upsert replaces every column it's given,
  // so saving a link must carry the bracket or it silently erases it.
  const sent = await page.evaluate(async () => {
    await saveDeckLink("Krenko, Mob Boss", "https://archidekt.com/decks/123");
    const r = await fetch("/__decks").then((x) => x.json());
    return r.lastDeckPost;
  });
  check("the link is sent", sent?.deckUrl === "https://archidekt.com/decks/123", JSON.stringify(sent?.deckUrl));
  check("and the existing bracket rides along, not wiped", sent?.bracket === 4, String(sent?.bracket));
  check("with the colours too", sent?.identity === "R", String(sent?.identity));
}
{
  const marked = await page.evaluate(() => {
    renderRecords();
    return [...document.querySelectorAll("[data-deck].has-link")].map((c) => c.dataset.deck).sort();
  });
  check("the row now shows as attached",
    marked.join("|") === "Krenko, Mob Boss|Shorikai, Genesis Engine", marked.join("|"));
}

console.log("\nediting and copying");
{
  await page.evaluate(() => document.querySelector('[data-deck="Shorikai, Genesis Engine"]').click());
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => ({
    value: document.querySelector("#deck-url").value,
    copyDisabled: document.querySelector("[data-deck-copy]").disabled,
    canClear: !!document.querySelector("[data-deck-clear]"),
  }));
  check("an existing link is prefilled and editable", r.value === "https://moxfield.com/decks/abc", r.value);
  check("copy is available", r.copyDisabled === false);
  check("and so is removing it", r.canClear === true);
}

console.log("\nopening the decklist");
{
  const r = await page.evaluate(async () => {
    const calls = [];
    const real = window.open;
    window.open = (...args) => { calls.push(args); return {}; };
    document.querySelector("[data-deck-open]").click();
    await new Promise((res) => setTimeout(res, 120));
    window.open = real;
    return { calls, err: document.querySelector("#deck-error").hidden };
  });
  check("it opens the saved link", r.calls[0]?.[0] === "https://moxfield.com/decks/abc",
    JSON.stringify(r.calls[0]));
  check("in a new tab", r.calls[0]?.[1] === "_blank", String(r.calls[0]?.[1]));
  // noopener severs window.opener so the decklist site can't reach back into
  // the table's tab; noreferrer keeps the table's URL out of its logs.
  check("with the opener severed", /noopener/.test(r.calls[0]?.[2] || ""), String(r.calls[0]?.[2]));
  check("and no referrer leaked", /noreferrer/.test(r.calls[0]?.[2] || ""), String(r.calls[0]?.[2]));
  check("and nothing is complained about", r.err === true);
}
const BAD = ["javascript:alert(1)", "data:text/html,<h1>hi", "moxfield.com/x", "  "];
{
  // The guard a person actually meets: the button goes dead the moment the
  // field stops holding something a browser could open.
  const r = await page.evaluate(async (bad) => {
    const box = document.querySelector("#deck-url");
    const out = [];
    for (const v of bad) {
      box.value = v;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((res) => setTimeout(res, 30));
      out.push(document.querySelector("[data-deck-open]").disabled);
    }
    return out;
  }, BAD);
  check("javascript:, data:, a bare host and an empty box all disable Open",
    r.every(Boolean), JSON.stringify(r));
}
{
  // And the handler refuses them anyway. The button's state can go stale —
  // autofill, a programmatic value change, a paste a browser handles oddly —
  // so the rule lives where the action happens, not only on the control.
  const r = await page.evaluate(async (bad) => {
    const calls = [];
    const real = window.open;
    window.open = (...args) => { calls.push(args); return {}; };
    const box = document.querySelector("#deck-url");
    const errs = [];
    for (const v of bad) {
      box.value = v;                                   // no input event fired
      const btn = document.querySelector("[data-deck-open]");
      btn.disabled = false;                            // pretend the state is stale
      btn.click();
      await new Promise((res) => setTimeout(res, 40));
      errs.push(document.querySelector("#deck-error").textContent);
    }
    window.open = real;
    return { calls: calls.length, errs };
  }, BAD);
  check("clicked anyway, none of them opens", r.calls === 0, String(r.calls));
  check("and each says what a link should look like",
    r.errs.every((t) => /should start with https/.test(t)), JSON.stringify(r.errs));
}
{
  // Some browsers refuse the tab. Saying so beats a button that looks broken.
  const r = await page.evaluate(async () => {
    const real = window.open;
    window.open = () => null;
    const box = document.querySelector("#deck-url");
    box.value = "https://moxfield.com/decks/abc";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("[data-deck-open]").click();
    await new Promise((res) => setTimeout(res, 120));
    window.open = real;
    const note = document.querySelector("#deck-note");
    return { hidden: note.hidden, text: note.textContent };
  });
  check("a blocked pop-up says so", r.hidden === false);
  check("and says what to do instead", /copy the link/i.test(r.text), r.text);
}
{
  const r = await page.evaluate(async () => {
    document.querySelector("[data-deck-copy]").click();
    await new Promise((res) => setTimeout(res, 200));
    const note = document.querySelector("#deck-note");
    return { note: note.textContent, hidden: note.hidden,
             clip: await navigator.clipboard.readText().catch(() => null) };
  });
  check("copying says it worked", r.hidden === false && /Copied/.test(r.note), r.note);
  check("and the clipboard really has the link",
    r.clip === "https://moxfield.com/decks/abc", String(r.clip));
}
{
  const sent = await page.evaluate(async () => {
    await saveDeckLink("Shorikai, Genesis Engine", "");
    return fetch("/__decks").then((x) => x.json());
  });
  const row = sent.decks.find((d) => d.commander === "Shorikai, Genesis Engine");
  check("removing the link clears it", row.deck_url === null, String(row.deck_url));
  check("without taking the bracket with it", row.bracket === 2, String(row.bracket));
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
