// The bracket picker and the gate on sitting down.

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
await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify({ mode: "out", state: null }) });
const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(BASE);
await page.waitForFunction(() => typeof bracketAnswered !== "undefined");
await page.evaluate(() => { pendingCode = "ABCD"; showScreen("lobby"); updateSitButton(); });

console.log("\nsix buttons");
{
  const r = await page.evaluate(() => {
    const b = [...document.querySelectorAll("[data-bracket]")];
    const dims = b.map((x) => { const q = x.getBoundingClientRect();
      return { w: Math.round(q.width), top: Math.round(q.top) }; });
    return { labels: b.map((x) => x.textContent.trim()), dims,
             titles: b.map((x) => x.title) };
  });
  check("1 to 5 plus ??", r.labels.join("") === "12345??", r.labels.join(""));
  check("equal widths", new Set(r.dims.map((d) => d.w)).size === 1, JSON.stringify(r.dims.map((d) => d.w)));
  check("all on one row", new Set(r.dims.map((d) => d.top)).size === 1);
  check("each carries its name for anyone unsure what 3 means",
    r.titles.join("|") === "Exhibition|Core|Upgraded|Optimized|cEDH|Not sure", r.titles.join("|"));
}

console.log("\nsitting down is gated");
{
  const r = await page.evaluate(() => ({
    disabled: document.querySelector("#btn-sit-down").disabled,
    hint: document.querySelector("#sit-hint").textContent,
  }));
  check("blocked before anything is filled in", r.disabled === true);
  check("and says what's missing rather than sitting there grey",
    /your name.*a commander.*a bracket/.test(r.hint), r.hint);
}
{
  const r = await page.evaluate(() => {
    const n = document.querySelector("#input-name"); n.value = "Jay";
    n.dispatchEvent(new Event("input", { bubbles: true }));
    const c = document.querySelector("#input-commander"); c.value = "Krenko, Mob Boss";
    c.dispatchEvent(new Event("input", { bubbles: true }));
    return { disabled: document.querySelector("#btn-sit-down").disabled,
             hint: document.querySelector("#sit-hint").textContent };
  });
  check("still blocked with only name and commander", r.disabled === true);
  check("and the hint narrows to the bracket", /Still need a bracket\./.test(r.hint), r.hint);
}
{
  const r = await page.evaluate(() => {
    document.querySelector('[data-bracket="3"]').click();
    return { disabled: document.querySelector("#btn-sit-down").disabled,
             answered: bracketAnswered, value: bracketValue,
             note: document.querySelector("#bracket-note").textContent,
             chosen: [...document.querySelectorAll(".bracket-btn.is-chosen")].map((b) => b.dataset.bracket) };
  });
  check("picking a bracket unlocks sitting down", r.disabled === false);
  check("the value is the number", r.value === 3, String(r.value));
  check("only that button highlights", r.chosen.join() === "3", r.chosen.join());
  check("and it's named, not just numbered", /Bracket 3 — Upgraded/.test(r.note), r.note);
}

console.log("\n?? is a real answer, not a skip");
{
  const r = await page.evaluate(() => {
    document.querySelector('[data-bracket="?"]').click();
    return { disabled: document.querySelector("#btn-sit-down").disabled,
             answered: bracketAnswered, value: bracketValue,
             note: document.querySelector("#bracket-note").textContent };
  });
  check("it counts as answered", r.answered === true);
  check("but stores nothing", r.value === null, String(r.value));
  check("and still lets you sit down", r.disabled === false);
  check("saying plainly that no bracket is recorded",
    /No bracket recorded/.test(r.note), r.note);
}

console.log("\nwhat reaches the table");
{
  const sent = await page.evaluate(() => {
    let captured = null;
    const realWS = window.WebSocket;
    window.WebSocket = function () {
      const fake = { readyState: 1, send: (raw) => { captured = JSON.parse(raw); },
        addEventListener: (ev, fn) => { if (ev === "open") setTimeout(fn, 0); }, close() {} };
      return fake;
    };
    document.querySelector('[data-bracket="5"]').click();
    document.querySelector("#form-lobby").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return new Promise((res) => setTimeout(() => { window.WebSocket = realWS; res(captured); }, 30));
  });
  check("the join carries the bracket", sent?.bracket === 5, JSON.stringify(sent?.bracket));
  check("alongside the commander", sent?.commanderName === "Krenko, Mob Boss", String(sent?.commanderName));
}

check("no uncaught page errors", errs.length === 0, errs.join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
