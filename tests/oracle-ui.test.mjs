// Ask the Oracle — rendering, escaping, the unread badge and the dictation gate.
//
// The escaping tests are the ones that matter. The rules answer is text a
// language model wrote, delivered to three other people's screens; the card
// entry is built from a Scryfall response. Neither may be able to introduce
// markup.

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

console.log("\ntwo buttons, not one O");
{
  const r = await page.evaluate(() => {
    const card = document.querySelector("#btn-card-lookup");
    const rules = document.querySelector("#btn-rules");
    return {
      both: !!card && !!rules,
      oldOne: !!document.querySelector("#btn-oracle"),
      cardLabel: card?.getAttribute("aria-label"),
      rulesLabel: rules?.getAttribute("aria-label"),
      // Icons, not letters: the O told nobody what it did.
      cardSvg: card?.querySelector("svg") !== null,
      rulesSvg: rules?.querySelector("svg") !== null,
    };
  });
  check("both buttons exist", r.both === true);
  check("the old O is gone", r.oldOne === false);
  check("the card button says what it does", /card/i.test(r.cardLabel || ""), r.cardLabel);
  check("and so does the rules button", /rules/i.test(r.rulesLabel || ""), r.rulesLabel);
  check("both are drawn, not lettered", r.cardSvg && r.rulesSvg);
}
{
  const r = await page.evaluate(() => {
    document.querySelector("#btn-card-lookup").click();
    const first = document.querySelector(".oracle-modal h3")?.textContent;
    const focused = document.activeElement?.id;
    const title = document.querySelector("#modal-title").textContent;
    return { first, focused, title };
  });
  check("the card button leads with the card section", /show a card/i.test(r.first || ""), r.first);
  check("and puts the cursor in the card box", r.focused === "oracle-card-input", String(r.focused));
  check("and titles the modal accordingly", /show a card/i.test(r.title), r.title);
}
{
  const r = await page.evaluate(() => {
    document.querySelector("#btn-rules").click();
    const heads = [...document.querySelectorAll(".oracle-modal h3")].map((h) => h.textContent);
    return { first: heads[0], all: heads, focused: document.activeElement?.id };
  });
  check("the rules button leads with the rules section", /rules question/i.test(r.first || ""), r.first);
  check("and puts the cursor in the question box", r.focused === "oracle-question", String(r.focused));
  // Both halves stay present either way: one feed, and a card lookup usually
  // becomes a rules question about that card a moment later.
  check("the card section is still there", r.all.some((h) => /show a card/i.test(h)), r.all.join(" | "));
}

console.log("\nunread badge");
{
  const state = await page.evaluate(() => {
    // Not open, so the arrival should mark unread.
    muted = true;                       // don't try to make noise in a headless browser
    closeModal();
    oracleFeed = [];
    oracleUnread = { card: 0, rules: 0 };
    receiveOracleEvent({ kind: "rules", askedBy: "Sam", question: "q", answer: "a" });
    const rules = document.querySelector("#btn-rules");
    const card = document.querySelector("#btn-card-lookup");
    return {
      unread: { ...oracleUnread },
      rulesGlowing: rules.classList.contains("has-news"),
      cardGlowing: card.classList.contains("has-news"),
      label: rules.getAttribute("aria-label"),
    };
  });
  check("a rules answer marks one unread answer", state.unread.rules === 1);
  check("the scales are told to glow", state.rulesGlowing === true);
  // The point of splitting the button: which one pulses says what arrived.
  check("and the card button is left alone", state.cardGlowing === false);
  check("the count reaches a screen reader", /1 new answer/.test(state.label), state.label);
}
{
  const state = await page.evaluate(() => {
    closeModal();
    oracleUnread = { card: 0, rules: 0 };
    receiveOracleEvent({ kind: "card", askedBy: "Sam", scryfallId: "abc" });
    return {
      unread: { ...oracleUnread },
      cardGlowing: document.querySelector("#btn-card-lookup").classList.contains("has-news"),
      rulesGlowing: document.querySelector("#btn-rules").classList.contains("has-news"),
      label: document.querySelector("#btn-card-lookup").getAttribute("aria-label"),
    };
  });
  check("a shown card marks the card button instead", state.unread.card === 1 && state.unread.rules === 0,
    JSON.stringify(state.unread));
  check("the card frame glows", state.cardGlowing === true);
  check("and the scales don't", state.rulesGlowing === false);
  check("named for a screen reader", /1 new card/.test(state.label), state.label);
}
{
  const after = await page.evaluate(() => {
    openOracle();
    return {
      unread: { ...oracleUnread },
      glowing: [...document.querySelectorAll(".header-icon.has-news")].length,
    };
  });
  // Opening either one shows the whole feed, so both counters clear.
  check("opening clears both counts", after.unread.card === 0 && after.unread.rules === 0,
    JSON.stringify(after.unread));
  check("and stops every glow", after.glowing === 0, String(after.glowing));
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
