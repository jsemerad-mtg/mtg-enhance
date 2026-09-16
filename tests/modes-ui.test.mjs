// The home-screen mode chooser: three equal buttons, choose then commit.

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
const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(BASE);
await page.waitForFunction(() => typeof chosenMode !== "undefined");

const box = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}, sel);

console.log("\nnothing is chosen to begin with");
{
  const r = await page.evaluate(() => ({
    chosen: chosenMode,
    highlighted: document.querySelectorAll(".mode-btn.is-chosen").length,
    detailHidden: document.querySelector("#mode-detail").hidden,
  }));
  check("no mode selected", r.chosen === null);
  check("no button highlighted", r.highlighted === 0);
  check("no prompt, no code box, no action button yet", r.detailHidden === true);
}

console.log("\nfour equal buttons");
{
  const dims = await page.evaluate(() =>
    [...document.querySelectorAll(".mode-btn")].map((b) => {
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
    })
  );
  check("there are four", dims.length === 4, String(dims.length));
  check("equal widths", new Set(dims.map((d) => d.w)).size === 1, JSON.stringify(dims.map((d) => d.w)));
  check("equal heights", new Set(dims.map((d) => d.h)).size === 1, JSON.stringify(dims.map((d) => d.h)));
  // 2x2 at phone width. Four labels on one 390px row would be ~90px each,
  // which is narrower than the words.
  check("two rows of two at 390px", new Set(dims.map((d) => d.top)).size === 2,
    JSON.stringify(dims.map((d) => d.top)));
}
{
  await page.setViewportSize({ width: 700, height: 800 });
  const tops = await page.evaluate(() =>
    [...document.querySelectorAll(".mode-btn")].map((b) => Math.round(b.getBoundingClientRect().top))
  );
  check("and one row of four once there's room", new Set(tops).size === 1, JSON.stringify(tops));
  await page.setViewportSize({ width: 390, height: 800 });
}
{
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check("the page doesn't scroll sideways at 390px", overflow === false);
}

console.log("\nchoosing a local game");
{
  await page.click('[data-pick="colocated"]');
  const r = await page.evaluate(() => ({
    chosen: chosenMode,
    highlighted: [...document.querySelectorAll(".mode-btn.is-chosen")].map((b) => b.dataset.pick),
    checked: document.querySelector('[data-pick="colocated"]').getAttribute("aria-checked"),
    prompt: document.querySelector("#mode-prompt").textContent,
    action: document.querySelector("#btn-mode-go").textContent,
    codeHidden: document.querySelector("#input-code").hidden,
    pinHidden: document.querySelector("#pin-toggle-row").hidden,
  }));
  check("the button highlights, and only that one", r.highlighted.join() === "colocated", r.highlighted.join());
  check("and is marked selected for screen readers", r.checked === "true");
  check("prompt names the same-table assumption",
    /everyone is at the same table/i.test(r.prompt) && /proceed\?/i.test(r.prompt), r.prompt);
  check("action button reads Create game", r.action === "Create game", r.action);
  check("no code box for a host", r.codeHidden === true);
  check("the PIN option is offered", r.pinHidden === false);
}

console.log("\nswitching to remote");
{
  await page.click('[data-pick="remote"]');
  const r = await page.evaluate(() => ({
    highlighted: [...document.querySelectorAll(".mode-btn.is-chosen")].map((b) => b.dataset.pick),
    prompt: document.querySelector("#mode-prompt").textContent,
    action: document.querySelector("#btn-mode-go").textContent,
  }));
  check("only the new choice is highlighted", r.highlighted.join() === "remote", r.highlighted.join());
  check("prompt names remote players",
    /joining remotely/i.test(r.prompt) && /proceed\?/i.test(r.prompt), r.prompt);
  check("still Create game", r.action === "Create game");
}

console.log("\nswitching to join");
{
  await page.click('[data-pick="join"]');
  const r = await page.evaluate(() => ({
    prompt: document.querySelector("#mode-prompt").textContent,
    action: document.querySelector("#btn-mode-go").textContent,
    codeHidden: document.querySelector("#input-code").hidden,
    pinHidden: document.querySelector("#pin-toggle-row").hidden,
    focused: document.activeElement?.id,
  }));
  check("prompt asks for the code", /4-character game code/i.test(r.prompt), r.prompt);
  check("action button becomes Join game", r.action === "Join game", r.action);
  check("the code box appears", r.codeHidden === false);
  check("the PIN option goes away — a joiner doesn't set one", r.pinHidden === true);
  check("and the code box is focused, ready to type", r.focused === "input-code", String(r.focused));
}

console.log("\ncommitting");
{
  const r = await page.evaluate(() => {
    document.querySelector("#input-code").value = "AB";
    document.querySelector("#btn-mode-go").click();
    const err = document.querySelector("#home-error");
    return { screen: currentScreen, hidden: err.hidden, text: err.textContent };
  });
  check("a short code doesn't advance", r.screen === "home");
  check("and says what's wrong", r.hidden === false && /4-character/i.test(r.text), r.text);
}
{
  // A code nobody is hosting. Caught while the code box is still on screen.
  const r = await page.evaluate(async () => {
    document.querySelector("#input-code").value = "zzzz";
    await startChosenMode();
    const err = document.querySelector("#home-error");
    return { screen: currentScreen, hidden: err.hidden, text: err.textContent };
  });
  check("an unknown code doesn't advance", r.screen === "home", r.screen);
  check("and names the code that failed", r.hidden === false && /ZZZZ/.test(r.text), r.text);
  check("and points at the host", /whoever is hosting/i.test(r.text), r.text);
}
{
  // A real table that wants a PIN: the field is ready on arrival, not after a
  // rejected join.
  const r = await page.evaluate(async () => {
    document.querySelector("#input-code").value = "pinx";
    await startChosenMode();
    return {
      screen: currentScreen,
      pinHidden: document.querySelector("#join-pin-field").hidden,
      focused: document.activeElement?.id,
    };
  });
  check("a PIN table still enters the lobby", r.screen === "lobby", r.screen);
  check("with the PIN field already showing", r.pinHidden === false);
  check("and the cursor in it", r.focused === "input-join-pin", String(r.focused));
}
{
  const r = await page.evaluate(async () => {
    showScreen("home"); chooseMode("join");
    document.querySelector("#input-code").value = "abcd";
    await startChosenMode();
    return { screen: currentScreen, pinHidden: document.querySelector("#join-pin-field").hidden };
  });
  check("a table without a PIN shows no PIN field", r.screen === "lobby" && r.pinHidden === true, JSON.stringify(r));
}
{
  await page.evaluate(() => { showScreen("home"); chooseMode("join"); });
  const r = await page.evaluate(async () => {
    document.querySelector("#input-code").value = "abcd";
    await startChosenMode();
    // `code` isn't set until the socket connects — the lobby holds the
    // not-yet-joined table as `pendingCode`, which is what to assert here.
    return { screen: currentScreen, pending: pendingCode, shown: document.querySelector("#lobby-code").textContent };
  });
  check("a full code enters the lobby", r.screen === "lobby", r.screen);
  check("and is upper-cased on the way", r.pending === "ABCD", String(r.pending));
  check("and the lobby shows that table code", r.shown === "ABCD", r.shown);
}
{
  // Enter used to submit the form. The form is gone; the behaviour shouldn't be.
  await page.evaluate(() => { showScreen("home"); chooseMode("join"); });
  const r = await page.evaluate(async () => {
    const input = document.querySelector("#input-code");
    input.value = "ABCD";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { screen: currentScreen, pending: pendingCode };
  });
  check("Enter in the code box still joins", r.screen === "lobby" && r.pending === "ABCD", JSON.stringify(r));
}

console.log("\nthe PIN gate still applies to hosts");
{
  const r = await page.evaluate(() => {
    showScreen("home");
    chooseMode("colocated");
    document.querySelector("#input-pin-required").checked = true;
    document.querySelector("#input-pin-required").dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#input-host-pin").value = "12";
    document.querySelector("#btn-mode-go").click();
    const err = document.querySelector("#home-error");
    return { hidden: err.hidden, text: err.textContent };
  });
  check("a half-typed PIN is refused", r.hidden === false && /4-digit PIN/i.test(r.text), r.text);
}

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
