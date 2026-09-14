// Unit tests for the palette-slot logic in shared-session.js.
//
// This is the code path with money attached: it decides whether a player has
// paid for a colour identity and it spends a slot that can't be un-spent. The
// tests below are written against the failure modes that actually cost
// something — a double-tap spending two slots, a refund making slotsLeft
// negative, Scryfall's alphabetical ordering creating a second spelling of an
// identity the player already owns.
//
//   node tests/entitlements.test.mjs     (or: npm test)

import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const mod = await import("../src/shared-session.js");
const { canonicalIdentity, currentUser, unlockIdentity } = mod;

let pass = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}

// ── A stub D1 that behaves like the real one where it matters ───────────────
// Specifically: it enforces the partial unique index. If the stub let a
// duplicate identity row through, these tests would pass while production
// double-spends, which is exactly the bug worth catching.
function makeDb(rows, { failInsert = false } = {}) {
  const table = [...rows];
  return {
    inserts: table,
    prepare(sql) {
      const bound = [];
      const stmt = {
        bind(...args) { bound.push(...args); return stmt; },
        async first() {
          if (sql.includes("FROM users")) {
            return { id: bound[0], email: "jay@example.com", name: "Jay" };
          }
          return null;
        },
        async all() {
          return { results: table.filter((r) => r.user_id === bound[0]).map((r) => ({ product: r.product })) };
        },
        async run() {
          if (failInsert) throw new Error("D1_ERROR: disk is on fire");
          const [user_id, product] = bound;
          if (product !== "enhance_pack" && table.some((r) => r.user_id === user_id && r.product === product)) {
            throw new Error("D1_ERROR: UNIQUE constraint failed: entitlements.user_id, entitlements.product");
          }
          table.push({ user_id, product });
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

// A session cookie the module will actually verify, rather than a stub that
// bypasses the signature check — otherwise the tests prove nothing about auth.
const SECRET = "test-secret-not-a-real-one";
const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function makeCookie(payload) {
  const body = b64url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}
async function req(payload = { sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }) {
  const token = payload === null ? null : await makeCookie(payload);
  return { headers: { get: (h) => (h === "Cookie" && token ? `mtgo_session=${token}` : null) } };
}
const envWith = (db) => ({ SESSION_SECRET: SECRET, DB: db });

console.log("\ncanonicalIdentity");
check("Scryfall's alphabetical Atraxa becomes WUBG", canonicalIdentity("BGUW") === "WUBG", canonicalIdentity("BGUW"));
check("already-canonical input is unchanged", canonicalIdentity("WUBG") === "WUBG");
check("empty identity becomes the colorless key", canonicalIdentity("") === "C", canonicalIdentity(""));
check("lowercase is accepted", canonicalIdentity("gw") === "WG", canonicalIdentity("gw"));
check("duplicate letters collapse", canonicalIdentity("WWU") === "WU", canonicalIdentity("WWU"));

console.log("\ncurrentUser — slot arithmetic");
{
  const db = makeDb([
    { user_id: "u1", product: "enhance_pack" },
    { user_id: "u1", product: "enhance_pack" },
    { user_id: "u1", product: "identity:WUBG" },
  ]);
  const me = await currentUser(await req(), envWith(db));
  check("two packs give ten slots", me.slotsTotal === 10, String(me.slotsTotal));
  check("one spent identity counts as used", me.slotsUsed === 1, String(me.slotsUsed));
  check("nine left", me.slotsLeft === 9, String(me.slotsLeft));
  check("not flagged as owning everything", me.all === false);
}
{
  // A refund removed a pack after the slots were spent.
  const db = makeDb([
    { user_id: "u1", product: "identity:WUBG" },
    { user_id: "u1", product: "identity:R" },
  ]);
  const me = await currentUser(await req(), envWith(db));
  check("slotsLeft never renders negative", me.slotsLeft === 0, String(me.slotsLeft));
}
{
  const db = makeDb([{ user_id: "u1", product: "enhance_all" }]);
  const me = await currentUser(await req(), envWith(db));
  check("enhance_all sets the all flag", me.all === true);
}

console.log("\ncurrentUser — auth");
check("no cookie is signed out", (await currentUser(await req(null), envWith(makeDb([])))).signedIn === false);
{
  const bad = { headers: { get: () => "mtgo_session=garbage.garbage" } };
  check("a malformed cookie is signed out", (await currentUser(bad, envWith(makeDb([])))).signedIn === false);
}
{
  const expired = await req({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 60 });
  check("an expired cookie is signed out", (await currentUser(expired, envWith(makeDb([])))).signedIn === false);
}
{
  // Same payload, signed with a different secret — the mismatched-SESSION_SECRET case.
  const forged = { headers: { get: () => "mtgo_session=eyJzdWIiOiJ1MSJ9.AAAA" } };
  check("a forged signature is signed out", (await currentUser(forged, envWith(makeDb([])))).signedIn === false);
}
check("no DB configured is signed out, not an exception",
  (await currentUser(await req(), { SESSION_SECRET: SECRET })).signedIn === false);

console.log("\nunlockIdentity");
{
  const db = makeDb([{ user_id: "u1", product: "enhance_pack" }]);
  const r = await unlockIdentity(await req(), envWith(db), "BGUW");
  check("spends a slot and returns fresh state", r.ok === true && r.slotsLeft === 4, JSON.stringify(r));
  check("stores the canonical spelling, not Scryfall's",
    db.inserts.some((x) => x.product === "identity:WUBG"),
    JSON.stringify(db.inserts.map((x) => x.product)));
}
{
  // The double-tap. Both requests see 5 slots left; only one row may exist.
  const db = makeDb([{ user_id: "u1", product: "enhance_pack" }]);
  const [a, b] = await Promise.all([
    unlockIdentity(await req(), envWith(db), "WUBG"),
    unlockIdentity(await req(), envWith(db), "WUBG"),
  ]);
  const rows = db.inserts.filter((x) => x.product === "identity:WUBG").length;
  check("a double-tap writes exactly one row", rows === 1, `${rows} rows`);
  check("both calls report success", a.ok && b.ok);
  check("only one slot was spent", a.slotsLeft === 4 && b.slotsLeft === 4, `${a.slotsLeft}/${b.slotsLeft}`);
}
{
  const db = makeDb([{ user_id: "u1", product: "identity:WUBG" }]);
  const r = await unlockIdentity(await req(), envWith(db), "WUBG");
  check("re-unlocking something owned is free and idempotent", r.ok === true && r.alreadyOwned === true);
  check("and spends nothing", db.inserts.length === 1, String(db.inserts.length));
}
{
  const db = makeDb([]);
  const r = await unlockIdentity(await req(), envWith(db), "WUBG");
  check("no slots means refusal", r.ok === false && /no palette slots/i.test(r.error), JSON.stringify(r));
  check("and writes nothing", db.inserts.length === 0);
}
{
  const db = makeDb([{ user_id: "u1", product: "enhance_all" }]);
  const r = await unlockIdentity(await req(), envWith(db), "WUBG");
  check("owning everything never spends a slot", r.ok === true && r.alreadyOwned === true && db.inserts.length === 1);
}
{
  const db = makeDb([{ user_id: "u1", product: "enhance_pack" }]);
  const r = await unlockIdentity(await req(null), envWith(db), "WUBG");
  check("signed out cannot unlock", r.ok === false && r.signedIn === false);
  check("and nothing is written", db.inserts.length === 1);
}
{
  const db = makeDb([{ user_id: "u1", product: "enhance_pack" }]);
  const r = await unlockIdentity(await req(), envWith(db), "XYZ");
  check("junk identity is rejected", r.ok === false && /colour identity/i.test(r.error), JSON.stringify(r));
}
{
  const db = makeDb([{ user_id: "u1", product: "enhance_pack" }]);
  const r = await unlockIdentity(await req(), envWith(db), "");
  check("colorless is a real, unlockable identity", r.ok === true, JSON.stringify(r));
  check("stored as identity:C", db.inserts.some((x) => x.product === "identity:C"));
}
{
  // A genuine write failure must not be swallowed as success — otherwise the
  // player is told they own a palette they don't.
  const db = makeDb([{ user_id: "u1", product: "enhance_pack" }], { failInsert: true });
  const r = await unlockIdentity(await req(), envWith(db), "WUBG");
  check("a real DB error surfaces as failure", r.ok === false, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.log(" ✗ " + f)); process.exit(1); }
