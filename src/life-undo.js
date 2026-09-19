// Who may undo a life change, and for how long.
//
// Lifted out of the Durable Object so it can be tested without one. These are
// the rules that stop "undo" becoming "edit anyone's life total whenever you
// like", and rules like that should not live somewhere only a live WebSocket
// can reach.

// Long enough to notice a number move and say "wait, that was me"; short
// enough that nobody undoes a change three turns later.
export const UNDO_WINDOW_MS = 12000;

// Deliberately in memory and never persisted: the window is twelve seconds,
// and a Durable Object that hibernated and came back has already outlived it.
// A lost map means the undo fails, which is the honest answer rather than a
// resurrected button that does nothing.
export function rememberLifeChange(map, targetId, delta, now = Date.now()) {
  for (const [id, e] of map) {
    if (now - e.at > UNDO_WINDOW_MS) map.delete(id);
  }
  const eventId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  map.set(eventId, { targetId, delta, at: now });
  return eventId;
}

// Every reason an undo can be refused, in one place.
//
//   unknown   — no such event, or it has already been used. Single use is what
//               stops a replayed message draining someone's life total in a
//               loop: the entry is deleted the moment it is spent.
//   not-yours — only the player whose number moved may put it back. Without
//               this, any seat could undo any change at the table.
//   expired   — past the window. Checked against the server's clock, never a
//               timestamp the client sent.
export function undoDecision(map, eventId, requesterId, now = Date.now()) {
  const entry = map.get(String(eventId || ""));
  if (!entry) return { ok: false, reason: "unknown" };
  if (entry.targetId !== requesterId) return { ok: false, reason: "not-yours" };
  if (now - entry.at > UNDO_WINDOW_MS) return { ok: false, reason: "expired" };
  return { ok: true, entry };
}
