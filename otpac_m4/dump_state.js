// Replays a visualizer run headlessly (same driver code as app.js) and dumps the
// state that make_fig_state.py draws.
// usage: node dump_state.js [n d mode seq seed steps observer] > paper/figs/state.json
const fs = require("fs"), vm = require("vm"), path = require("path");
const [n = 128, d = 2, mode = "worst", seq = "A30B30", seed = 7, steps = 78, obs = 2] = process.argv.slice(2);
const inputs = { inpN: n, inpD: d, inpMode: mode, inpSeq: seq, inpSeed: seed, inpAfter: "random", inpObs: obs, inpSpeed: 0 };
const el = id => ({ value: inputs[id] !== undefined ? String(inputs[id]) : "", style: {}, innerHTML: "", innerText: "",
  appendChild() {}, classList: { add() {} }, scrollTop: 0, scrollHeight: 0, addEventListener() {}, set disabled(v) {} });
const els = {};
const ctx = { console, Math, Set, Map, JSON, parseInt, String, Array, Object, Number,
  document: { getElementById: id => (els[id] = els[id] || el(id)), createElement: () => el("x"), addEventListener() {} },
  window: { addEventListener() {} }, setTimeout };
vm.createContext(ctx);
const dir = __dirname;
vm.runInContext(fs.readFileSync(path.join(dir, "otpac_m4.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(dir, "app.js"), "utf8").replace(/^\(function \(\) \{[\s\S]*?^\}\)\(\);/m, ""), ctx);
vm.runInContext(`renderAll=function(){}; setButtons=function(){}; showHaltModal=function(){}; log=function(){}; initSystem();
  for (let i = 0; i < ${+steps}; i++) if (!stepOnce()) break;`, ctx);
const out = vm.runInContext(`(function(){
  const v = views.get(${+obs}), res = {}, believed = [];
  for (const [k, ko] of v.others) { if ((ko.buf||[]).length) res[k] = [...ko.buf]; believed.push([k, ko.pos]); }
  return { n: N, d: D, step: steps, used: [...world.used.entries()], pos: world.parties.map(p => [p.pos, p.dir]),
           res, believed, landings, halt: haltInfo };
})()`, ctx);
process.stdout.write(JSON.stringify(out) + "\n");
