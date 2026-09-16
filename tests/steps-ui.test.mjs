// The step train, browser-back behaviour, and favorites in their new home.

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

const SIGNED_IN = {
  mode: "in",
  state: { email: "jay@example.com", name: "Jay", all: false,
           identities: ["WUBG"], slotsTotal: 5, slotsUsed: 1, slotsLeft: 4 },
};
await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify(SIGNED_IN) });

// The mock server outlives any one suite; start from a known set of decks.
await fetch(`${BASE}/__reset`, { method: "POST" });

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(BASE);
await page.waitForFunction(() => sessionState === "in");

const train = () => page.evaluate(() =>
  [...document.querySelectorAll("#step-train .step")].map((el) => ({
    label: el.querySelector(".step-label").textContent,
    state: el.className.replace("step is-", ""),
    clickable: el.tagName === "BUTTON",
  }))
);

console.log("\nthe train renders on first paint");
{
  const t = await train();
  check("three steps", t.length === 3, JSON.stringify(t));
  check("labelled Table / Commander / Game",
    t.map((x) => x.label).join("/") === "Table/Commander/Game", t.map((x) => x.label).join("/"));
  check("the first is current", t[0].state === "current");
  check("later steps are not clickable", !t[1].clickable && !t[2].clickable);
  check("current step is announced to screen readers",
    await page.evaluate(() => !!document.querySelector('#step-train [aria-current="step"]')));
}

console.log("\nmoving forward");
{
  const t = await page.evaluate(() => { showScreen("lobby"); return null; }).then(train);
  check("Table becomes done and clickable", t[0].state === "done" && t[0].clickable === true);
  check("Commander becomes current", t[1].state === "current");
  check("Game is still ahead", t[2].state === "todo" && t[2].clickable === false);
}

console.log("\nback from the lobby is free");
{
  const r = await page.evaluate(() => {
    document.querySelector('[data-step="home"]').click();
    return { screen: currentScreen, modalOpen: !document.querySelector("#modal-backdrop").hidden };
  });
  check("returns straight to the home screen", r.screen === "home");
  check("with no confirmation, since no seat was taken", r.modalOpen === false);
}

console.log("\nback from a game asks first");
{
  const r = await page.evaluate(() => {
    showScreen("lobby");
    showScreen("game");
    document.querySelector('[data-step="home"]').click();
    return {
      screen: currentScreen,
      text: document.querySelector("#modal-body").textContent.replace(/\s+/g, " "),
    };
  });
  check("does not leave immediately", r.screen === "game");
  check("asks about leaving the table", /Leave the table\?|drop out of this game/i.test(r.text), r.text.slice(0, 140));
  check("says the others keep playing", /others keep playing/i.test(r.text));
  check("says you can rejoin with the same code", /rejoin with the same code/i.test(r.text));
}
{
  const r = await page.evaluate(() => {
    document.querySelector("[data-step-cancel]").click();
    return { screen: currentScreen, modalOpen: !document.querySelector("#modal-backdrop").hidden };
  });
  check("Stay keeps you in the game", r.screen === "game");
  check("and closes the dialog", r.modalOpen === false);
}
{
  const r = await page.evaluate(() => {
    document.querySelector('[data-step="home"]').click();
    document.querySelector("[data-step-confirm]").click();
    return { screen: currentScreen, left: leftGame, socket: ws };
  });
  check("Leave goes home", r.screen === "home");
  check("and marks the game left, so nothing reconnects behind you", r.left === true);
  check("and drops the socket", r.socket === null);
}

console.log("\nthe browser's own back button");
{
  await page.evaluate(() => { leftGame = false; showScreen("lobby"); });
  await page.goBack();
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => ({ screen: currentScreen, onSite: location.pathname }));
  check("back from the lobby returns to the home screen, not off the site",
    r.screen === "home" && r.onSite === "/", JSON.stringify(r));
}
{
  // The case that matters on Android: a back gesture must not silently dump
  // someone out of a game in progress.
  await page.evaluate(() => { showScreen("lobby"); showScreen("game"); });
  await page.goBack();
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({
    screen: currentScreen,
    modalOpen: !document.querySelector("#modal-backdrop").hidden,
  }));
  check("back from a game asks rather than leaving", r.screen === "game" && r.modalOpen === true, JSON.stringify(r));
}
{
  const r = await page.evaluate(() => {
    document.querySelector("[data-step-cancel]").click();
    // Staying must leave the history where the player actually is, or the next
    // back press would skip a step.
    return { screen: currentScreen, state: history.state?.screen };
  });
  check("staying keeps history pointing at the game", r.screen === "game" && r.state === "game", JSON.stringify(r));
}

console.log("\nfavorites moved to the lobby");
{
  const r = await page.evaluate(() => ({
    inHome: !!document.querySelector("#screen-home .favorites"),
    inLobby: !!document.querySelector("#screen-lobby .favorites"),
  }));
  check("gone from the landing screen", r.inHome === false);
  check("present under the sit-down button", r.inLobby === true);
}
{
  const order = await page.evaluate(() => {
    const form = document.querySelector("#form-lobby");
    const favs = document.querySelector("#screen-lobby .favorites");
    return form.compareDocumentPosition(favs) & Node.DOCUMENT_POSITION_FOLLOWING ? "after" : "before";
  });
  check("and below the form, not above it", order === "after", order);
}
{
  const r = await page.evaluate(async () => {
    favorites = [];
    expectedCommanderName = "Atraxa, Grand Unifier";
    expectedIdentity = "WUBG";
    renderFavButton();
    document.querySelector("#btn-fav-commander").click();
    // The star writes a deck row now, so let the round trip finish before
    // asking what the list says.
    await new Promise((r) => setTimeout(r, 400));
    const list = document.querySelector("#favorites-list").textContent;
    return { saved: favorites.length, list, label: document.querySelector("#btn-fav-commander").textContent };
  });
  check("starring a commander saves it", r.saved === 1);
  check("and it appears in the list immediately", /Atraxa, Grand Unifier/.test(r.list), r.list.slice(0, 120));
  check("and the star button reflects it", /Saved to favorites/.test(r.label), r.label);
}
{
  const r = await page.evaluate(async () => {
    document.querySelector("#btn-fav-commander").click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      saved: favorites.length,
      list: document.querySelector("#favorites-list").textContent,
      label: document.querySelector("#btn-fav-commander").textContent,
    };
  });
  check("starring again removes it", r.saved === 0);
  check("and the list updates immediately", !/Atraxa/.test(r.list), r.list.slice(0, 120));
  check("and the star says so", /Save to favorites/.test(r.label) && !/Saved/.test(r.label), r.label);
}
{
  // The chips are the saved decks, not only what localStorage happens to hold,
  // so a commander saved on another device reads as saved here too.
  const r = await page.evaluate(() => {
    favorites = [];
    expectedCommanderName = "Krenko, Mob Boss";
    expectedIdentity = "R";
    renderFavButton();
    return document.querySelector("#btn-fav-commander").textContent;
  });
  check("a commander saved server-side already reads as saved", /Saved to favorites/.test(r), r);
}

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
