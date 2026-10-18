"use strict";
// ===========================================================================
// Schedule family (2): at each step party x sends with probability p_x, where
// (p_1,..,p_4) ranges over all vectors with entries in {0, 0.1, ..., 1} that sum
// to 1 (286 vectors). If the chosen party has halted, the probabilities are
// renormalised over the parties still running (parties with p_x = 0 never send).
// Every vector is run under every delivery adversary of the test suite, for
// several (n, d) and seeds. A run that would reuse a pad halts there.
//
// usage: node verify_prob.js [workers] [configs]    configs like "32:1:3,256:2:3"  (n:d:seeds)
// output: ver/prob_results.jsonl + summary on stdout
// ===========================================================================
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const path = require("path");

function vectors() {
  const out = [];
  for (let a = 0; a <= 10; a++) for (let b = 0; a + b <= 10; b++) for (let c = 0; a + b + c <= 10; c++)
    out.push([a, b, c, 10 - a - b - c].map(x => x / 10));
  return out;
}

if (!isMainThread) {
  const S = require(path.join(__dirname, "otpac_test_suite.js"));
  const res = workerData.jobs.map(j => {
    const r = S.simulate(j);
    return { n: j.n, d: j.d, seed: j.seed, mode: j.mode, p: j.p, eff: r.eff, used: r.used, reuse: r.reuse ? { pad: r.reuse.pad, first: r.reuse.first, second: r.reuse.second, step: r.reuse.step } : null, jumps: r.jumps, invViol: r.invViol };
  });
  parentPort.postMessage(res);
} else if (require.main === module) {
  const fs = require("fs");
  const S = require("./otpac_test_suite.js");
  const W = +process.argv[2] || 2;
  const cfgs = (process.argv[3] || "32:1:3,64:2:3,128:2:3,256:2:3,256:8:2,1024:2:1").split(",").map(x => x.split(":").map(Number));
  const V = vectors();
  const jobs = [];
  for (const [n, d, seeds] of cfgs) for (const p of V) for (const mode of S.MODES) for (let s = 0; s < seeds; s++)
    jobs.push({ n, d, seed: 7000 + s, mode, sched: "prob", p });
  console.error(`${V.length} probability vectors, ${jobs.length} runs on ${W} workers`);
  const ch = Array.from({ length: W }, () => []); jobs.forEach((j, i) => ch[i % W].push(j));
  const t0 = Date.now();
  Promise.all(ch.map(c => new Promise((res, rej) => { const w = new Worker(__filename, { workerData: { jobs: c } }); w.on("message", res); w.on("error", rej); })))
    .then(parts => {
      const R = parts.flat();
      fs.mkdirSync("ver", { recursive: true });
      fs.writeFileSync("ver/prob_results.jsonl", R.map(r => JSON.stringify(r)).join("\n") + "\n");
      const by = {}; for (const r of R) (by[r.n + "," + r.d] = by[r.n + "," + r.d] || []).push(r);
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      console.log("n,d        runs   reuse   eff min / mean   bound violations");
      for (const k of Object.keys(by)) {
        const rs = by[k], ru = rs.filter(r => r.reuse);
        const eff = rs.map(r => r.eff);
        console.log(`${k.padEnd(9)} ${String(rs.length).padStart(6)} ${String(ru.length).padStart(6)}   ${Math.min(...eff).toFixed(3)} / ${(eff.reduce((a, b) => a + b, 0) / eff.length).toFixed(3)}   ${rs.reduce((c, r) => c + r.invViol, 0)}`);
      }
      const ru = R.filter(r => r.reuse);
      console.log(`TOTAL ${R.length} runs, ${ru.length} with a would-be reuse (${(100 * ru.length / R.length).toFixed(2)}%)`);
      const byMode = {}; for (const r of ru) byMode[r.mode] = (byMode[r.mode] || 0) + 1;
      console.log("reuse by delivery mode:", JSON.stringify(byMode));
      for (const r of ru.slice(0, 5)) console.log("  example:", JSON.stringify(r));
    });
}
module.exports = { vectors };
