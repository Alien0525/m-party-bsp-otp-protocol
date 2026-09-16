"use strict";
// ===========================================================================
// Asynchronous m=4 OTPAC simulator -- INDIVIDUAL-JUMP design.
//
// Core ideas (from Aman + Giovanni meetings):
//  * Jumps are per-PARTY, not per-pair. Whoever needs more pads jumps alone;
//    a party that stops just stays put.
//  * Every party keeps its OWN local view of every other party: for party k it
//    stores k's confirmed pos, dir, and a d-length buffer = the next d pad
//    indices k might use (unheard-of), computed by a jump-aware successor.
//  * DIRECTION IS PRESERVED on a solo jump into free space. When two parties
//    resolve to the same root-most region they split it: M (facing left) and
//    M+1 (facing right) -- the only place direction can flip, so two movers are
//    at worst adjacent, never on the same pad.
//  * A jumpspot M is only offered while it has > d clearance on both sides in
//    the mover's own view; once a host creeps too close, M is no longer offered
//    and the successor re-targets the next root-most legal region.
//  * Delivery: per-recipient sliding bound -- a message to r is force-delivered
//    before r's own (d+1)-th subsequent Send. Each recipient delays on its own
//    clock, so views of the same party legitimately differ (by <= d).
//
// Security: no pad index emitted by two Send events. Halt+report on any dup.
// Also assert: no observer-pair's view of a party diverges by > d; no Send
// writes a pad currently reserved (in the sender's own view) for another party.
// ===========================================================================

// ---- static BSP midpoints over [1..n], root-first (largest cell first) ----
function bspNodes(n) {
  const out = [];
  const q = [[1, n]];
  while (q.length) {
    const [L, R] = q.shift();
    const M = (L + R) >> 1;
    if (M > L && M < R) { out.push(M); if (R - L >= 2) { q.push([L, M - 1]); q.push([M + 1, R]); } }
  }
  return out;                       // in breadth-first (root-most) order
}

// ---------------------------------------------------------------------------
// A "world" = the ground truth: each party's true pos, dir, halted, used pads.
// A "view"  = one observer's belief about the other parties (pos/dir/buffer).
// ---------------------------------------------------------------------------
function initWorld(n, d, m = 4) {
  // m parties in m/2 facing pairs across equal arenas, exactly like the paper.
  const parties = [];
  const arenas = m / 2, aw = Math.floor(n / arenas);
  for (let a = 0; a < arenas; a++) {
    const L = a * aw + 1, R = (a === arenas - 1) ? n : (a + 1) * aw;
    parties.push({ id: 2 * a,     pos: L, dir: +1, halted: false, sent: 0, started: false });
    parties.push({ id: 2 * a + 1, pos: R, dir: -1, halted: false, sent: 0, started: false });
  }
  return { n, d, m, parties, used: new Map(), nodes: bspNodes(n) };
}

// occupancy predicate used by nextSlot, evaluated against a *view*:
//   a pad is "blocked" if it's used, or reserved in this view for some party.
function buildBlocked(view, n) {
  // view.self = observer's own {pos,dir}; view.others = map id-> {pos,dir,buf[]}
  const blocked = new Set();
  const reservedBy = new Map();
  for (const [id, o] of view.others) {
    blocked.add(o.pos);
    for (const b of o.buf) { blocked.add(b); if (!reservedBy.has(b)) reservedBy.set(b, id); }
  }
  blocked.add(view.self.pos);
  // pads known to be already consumed (own history + heard-of others' sends):
  // one-time pads can never be revisited, so they are obstacles for both a
  // party's own moves and for generating any party's forward buffer.
  if (view.used) for (const u of view.used) blocked.add(u);
  return { blocked, reservedBy };
}

// jump-aware successor: given a party's pos/dir and the observer view, return
// the next pad the party would use, under the BUFFER-OVERLAP trigger model:
//   1) linear step pos+dir IF it is not blocked AND the party's own d-buffer
//      does not yet overlap another party's reserved buffer (i.e. the arena
//      still has room: the linear pad keeps > d clearance to the facing block).
//      A party walks its current arena down until only d free pads remain.
//   2) once the arena is down to d (buffers overlap), the party JUMPS: it takes
//      the next root-most BSP jumpspot -- M+1 if it is a right-mover, M if a
//      left-mover -- provided that landing pad is free with > d clearance on
//      both sides. Two opposite-direction jumpers to the same M therefore take
//      M and M+1 (adjacent, never equal).
// Returns { pad, jumped, face } or null (halt: no legal jumpspot anywhere).
function nextSlot(pos, dir, view, n, d, nodes) {
  const { blocked } = buildBlocked(view, n);
  const lin = pos + dir;
  // room left in the current arena ahead of us (free pads before a blocker):
  const ahead = clearance(pos, dir, blocked, n);
  if (lin >= 1 && lin <= n && !blocked.has(lin) && ahead > d) {
    // still > d free pads ahead: keep walking the arena.
    return { pad: lin, jumped: false, face: dir };
  }
  // arena down to <= d (buffers overlap): JUMP.
  // A BSP node is the PAIR of center pads (M, M+1). It is a candidate jumpspot
  // only if BOTH pads are still free (unconsumed AND unreserved) in this view --
  // if either pad is taken (a party started there, walked over it, or already
  // jumped onto it), every party skips the node and looks deeper. The shallowest
  // such node is the target; a left-mover takes M, a right-mover takes M+1, so a
  // left- and a right-mover completing the same node DIVERGE (never cross).
  for (const M of nodes) {
    const left = M, right = M + 1;
    if (right > n) continue;
    if (blocked.has(left) && blocked.has(right)) continue;   // fully occupied -> descend
    const cand = dir === +1 ? right : left;                  // my direction's pad
    if (blocked.has(cand)) continue;                         // my pad already taken
    // valid only if > d free pads on BOTH sides of the landing pad (no party --
    // including the observer itself -- within d on either side). Otherwise this
    // node is too close to someone; go deeper for the next root-most node.
    if (clearance(cand, +1, blocked, n) > d && clearance(cand, -1, blocked, n) > d)
      return { pad: cand, jumped: true, face: dir };
  }
  return null;                             // nowhere legal to jump: halt
}

// count consecutive free pads starting one step in `step` direction from p
function clearance(p, step, blocked, n) {
  let c = 0, q = p + step;
  while (q >= 1 && q <= n && !blocked.has(q)) { c++; q += step; }
  return c;
}

// ---------------------------------------------------------------------------
// jump-aware buffer refresh for an OBSERVER's view of party k:
// the buffer is k's next d pad indices, generated by repeatedly applying the
// successor from k's confirmed pos. This is what every observer computes; two
// observers differ only because their confirmed pos/used-set differ (by <= d).
// ---------------------------------------------------------------------------
function refreshBuffer(observerView, k, n, d, nodes) {
  const ko = observerView.others.get(k);
  let p = ko.pos, dir = ko.dir;
  const buf = [];
  // Obstacle set for generating k's OWN path must EXCLUDE k itself: a party's
  // own current position and its own upcoming pads are not obstacles to it.
  // Include only the OTHER tracked parties + the observer's self position.
  const obstacleOthers = new Map();
  for (const [id, o] of observerView.others) if (id !== k) obstacleOthers.set(id, o);
  const tmp = { self: observerView.self, others: obstacleOthers, used: observerView.used };
  for (let s = 0; s < d; s++) {
    const nx = nextSlot(p, dir, tmp, n, d, nodes);
    if (!nx) break;
    buf.push(nx.pad);
    p = nx.pad; if (nx.jumped) dir = nx.face;
    // block this pad for subsequent successor calls within the same buffer build
    tmp.others = new Map(tmp.others);
    tmp.others.set("_tmp" + s, { pos: nx.pad, dir, buf: [] });
  }
  ko.buf = buf;
}

module.exports = { bspNodes, initWorld, nextSlot, clearance, refreshBuffer, buildBlocked };
