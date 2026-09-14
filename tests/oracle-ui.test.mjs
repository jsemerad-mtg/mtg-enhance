// Ask the Oracle — rendering, escaping, the unread badge and the dictation gate.
//
// The escaping tests are the ones that matter. The rules answer is text a
// language model wrote, delivered to three other people's screens; the card
// entry is built from a Scryfall response. Neither may be able to introduce
// markup.

import pw from "playwright";
const { chromium } = pw;

const BASE = process.env.MTGE_TEST_BASE || "http://127.0.0.1:8232";
let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}

await fetch(`${BASE}/__mock`, { method: "POST", body: JSON.stringify({ mode: "out", state: null }) });

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(BASE);
await page.waitForFunction(() => typeof oracleFeed !== "undefined");

console.log("\nanswer text cannot carry markup");
{
  const html = await page.evaluate(() =>
    oracleMarkup('<img src=x onerror="alert(1)"> and <script>alert(2)<\/script>')
  );
  check("tags are escaped, not rendered", !/<img|<script/i.test(html), html.slice(0, 120));
  check("the text itself survives", /&lt;img/.test(html) && /alert\(1\)/.test(html));
}
{
  const html = await page.evaluate(() => oracleMarkup("**Dockside Extortionist** enters\nand triggers"));
  check("bold markdown becomes <strong>", /<strong>Dockside Extortionist<\/strong>/.test(html));
  check("newlines become <br>", /<br>/.test(html));
}
{
  // A model could emit bold markers around markup. Escaping happens first, so
  // the tag is already inert by the time bold is applied.
  const html = await page.evaluate(() => oracleMarkup('**<b onmouseover="x">hi</b>**'));
  check("markup inside bold is still inert", !/<b /.test(html), html.slice(0, 120));
}

console.log("\nthe feed renders what it is given, and nothing more");
{
  const html = await page.evaluate(() => {
    oracleFeed = [{
      kind: "rules",
      askedBy: '<script>alert(3)<\/script>',
      question: '<img src=x onerror=alert(4)>',
      answer: "Yes, the trigger still resolves.",
    }];
    return oracleFeedHtml();
  });
  check("asker name is escaped", !/<script/i.test(html));
  check("question is escaped", !/<img/i.test(html));
  check("answer still shows", /trigger still resolves/.test(html));
}
{
  const html = await page.evaluate(() => {
    oracleFeed = [{ kind: "card", scryfallId: '" onload="alert(5)', askedBy: "Jay" }];
    return oracleFeedHtml();
  });
  // The quotes must arrive as entities. Stripping the entities first — as an
  // earlier version of this test did — turns correctly-escaped output back
  // into something that looks like an attack, and fails a passing case.
  const attr = html.match(/data-scryfall="([^"]*)"/)[1];
  check("a forged card id is escaped into the attribute, not out of it",
    attr.includes("&quot;") && !attr.includes('"'), attr);
  check("card entries render a placeholder, not caller text", /Loading…/.test(html));
}

console.log("\nunread badge");
{
  const state = await page.evaluate(() => {
    // Not open, so the arrival should mark unread.
    muted = true;                       // don't try to make noise in a headless browser
    oracleFeed = [];
    oracleUnread = 0;
    receiveOracleEvent({ kind: "rules", askedBy: "Sam", question: "q", answer: "a" });
    const btn = document.querySelector("#btn-oracle");
    return { unread: oracleUnread, glowing: btn.classList.contains("has-news"), label: btn.getAttribute("aria-label") };
  });
  check("arrival marks one unread", state.unread === 1);
  check("the O is told to glow", state.glowing === true);
  check("the count reaches a screen reader", /1 new/.test(state.label), state.label);
}
{
  const after = await page.evaluate(() => {
    openOracle();
    const btn = document.querySelector("#btn-oracle");
    return { unread: oracleUnread, glowing: btn.classList.contains("has-news") };
  });
  check("opening clears the unread count", after.unread === 0);
  check("and stops the glow", after.glowing === false);
}

console.log("\nthe ask box");
{
  const shown = await page.evaluate(() => {
    session.oracleAsked = 3;
    openOracle();
    return document.querySelector(".oracle-modal").textContent.replace(/\s+/g, " ");
  });
  check("remaining questions are stated", /7 questions left at this table/.test(shown), shown.slice(0, 220));
}
{
  const none = await page.evaluate(() => {
    session.oracleAsked = 10;
    openOracle();
    const btn = document.querySelector('[data-oracle="ask"]');
    return { text: document.querySelector(".oracle-modal").textContent.replace(/\s+/g, " "), disabled: btn.disabled };
  });
  check("an exhausted table says 0 questions left", /0 questions left/.test(none.text));
  check("and the ask button is disabled", none.disabled === true);
}
{
  const counter = await page.evaluate(async () => {
    session.oracleAsked = 0;
    openOracle();
    const box = document.querySelector("#oracle-question");
    box.value = "does the trigger still resolve";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return document.querySelector("#oracle-count").textContent;
  });
  check("the character counter tracks typing", counter === "30 / 400", counter);
}
{
  const max = await page.evaluate(() => document.querySelector("#oracle-question").maxLength);
  check("the box itself caps at 400, matching the server", max === 400, String(max));
}

console.log("\ndictation");
{
  // Note for anyone reading this later: headless Chromium DOES expose
  // webkitSpeechRecognition, so it is not a stand-in for an unsupported
  // browser. The constructor existing says nothing about whether dictation
  // will actually work — permission can be refused and the service can fail —
  // which is why startDictation() resets the button on `onerror` as well.
  const r = await page.evaluate(() => ({
    supported: speechSupported(),
    micCount: document.querySelectorAll("[data-mic]").length,
  }));
  check("this browser reports support, so mics render", r.supported === true);
  check("one mic per input", r.micCount === 2, String(r.micCount));
}
{
  // Now the real unsupported case, forced.
  const r = await page.evaluate(() => {
    const sr = window.SpeechRecognition, wsr = window.webkitSpeechRecognition;
    Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
    const supported = speechSupported();
    openOracle();
    const n = document.querySelectorAll("[data-mic]").length;
    Object.defineProperty(window, "SpeechRecognition", { value: sr, configurable: true });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: wsr, configurable: true });
    return { supported, n };
  });
  check("without the API, support reports false", r.supported === false);
  check("and no dead mic button is rendered", r.n === 0, String(r.n));
}

check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
