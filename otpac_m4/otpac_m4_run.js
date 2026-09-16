"use strict";
const E = require("./otpac_m4.js");

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

// Build the initial per-party views from the true world.
function initViews(w) {
  const views = new Map();
  for (const me of w.parties) {
    const others = new Map();
    for (const k of w.parties) if (k.id !== me.id)
      others.set(k.id, { pos: k.pos, dir: k.dir, buf: [] });
    const v = { self: { pos: me.pos, dir: me.dir }, others, used: new Set() };
    for (const k of w.parties) if (k.id !== me.id) E.refreshBuffer(v, k.id, w.n, w.d, w.nodes);
    views.set(me.id, v);
  }
  return views;
}

// One run. pick(w,step,rng) -> party id to Send next, or null to stop.
function run(n, d, mode, seed, pick, maxSteps) {
  const w = E.initWorld(n, d, 4);
  const rng = mulberry32(seed);
  const views = initViews(w);
  const inflight = [];                 // {to, from, pad, dir, gseq}
  let gclock = 0;                      // global send counter (event order)
  let reuse = null, badWrite = null, diverge = null, steps = 0, maxUndel = 0;

  const P = id => w.parties.find(p => p.id === id);

  // Continuously enforce the family U_d: after EVERY send, no recipient may
  // have more than d messages addressed to it still undelivered. We cap each
  // recipient's queue by force-delivering the oldest until <= d remain. This
  // holds the invariant at all times (in particular at every recipient's own
  // send), so no observer's view of any party can be more than d sends stale.
  function capQueues() {
    for (const r of w.parties) {
      let mine = inflight.filter(m => m.to === r.id).sort((a,b) => a.gseq - b.gseq);
      const excess = mine.length - d;
      if (excess <= 0) continue;
      const del = new Set();
      for (let i = 0; i < excess; i++) { applyReceive(r.id, mine[i]); del.add(mine[i]); }
      const keep = inflight.filter(m => !del.has(m));
      inflight.length = 0; inflight.push(...keep);
    }
  }

  // Opportunistic early delivery to rid before it sends (random/adversarial
  // jitter). The hard <= d cap is maintained separately by capQueues().
  function deliverBefore(rid) {
    if (mode === "worst") return;                 // deliver as late as legal
    let mine = inflight.filter(m => m.to === rid);
    const del = new Set();
    for (const m of mine) {
      const pEarly = mode === "random" ? 0.5 : 0.10;
      if (rng() < pEarly) { applyReceive(rid, m); del.add(m); }
    }
    if (del.size) { const keep = inflight.filter(m => !del.has(m)); inflight.length = 0; inflight.push(...keep); }
  }

  function applyReceive(rid, msg) {
    const v = views.get(rid), o = v.others.get(msg.from);
    if (!o) return;
    // confirmed: move observer's belief of `from` up to the delivered pad,
    // adopting the direction implied if it was a jump-landing.
    o.pos = msg.pad; o.dir = msg.dir;
    v.used.add(msg.pad);
    E.refreshBuffer(v, msg.from, n, d, w.nodes);
  }

  while (steps < maxSteps) {
    const who = pick(w, steps, rng);
    if (who === null) break;
    const me = P(who);
    if (me.halted) { if (w.parties.every(p => p.halted)) break; steps++; continue; }
    deliverBefore(who);                 // hear what we must before sending
    const v = views.get(who);
    v.self.pos = me.pos; v.self.dir = me.dir;

    const nx = E.nextSlot(me.pos, me.dir, v, n, d, w.nodes);
    steps++;
    if (!nx) { me.halted = true; if (w.parties.every(p => p.halted)) break; continue; }

    // assertion: we must not be about to write a pad reserved (in our own view)
    // for another party.
    const { reservedBy } = E.buildBlocked(v, n);
    if (reservedBy.has(nx.pad)) { badWrite = { who, pad: nx.pad, resFor: reservedBy.get(nx.pad), step: steps }; break; }

    // commit the send in ground truth
    me.pos = nx.pad; if (nx.jumped) me.dir = nx.face; me.sent++; me.started = true;

    if (w.used.has(nx.pad)) { reuse = { pad: nx.pad, first: w.used.get(nx.pad), second: who, step: steps }; break; }
    w.used.set(nx.pad, who); gclock++;
    views.get(who).used.add(nx.pad);

    // broadcast to the other three
    for (const k of w.parties) if (k.id !== who)
      inflight.push({ to: k.id, from: who, pad: nx.pad, dir: me.dir, gseq: gclock });
    capQueues();
    for (const r of w.parties) { const c = inflight.filter(m=>m.to===r.id).length; if (c>maxUndel) maxUndel=c; }

    // divergence check: any two observers' belief of the same party > d apart?
    for (const target of w.parties) {
      const beliefs = [];
      for (const obs of w.parties) if (obs.id !== target.id) {
        const o = views.get(obs.id).others.get(target.id); if (o) beliefs.push(o.pos);
      }
      if (beliefs.length) {
        const spread = Math.max(...beliefs) - Math.min(...beliefs);
        if (spread > d) { diverge = { target: target.id, spread, step: steps }; }
      }
    }
  }
  // flush
  for (const msg of inflight) { const r = P(msg.to); if (r && !r.halted) applyReceive(msg.to, msg); }

  return { n, d, mode, seed, used: w.used.size, ratio: w.used.size / n,
           reuse, badWrite, diverge, maxUndel, positions: w.parties.map(p => `${p.id}@${p.pos}${p.dir>0?">":"<"}`) };
}

// pickers
function floodOne(w) { const p = w.parties.find(p => !p.halted); return p ? p.id : null; }
function floodThenTwo(w, step) {          // party 0 floods a while, then party 1
  const a = w.parties.find(p=>p.id===0), b = w.parties.find(p=>p.id===1);
  if (a && !a.halted && a.sent < 400) return 0;
  if (b && !b.halted) return 1;
  const any = w.parties.find(p=>!p.halted); return any?any.id:null;
}
function roundRobin(w, step) { const live = w.parties.filter(p=>!p.halted); return live.length? live[step%live.length].id : null; }
function randomPick(w, step, rng) { const live=w.parties.filter(p=>!p.halted); return live.length? live[Math.floor(rng()*live.length)].id : null; }

if (require.main === module) {
  console.log("=== SANITY: n=1000 d=5, party0 floods then party1 follows (worst-case delay) ===");
  const r = run(1000, 5, "worst", 1, floodThenTwo, 100000);
  console.log("used:", r.used, "ratio:", r.ratio.toFixed(4));
  console.log("final positions:", r.positions.join("  "));
  console.log("reuse:", r.reuse, "| badWrite:", r.badWrite, "| maxUndelivered:", r.maxUndel, "(must be <= d)");

  console.log("\n=== SWEEP ===");
  const Ns=[512,1024,4096], Ds=[1,2,5], modes=["worst","random","adversarial"];
  const picks={flood:floodOne, floodThenTwo, roundRobin, random:randomPick};
  let anyReuse=false, anyBad=false, anyDiv=false, rows=0;
  console.log(["pick","mode","n","d","worstRatio","reuse","badWrite","diverge"].join("\t"));
  for (const [pn,pf] of Object.entries(picks))
    for (const mode of modes)
      for (const n of Ns) for (const d of Ds) {
        let wr=1, ru=false, bw=false, dv=false;
        for (let s=0;s<6;s++){ const r=run(n,d,mode,s*97+3,pf,n*60);
          wr=Math.min(wr,r.ratio); if(r.reuse){ru=true;anyReuse=true;} if(r.badWrite){bw=true;anyBad=true;} if(r.diverge){dv=true;anyDiv=true;} }
        rows++;
        console.log([pn,mode,n,d,wr.toFixed(4),ru,bw,dv].join("\t"));
      }
  console.log(`\nSummary: ${rows} configs | any reuse=${anyReuse} | any badWrite=${anyBad} | any diverge>d=${anyDiv}`);
}
