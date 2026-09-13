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

  const { results } = await env.DB
    .prepare(
      `SELECT product FROM entitlements
        WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .bind(user.id)
    .all()
    .catch(() => ({ results: [] }));

  const entitlements = (results || []).map((r) => r.product);
  return {
    signedIn: true,
    email: user.email,
    name: user.name || user.email.split('@')[0],
    entitlements,
    // The one flag this app actually gates on today.
    pro: entitlements.includes('enhance_full'),
  };
}
