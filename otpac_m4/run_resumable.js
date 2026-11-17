// Resumable suite runner: appends each result as it finishes, skips runs already in the output file.
// usage: node run_resumable.js <tier> <outFile> [workers]
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const path = require("path");
const S = require(path.join(__dirname, "otpac_test_suite.js"));
if (!isMainThread) {
  parentPort.on("message", j => { if (j === null) process.exit(0); const r = S.simulate(j); r.tier = j.tier; parentPort.postMessage(r); });
} else {
  const fs = require("fs");
  const [tier, outFile, Wa] = process.argv.slice(2);
  const key = r => [r.tier, r.n, r.d, r.seed, r.mode, r.sched].concat(r.tier==="M"||r.tier==="X"?[r.m,r.parties]:[]).join("|");
  const done = new Set();
  if (fs.existsSync(outFile)) for (const l of fs.readFileSync(outFile, "utf8").split("\n")) if (l.trim()) done.add(key(JSON.parse(l)));
  // run slow (large n) jobs first so the tail is short
  const jobs = S.buildJobs(tier==="all"?undefined:tier).filter(j => !done.has(key(j))).sort((a, b) => b.n - a.n);
  const W = +(Wa || 2);
  console.error(`${done.size} already done, ${jobs.length} to run on ${W} workers`);
  let next = 0, fin = 0; const t0 = Date.now();
  if (!jobs.length) process.exit(0);
  for (let w = 0; w < W; w++) {
    const wk = new Worker(__filename);
    const feed = () => wk.postMessage(next < jobs.length ? jobs[next++] : null);
    wk.on("message", r => { fs.appendFileSync(outFile, JSON.stringify(r) + "\n"); fin++;
      if (fin % 500 === 0) console.error(`${fin}/${jobs.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`); feed(); });
    feed();
  }
}
