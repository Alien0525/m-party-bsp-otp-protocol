"use strict";
// ===========================================================================
// Schedule family (3): run schedule (2) (party x sends with probability p_x) until
//   (3a) utilisation is close to 100%: at least 85% of the pads are used, or
//   (3b) two parties are close: some party has another party ahead of it in its
//        direction at distance <= 2d+2,
// then, from that exact global state (positions, every party's view, messages in
// flight), explore ALL continuations exhaustively with verify_exhaustive.js:
//   - every send order AND every delivery order for the next WIN_ALL sends, and
//   - every send order under the fixed adversaries worst / lifo for the next
//     WIN_POL sends (both with a state budget; coverage is reported).
//
// usage: node verify_hybrid.js [workers] [configs] [budget]
//   configs "64:1,128:2" (n:d), budget = max states for the every-delivery-order search
// output: ver/hybrid_results_<configs>.jsonl + summary
// ===========================================================================
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const path = require("path");

function closeParties(w, d) {
  for (const p of w.parties) {
    if (p.halted) continue;
    for (const q of w.parties) { if (q === p) continue; const s = (q.pos - p.pos) * p.dir; if (s > 0 && s <= 2 * d + 2) return true; }
  }
  return false;
}

if (!isMainThread) {
  const S = require(path.join(__dirname, "otpac_test_suite.js"));
  const X = require(path.join(__dirname, "verify_exhaustive.js"));
  const E = require(path.join(__dirname, "otpac_m4.js"));
  const out = [];
  for (const j of workerData.jobs) {
    const sw = j.trigger === "3a" ? (({ w, n }) => w.used.size >= 0.85 * n) : (({ w, d }) => closeParties(w, d));
    const pre = S.simulate({ ...j, switchWhen: sw });
    const rec = { n: j.n, d: j.d, seed: j.seed, mode: j.mode, p: j.p, trigger: j.trigger };
    if (!pre.switched) { rec.switched = false; rec.prefixReuse = !!pre.reuse; rec.eff = pre.eff; out.push(rec); continue; }
    rec.switched = true; rec.atStep = pre.steps; rec.usedAtSwitch = pre.snapshot.used.size;
    for (const pol of ["all", "worst", "lifo"]) {
      const snap = structuredClone(pre.snapshot);
      for (const v of snap.views) for (const [, o] of v.others) { o.assumed = undefined; o.assumedLog = undefined; }
      const start = { n: j.n, d: j.d, nodes: E.bspNodes(j.n), parties: snap.parties, used: snap.used, views: snap.views, inflight: snap.inflight, policy: pol };
      const r = X.explore(j.n, j.d, { start, policy: pol, maxStates: pol === "all" ? j.budget : 4 * j.budget, maxReuse: 1,
                                       maxSends: pol === "all" ? j.winAll : j.winPol });
      rec[pol] = { states: r.states, complete: !r.truncated, reuse: r.reuseCount, worstEff: r.minEff, bestEff: r.maxEff,
                   trace: r.reuses.length ? r.reuses[0].trace.slice(-12) : undefined };
    }
    out.push(rec);
  }
  parentPort.postMessage(out);
} else if (require.main === module) {
  const fs = require("fs");
  const { vectors } = require("./verify_prob.js");
  const W = +process.argv[2] || 2;
  const cfgs = (process.argv[3] || "64:1,128:2").split(",").map(x => x.split(":").map(Number));
  const budget = +process.argv[4] || 20000;
  const prefixModes = (process.env.PREFIX_MODES || "random,worst").split(",");
  const step = +(process.env.GRID || 10);       // 10 -> steps of 0.1 (286 vectors); 5 -> steps of 0.2 (56 vectors)
  const V = vectors().filter(p => p.every(x => Math.round(x * 10) % (10 / step) === 0) && p.filter(x => x > 0).length >= 2);
  const winAll = +(process.env.WIN_ALL || 4), winPol = +(process.env.WIN_POL || 8);
  const jobs = [];
  for (const [n, d] of cfgs) for (const p of V) for (const mode of prefixModes) for (const trigger of ["3a", "3b"])
    jobs.push({ n, d, seed: 9000, mode, sched: "prob", p, trigger, budget, winAll, winPol });
  console.error(`${V.length} vectors, ${jobs.length} hybrid runs on ${W} workers (budget ${budget} states for every-delivery-order search)`);
  const ch = Array.from({ length: W }, () => []); jobs.forEach((j, i) => ch[i % W].push(j));
  const t0 = Date.now();
  Promise.all(ch.map(c => new Promise((res, rej) => { const w = new Worker(__filename, { workerData: { jobs: c } }); w.on("message", res); w.on("error", rej); })))
    .then(parts => {
      const R = parts.flat();
      fs.mkdirSync("ver", { recursive: true });
      fs.writeFileSync(`ver/hybrid_results_${cfgs.map(c => c.join("_")).join("-")}.jsonl`, R.map(r => JSON.stringify(r)).join("\n") + "\n");
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      for (const trig of ["3a", "3b"]) for (const [n, d] of cfgs) {
        const rs = R.filter(r => r.trigger === trig && r.n === n && r.d === d), sw = rs.filter(r => r.switched);
        const line = [`${trig} n=${n} d=${d}: ${rs.length} prefixes, ${sw.length} reached the switch point`];
        for (const pol of ["all", "worst", "lifo"]) {
          const xs = sw.map(r => r[pol]);
          line.push(`${pol}: ${xs.reduce((s, x) => s + x.states, 0)} states, ${xs.filter(x => x.complete).length}/${xs.length} complete, ` +
                    `${xs.filter(x => x.reuse).length} with reuse`);
        }
        console.log(line.join("\n   "));
      }
      const ex = R.find(r => r.switched && ["all", "worst", "lifo"].some(p => r[p].reuse));
      if (ex) { const pol = ["all", "worst", "lifo"].find(q => ex[q].reuse); console.log("example reuse:", JSON.stringify({ ...ex, all: undefined, worst: undefined, lifo: undefined }), pol); ex[pol].trace.forEach(t => console.log("   " + t)); }
    });
}
