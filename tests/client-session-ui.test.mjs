// Browser tests for the account layer: the three session states, the palette
// screens, and the soundboard's gating.
//
// The soundboard lives behind a live WebSocket game, so rather than rebuild the
// Durable Object protocol these tests call soundBoardHtml() directly with a
// stubbed `session` — it's a pure function of the session payload plus the
// player's colour identity, which is exactly what needs checking.

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

const setMock = (page, body) =>
  page.evaluate((b) => fetch("/__mock", { method: "POST", body: JSON.stringify(b) }).then((r) => r.json()), body);

const SIGNED_IN = {
  mode: "in",
  state: { email: "jay@example.com", name: "Jay", all: false,
           identities: ["WUBG"], slotsTotal: 5, slotsUsed: 1, slotsLeft: 4 },
};

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

// The mock keeps state between runs, so start from a known place rather than
// inheriting whatever the last run left behind.
await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify({ mode: "out", state: null }) });

// ── signed out ──────────────────────────────────────────────────────────────
console.log("\nsigned out");
await page.goto(BASE);
await page.waitForFunction(() => typeof sessionState !== "undefined" && sessionState !== "unknown");
check("login button reads 'Log in'", (await page.textContent("#btn-login")).trim() === "Log in");
check("no account object", await page.evaluate(() => account === null));

await page.click("#btn-login");
await page.waitForSelector(".auth-modal");
{
  const body = await page.textContent(".auth-modal");
  check("sign-in screen points at MTG Oracle", /MTG Oracle/.test(body));
  check("and says an account isn't needed to play", /don't need an account to host or join/i.test(body), body.slice(0, 160));
  check("no password field is rendered anywhere", (await page.locator('input[type="password"]').count()) === 0);
}
check("home favorites prompt sign-in", /Sign in to save/i.test(await page.textContent("#favorites-list")));

// ── unreachable: the AdBlock Plus case ──────────────────────────────────────
console.log("\nunreachable (403, the ad-blocker case)");
await setMock(page, { mode: "down" });
await page.reload();
await page.waitForTimeout(400);
check("state is unknown, not signed-out", await page.evaluate(() => sessionState === "unknown"));
check("button does NOT offer to log in", (await page.textContent("#btn-login")).trim() === "Account");
await page.click("#btn-login");
await page.waitForSelector(".auth-modal");
{
  const body = await page.textContent(".auth-modal");
  check("screen says it couldn't check, not that you're signed out", /Couldn't check your account/i.test(body));
  check("and names the ad blocker as a likely cause", /ad blocker/i.test(body));
  check("offers a retry", (await page.locator('[data-auth="do-retry"]').count()) === 1);
}

// A previously-good session must survive a failed check. This is the whole
// point of the three-state model.
console.log("\nknown-good session survives a failed check");
await setMock(page, SIGNED_IN);
await page.reload();
await page.waitForFunction(() => sessionState === "in");
await setMock(page, { mode: "down" });
await page.evaluate(() => refreshSession());
await page.waitForTimeout(300);
check("still signed in after a 403", await page.evaluate(() => sessionState === "in"));
check("name still shown on the button", (await page.textContent("#btn-login")).trim() === "Jay");

// ── signed in ───────────────────────────────────────────────────────────────
console.log("\nsigned in");
await setMock(page, SIGNED_IN);
await page.reload();
await page.waitForFunction(() => sessionState === "in");
check("button shows the account name", (await page.textContent("#btn-login")).trim() === "Jay");
await page.click("#btn-login");
await page.waitForSelector(".auth-modal");
{
  const body = await page.textContent(".auth-modal");
  check("email is shown", /jay@example\.com/.test(body));
  check("slot count is stated", /4 palette slots left of 5/.test(body), body.replace(/\s+/g, " ").slice(0, 200));
  check("owned palette is named in full", /White · Blue · Black · Green/.test(body));
  check("log out is offered", (await page.locator('[data-auth="do-logout"]').count()) === 1);
}

console.log("\npricing screen");
await page.click('[data-auth="view-upgrade"]');
await page.waitForTimeout(150);
{
  const body = await page.textContent(".auth-modal");
  check("pack price shown", /\$4\.99/.test(body));
  check("everything price shown", /\$14\.99/.test(body));
  check("free universal sounds are stated", /free and always will be/i.test(body.replace(/\s+/g, " ")));
}

// ── the unlock confirm ──────────────────────────────────────────────────────
console.log("\nunlock confirm");
await page.evaluate(() => openAuth("unlock", "RG"));
await page.waitForTimeout(150);
{
  const body = await page.textContent(".auth-modal");
  check("names the palette", /Unlock Red · Green\?/.test(await page.textContent(".modal-title, .auth-modal")) || /Red · Green/.test(body));
  check("states the cost against remaining slots", /1 of your 4/.test(body.replace(/\s+/g, " ")), body.replace(/\s+/g, " ").slice(0, 200));
  check("says it's permanent", /permanently/i.test(body));
  check("warns about one-off decks", /one-off deck/i.test(body));
  check("offers a way out", (await page.locator('[data-auth="do-close"]').count()) === 1);
}

console.log("\nspending a slot");
await page.click("[data-unlock]");
await page.waitForFunction(() => (account.identities || []).includes("RG"));
check("identity is now owned", await page.evaluate(() => account.identities.includes("RG")));
check("slots decremented from the server's answer", await page.evaluate(() => account.slotsLeft === 3));

// ── soundboard gating ───────────────────────────────────────────────────────
console.log("\nsoundboard gating");
const boardFor = (identity, acct) =>
  page.evaluate(([ci, a]) => {
    session.players = { me: { colorIdentity: ci.split("") } };
    selfId = "me";
    account = a;
    sessionState = a ? "in" : "out";
    return soundBoardHtml();
  }, [identity, acct]);

{
  const html = await boardFor("WUBG", null);
  check("guest sees universal sounds unlocked", /<h3>Universal<\/h3>\s*<ul class="sound-list">/.test(html));
  check("guest sees colour sounds locked", /sound-list locked/.test(html));
  check("guest is asked to sign in, not to pay", /Sign in to unlock palettes/.test(html));
}
{
  const html = await boardFor("WUBG", { ...SIGNED_IN.state, identities: [], slotsUsed: 0, slotsLeft: 4 });
  check("signed-in with slots is offered the unlock", /Unlock White · Blue · Black · Green — uses 1 of 4/.test(html.replace(/\s+/g, " ")));
  check("and the palette is still locked", /sound-list locked/.test(html));
}
{
  const html = await boardFor("WUBG", { ...SIGNED_IN.state, identities: [], slotsTotal: 0, slotsUsed: 0, slotsLeft: 0 });
  check("no slots means the pricing CTA", /Get palette slots/.test(html));
}
{
  const html = await boardFor("WUBG", { ...SIGNED_IN.state, identities: ["WUBG"] });
  check("owned palette unlocks the colour sections", !/sound-list locked/.test(html));
  check("and no upsell is shown", !/upgrade-cta/.test(html));
}
{
  // Scryfall order must not create a second, unowned spelling of a palette.
  const html = await boardFor("BGUW", { ...SIGNED_IN.state, identities: ["WUBG"] });
  check("alphabetical identity still reads as owned", !/sound-list locked/.test(html));
}
{
  const html = await boardFor("", { ...SIGNED_IN.state, identities: ["C"] });
  check("colorless commander with the C palette is unlocked", !/sound-list locked/.test(html));
}
{
  const html = await boardFor("WUBG", { ...SIGNED_IN.state, identities: [], all: true });
  check("owning everything unlocks without spending", !/sound-list locked/.test(html));
}

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
