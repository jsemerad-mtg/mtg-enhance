// ─── Reading the shared mtg-oracle.com session ───────────────────────────────
//
// MTG Enhance implements no sign-in of its own. Signing in happens once, on
// either app, and MTG Oracle's Worker issues an HMAC-signed session cookie
// scoped to `.mtg-oracle.com`. Because Enhance is served from
// enhance.mtg-oracle.com, that cookie arrives here on every request and this
// file only has to verify it and read what the account owns.
//
// Two things have to match Oracle exactly or nothing works:
//   - SESSION_SECRET, the same Worker secret, so the signature verifies
//   - the D1 binding, the same mtg_oracle_db, so there is one users table
//
// Deliberately no token issuing, no password handling and no OAuth here. A
// second implementation of sign-in is a second thing to get wrong.

const SESSION_COOKIE = 'mtgo_session';

function b64urlToBytes(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

// Same envelope Oracle signs: "<base64url(payload)>.<base64url(signature)>".
export async function verifySession(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC', key, b64urlToBytes(sig), new TextEncoder().encode(body)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readSessionCookie(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

// Canonical WUBRG order. Scryfall hands back colour identity alphabetically
// ("B","G","U","W" for Atraxa), so every identity that crosses this boundary is
// normalised here as well as in the client. Two spellings of the same identity
// would mean a player could pay twice for one deck.
const WUBRG = ["W", "U", "B", "R", "G"];

export function canonicalIdentity(letters) {
  const set = new Set(String(letters || "").toUpperCase().split(""));
  const ordered = WUBRG.filter((c) => set.has(c)).join("");
  // Colorless has no letters, so it needs a name of its own to be a key.
  return ordered || "C";
}

const SLOTS_PER_PACK = 5;

// Turns entitlement rows into the shape the client actually reasons about.
// Kept in one function because the client must never compute this itself: a
// slot count that lives in the browser is a slot count a player can edit.
function summarise(rows) {
  const products = (rows || []).map((r) => r.product);
  const all = products.includes("enhance_all");
  const identities = products
    .filter((p) => p.startsWith("identity:"))
    .map((p) => p.slice("identity:".length));
  const packs = products.filter((p) => p === "enhance_pack").length;
  const slotsTotal = packs * SLOTS_PER_PACK;
  return {
    all,
    identities,
    slotsTotal,
    slotsUsed: identities.length,
    // Can go negative in one situation only: a refund removed a pack after the
    // slots were spent. Clamped so the UI never renders "-2 left".
    slotsLeft: Math.max(0, slotsTotal - identities.length),
  };
}

async function entitlementRows(env, userId) {
  // Failing closed is right — a database wobble must never hand out palettes
  // nobody paid for — but failing SILENTLY is how a missing table spent an
  // evening looking like an empty account. So: still return nothing, and say
  // why where `wrangler tail` can see it.
  const { results } = await env.DB
    .prepare(
      `SELECT product FROM entitlements
        WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .bind(userId)
    .all()
    .catch((e) => {
      console.error("entitlements read failed:", e?.message || e);
      return { results: [] };
    });
  return results || [];
}

// Who is signed in, and what have they bought. Returns a signed-out shape
// rather than throwing when accounts aren't configured yet, so the app keeps
// working as a guest experience regardless.
export async function currentUser(request, env) {
  if (!env.SESSION_SECRET || !env.DB) return { signedIn: false };

  const session = await verifySession(readSessionCookie(request), env.SESSION_SECRET);
  if (!session?.sub) return { signedIn: false };

  const user = await env.DB
    .prepare('SELECT id, email, name FROM users WHERE id = ?')
    .bind(session.sub)
    .first()
    .catch(() => null);
  if (!user) return { signedIn: false };

  return {
    signedIn: true,
    email: user.email,
    name: user.name || user.email.split('@')[0],
    ...summarise(await entitlementRows(env, user.id)),
  };
}

// Spend one palette slot on one colour identity, permanently.
//
// Every check here is deliberately server-side. The client shows a confirm
// dialog, but a confirm dialog is a courtesy, not a control — the only thing
// standing between a player and 32 free identities is this function.
//
// The race that matters: two taps on the confirm button, or the same account
// open on a phone and a laptop. Both requests read "3 slots left" and both
// insert. The partial unique index on (user_id, product) makes the second
// INSERT fail rather than double-spend, so we let the database arbitrate and
// treat a constraint failure as "already owned" — which it is.
export async function unlockIdentity(request, env, rawIdentity) {
  if (!env.SESSION_SECRET || !env.DB) {
    return { ok: false, error: "Accounts aren't configured on this server yet." };
  }
  const session = await verifySession(readSessionCookie(request), env.SESSION_SECRET);
  if (!session?.sub) return { ok: false, error: "Sign in first.", signedIn: false };

  // Validate BEFORE canonicalising, not after. canonicalIdentity() filters out
  // anything that isn't a colour letter, so "XYZ" comes back as "" and then
  // reads as colorless — a validation check downstream of it always passes,
  // and junk quietly spends a slot on the wrong palette.
  const raw = String(rawIdentity ?? "").toUpperCase();
  const isColorless = raw === "" || raw === "C";
  if (!isColorless && !/^[WUBRG]{1,5}$/.test(raw)) {
    return { ok: false, error: "That isn't a colour identity." };
  }
  const identity = isColorless ? "C" : canonicalIdentity(raw);

  const state = summarise(await entitlementRows(env, session.sub));
  if (state.all || state.identities.includes(identity)) {
    // Nothing to spend — they already have it. Idempotent on purpose, so a
    // retry after a dropped connection can't cost anything.
    return { ok: true, alreadyOwned: true, ...state };
  }
  if (state.slotsLeft <= 0) {
    return { ok: false, error: "No palette slots left.", ...state };
  }

  try {
    await env.DB
      .prepare(
        `INSERT INTO entitlements (user_id, product, source, reference)
         VALUES (?, ?, 'slot', ?)`
      )
      .bind(session.sub, `identity:${identity}`, `slot:${identity}`)
      .run();
  } catch (e) {
    // Unique-index collision means a concurrent request won. Same outcome.
    if (!String(e.message || e).toLowerCase().includes("unique")) {
      return { ok: false, error: "Could not record the unlock." };
    }
  }

  // Re-read rather than patching the copy we already have: the authoritative
  // answer is whatever the table says after the write.
  return { ok: true, ...summarise(await entitlementRows(env, session.sub)) };
}
