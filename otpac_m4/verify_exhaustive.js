"use strict";
// ===========================================================================
// Exhaustive verification of protocol A5 (otpac_m4.js) for small n and d.
//
// Explores EVERY reachable execution: at each point the next event is either
//   - a Send by any party that has not halted and has at most d messages
//     addressed to it still undelivered (the undelivery bound of the model), or
//   - the delivery of ANY message still in flight, in any order (deliveries to a
//     party are scheduled right before its next Send; see events()).
// So all send orders and all delivery orders allowed by the d bound are covered.
// Identical global states are explored once (states are hashed).
//
// Reports: states explored, finished executions, any pad reuse (with the event
// trace that leads to it), and the exact worst-case / best-case efficiency
// over all finished executions.
//
// usage: node verify_exhaustive.js <n> <d> [maxStates] [all|worst|lifo|instant]
//   all = every delivery order (full model checking); otherwise every SEND order
//   with deliveries by that fixed adversary.
//   or, as a module: explore(n, d, {start, maxStates})  (start = a mid-run state)
// ===========================================================================
const E = require("./otpac_m4.js");

function initState(n, d) {
  const w = E.initWorld(n, d, 4);
  const views = [];
  for (const me of w.parties) {
    const others = new Map();
    for (const k of w.parties) if (k.id !== me.id) others.set(k.id, { pos: k.pos, dir: k.dir, buf: [] });
    const v = { self: { pos: me.pos, dir: me.dir }, others, used: new Set() };
    for (const k of w.parties) if (k.id !== me.id) E.refreshBuffer(v, k.id, n, d, w.nodes);
    views.push(v);
  }
  return { n, d, nodes: w.nodes, parties: w.parties.map(p => ({ id: p.id, pos: p.pos, dir: p.dir, halted: false, sent: 0 })),
           used: new Map(), views, inflight: [] };
}

// --- canonical key -------------------------------------------------------
// The global key is the parties, used pads, messages in flight, the delivery
// focus, and one cached key per view (recomputed only for the view that changed).
const sortN = a => a.slice().sort((x, y) => x - y);
function viewKey(v) {
  const parts = ["V", v.self.pos, v.self.dir, ...sortN([...v.used]), "c", ...(v.selfClaim ? sortN([...v.selfClaim]) : [])];
  for (let k = 0; k < 4; k++) {
    const o = v.others.get(k); if (!o) continue;
    const pre = o.prefix || 0;
    parts.push("o", k, o.pos, o.dir, o.lastNum || 0, pre, "f", ...(o.fwd || []), "b", ...(o.buf || []),
      "r", ...(o.recv ? sortN([...o.recv].filter(x => x > pre)) : []),
      "h", ...(o.held ? [...o.held].sort((a, b) => a[0] - b[0]).map(e => e[0] + ":" + e[1]) : []),
      "L", ...(o.heldLand ? sortN([...o.heldLand]) : []), "C", ...(o.landClaim ? sortN([...o.landClaim]) : []));
  }
  return parts.join(",");
}
function key(S) {
  const parts = [S.focus];
  for (const p of S.parties) parts.push(p.pos, p.dir, p.halted ? 1 : 0, p.sent);
  parts.push("|", ...sortN([...S.used.keys()]));
  const ms = S.inflight.filter(m => !S.parties[m.to].halted).map(m => `${m.to}.${m.from}.${m.sseq}.${m.pad}`);
  parts.push("|", S.policy || "all", ...(S.policy && S.policy !== "all" ? ms : ms.sort()));
  for (let j = 0; j < 4; j++) parts.push("|", S.parties[j].halted ? "H" : S.vkeys[j]);
  return parts.join(",");
}
// 53-bit hash of the key (two independent 32-bit FNV-1a variants)
function h53(s) {
  let a = 0x811c9dc5 | 0, b = 0x9747b28c | 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; }
  return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff);
}
function strip(v) { for (const [, o] of v.others) { o.assumed = undefined; o.assumedLog = undefined; } }
function withKeys(S) { S.vkeys = S.views.map(viewKey); S.focus = S.focus ?? -1; return S; }
// shallow copy; the caller replaces the one view it modifies
function shallow(S) {
  return { n: S.n, d: S.d, nodes: S.nodes, parties: S.parties.map(p => ({ ...p })), used: S.used, views: S.views.slice(),
           vkeys: S.vkeys.slice(), inflight: S.inflight, focus: S.focus, policy: S.policy };
}

// --- events ------------------------------------------------------------------
// Partial-order reduction: messages to party x are delivered only right before
// x's next Send (a delivery changes nothing but x's own view, so every execution
// can be reordered this way without changing any Send). Once a delivery to x
// happens ("focus" = x), the next events are further deliveries to x or x's Send.
function pendingTo(S, x) { let c = 0; for (const m of S.inflight) if (m.to === x) c++; return c; }
function events(S) {
  const ev = [];
  if (S.parties.every(p => p.halted)) return ev;
  if (S.policy && S.policy !== "all") {                       // every send order; deliveries by a fixed adversary
    for (const p of S.parties) if (!p.halted) ev.push({ t: "S", x: p.id });
    return ev;
  }
  const cand = S.focus >= 0 ? [S.parties[S.focus]] : S.parties.filter(p => !p.halted);
  for (const p of cand) {
    if (p.halted) continue;
    if (pendingTo(S, p.id) <= S.d) ev.push({ t: "S", x: p.id });
    for (let i = 0; i < S.inflight.length; i++) if (S.inflight[i].to === p.id) ev.push({ t: "R", i });
  }
  return ev;
}

// fixed delivery adversaries (as in the test suite), applied after each Send:
//   instant: deliver everything;  worst: deliver nothing early, release the OLDEST
//   message to a recipient that has more than d pending;  lifo: release the NEWEST.
function deliverOne(S, m) {
  const v = structuredClone(S.views[m.to]);
  E.deliverBuffer(v, m.from, m.pad, m.dir, S.n, S.d, S.nodes, m.sseq);
  strip(v); S.views[m.to] = v; S.vkeys[m.to] = viewKey(v);
}
function deliverPolicy(S) {
  if (S.policy === "instant") { for (const m of S.inflight) if (!S.parties[m.to].halted) deliverOne(S, m); S.inflight = []; return; }
  for (const p of S.parties) {
    let mine = S.inflight.filter(m => m.to === p.id);
    while (mine.length > S.d) {
      const m = S.policy === "lifo" ? mine[mine.length - 1] : mine[0];
      if (!p.halted) deliverOne(S, m);
      S.inflight = S.inflight.filter(x => x !== m); mine = mine.filter(x => x !== m);
    }
  }
}

// apply event; returns {S, reuse|halt|sent}
function apply(S0, e) {
  const S = shallow(S0), n = S.n, d = S.d;
  if (e.t === "R") {
    const m = S0.inflight[e.i];
    S.inflight = S0.inflight.filter((_, i) => i !== e.i);
    const v = structuredClone(S0.views[m.to]);
    E.deliverBuffer(v, m.from, m.pad, m.dir, n, d, S.nodes, m.sseq);
    strip(v); S.views[m.to] = v; S.vkeys[m.to] = viewKey(v); S.focus = m.to;
    return { S };
  }
  S.focus = -1;
  const me = S.parties[e.x], v = structuredClone(S0.views[e.x]);
  v.self.pos = me.pos; v.self.dir = me.dir;
  const nx = E.nextSlot(me.pos, me.dir, v, n, d, S.nodes);
  if (!nx) { me.halted = true; S.views[e.x] = v; S.vkeys[e.x] = viewKey(v); return { S, halt: true }; }
  if (S0.used.has(nx.pad)) return { S, reuse: { pad: nx.pad, by: e.x, first: S0.used.get(nx.pad), jumped: nx.jumped } };
  me.pos = nx.pad; if (nx.jumped) me.dir = nx.face; me.sent++;
  S.used = new Map(S0.used); S.used.set(nx.pad, e.x); v.used.add(nx.pad);
  S.views[e.x] = v; S.vkeys[e.x] = viewKey(v);
  S.inflight = S0.inflight.slice();
  for (const k of S.parties) if (k.id !== e.x) S.inflight.push({ to: k.id, from: e.x, pad: nx.pad, dir: me.dir, sseq: me.sent, jumped: nx.jumped });
  if (S.policy && S.policy !== "all") deliverPolicy(S);
  return { S, sent: nx };
}

const L = ["A", "B", "C", "D"];
function fmt(e, S, r) {
  if (e.t === "R") { const m = S.inflight[e.i]; return `deliver ${L[m.from]}#${m.sseq}(pad ${m.pad})→${L[m.to]}`; }
  if (r && r.halt) return `${L[e.x]} halts`;
  if (r && r.reuse) return `${L[e.x]} would use pad ${r.reuse.pad} (already used by ${L[r.reuse.first]}) ← REUSE`;
  return `${L[e.x]} sends on pad ${r.sent.pad}${r.sent.jumped ? " (jump)" : ""}`;
}

// --- DFS over all executions -----------------------------------------------
function explore(n, d, opt = {}) {
  const maxStates = opt.maxStates || 5e6, maxReuse = opt.maxReuse || 3;
  const start0 = opt.start || initState(n, d);
  start0.policy = opt.policy || start0.policy || "all";
  const start = withKeys(start0);
  const seen = new Set();
  let states = 0, finished = 0, minEff = Infinity, maxEff = -Infinity, truncated = false, reuseCount = 0;
  const reuses = [], path = [];
  let worstTrace = null;
  const maxSends = opt.maxSends || Infinity;       // window: explore only the next maxSends Sends
  start.sendsDone = 0;
  let windowLeaves = 0;
  const stack = [{ S: start, ev: null, idx: 0 }];
  seen.add(h53(key(start)));
  stack[0].ev = events(start);
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.idx === 0 && top.ev.length && top.S.sendsDone >= maxSends) { windowLeaves++; top.idx = top.ev.length; }
    if (top.idx === 0 && top.ev.length === 0) {               // finished execution
      finished++;
      const eff = top.S.used.size / n;
      if (eff < minEff) { minEff = eff; worstTrace = path.slice(); }
      if (eff > maxEff) maxEff = eff;
    }
    if (top.idx >= top.ev.length) { stack.pop(); path.pop(); continue; }
    const e = top.ev[top.idx++];
    const r = apply(top.S, e);
    if (r.reuse) {
      reuseCount++;
      if (reuses.length < maxReuse) reuses.push({ trace: path.concat([fmt(e, top.S, r)]), info: r.reuse });
      if (reuseCount >= (opt.stopAfterReuse || Infinity)) break;
      continue;                                               // the protocol halts there
    }
    r.S.sendsDone = top.S.sendsDone + (e.t === "S" ? 1 : 0);
    const k = h53(key(r.S) + (maxSends < Infinity ? "#" + r.S.sendsDone : ""));
    if (seen.has(k)) continue;
    seen.add(k); states++;
    if (states >= maxStates) { truncated = true; break; }
    if (opt.progress && states % 200000 === 0) process.stderr.write(`  ${states} states, depth ${stack.length}, finished ${finished}, reuse ${reuseCount}, worst ${minEff}\n`);
    path.push(fmt(e, top.S, r));
    stack.push({ S: r.S, ev: events(r.S), idx: 0 });
  }
  return { n, d, states, finished, windowLeaves, reuseCount, reuses, truncated,
           minEff: finished ? minEff : null, maxEff: finished ? maxEff : null, worstTrace };
}

module.exports = { initState, explore, events, apply, key, h53, withKeys };

if (require.main === module) {
  const n = +process.argv[2] || 8, d = +process.argv[3] || 1, maxStates = +process.argv[4] || 5e6, policy = process.argv[5] || "all";
  const t0 = Date.now();
  const r = explore(n, d, { maxStates, progress: true, policy });
  console.log(JSON.stringify({ n, d, policy, states: r.states, finished: r.finished, reuseExecutions: r.reuseCount, truncated: r.truncated,
    worstEff: r.minEff, bestEff: r.maxEff, secs: (Date.now() - t0) / 1000 }));
  for (const x of r.reuses) { console.log("REUSE trace:"); x.trace.forEach((s, i) => console.log(`  ${i + 1}. ${s}`)); }
}
