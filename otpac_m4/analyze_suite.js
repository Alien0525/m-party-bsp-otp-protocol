"use strict";
// Post-analysis of suite_results.jsonl:
//  1) re-simulates every reuse-halt case with the extended diagnostics
//     (rewound believed-position, empty buffer, late-older deliveries);
//  2) efficiency table per (n,d): halt-on-reuse vs clean runs vs synchronous;
//  3) writes reuse_cases.csv (every reuse case, reproducible in the HTML).
const fs=require("fs");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
if(!isMainThread){
  const S=require("./otpac_test_suite.js");
  parentPort.postMessage(workerData.jobs.map(j=>{ const r=S.simulate(j); r.tier=j.tier; return r; }));
  return;
}
const all=fs.readFileSync("suite_results.jsonl","utf8").trim().split("\n").map(JSON.parse);
const ru=all.filter(r=>r.reuse);
const W=2, chunks=Array.from({length:W},()=>[]); ru.forEach((r,i)=>chunks[i%W].push({tier:r.tier,n:r.n,d:r.d,seed:r.seed,mode:r.mode,sched:r.sched}));
Promise.all(chunks.map(c=>new Promise((res,rej)=>{const w=new Worker(__filename,{workerData:{jobs:c}});w.on("message",res);w.on("error",rej);}))).then(parts=>{
  const re=parts.flat();
  const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
  const same=re.filter(r=>r.reuse).length;
  console.log(`re-simulated ${re.length} reuse cases; still reuse: ${same} (determinism check)`);
  // ---- mechanism by mode
  console.log("\n=== reuse mechanism by delivery mode ===");
  console.log("mode           reuses  rewound  bufEmpty  laterMsgHeard  jump(1st/2nd)  left@halt(d) med/p90/max  freeArea(d) p90/max");
  const byMode=new Map(); for(const r of re){ if(!byMode.has(r.mode)) byMode.set(r.mode,[]); byMode.get(r.mode).push(r); }
  for(const [m,rs] of byMode){
    const rw=rs.filter(r=>r.reuse.rewound).length, be=rs.filter(r=>r.reuse.bufForFirst.length===0).length;
    const lm=rs.filter(r=>r.reuse.reorder).length, j1=rs.filter(r=>r.reuse.firstJump).length, j2=rs.filter(r=>r.reuse.secondJump).length;
    const left=rs.map(r=>r.reuse.remaining/r.d), fa=rs.map(r=>r.reuse.freeRun/r.d);
    console.log(`${m.padEnd(14)} ${String(rs.length).padStart(6)}  ${String(rw).padStart(7)}  ${String(be).padStart(8)}  ${String(lm).padStart(13)}  ${(j1+"/"+j2).padStart(13)}  ${q(left,.5).toFixed(1).padStart(7)}/${q(left,.9).toFixed(1)}/${Math.max(...left).toFixed(1)}   ${q(fa,.9).toFixed(1)}/${Math.max(...fa).toFixed(1)}`);
  }
  const nonRew=re.filter(r=>!r.reuse.rewound);
  console.log(`\nTOTAL rewound: ${re.length-nonRew.length}/${re.length}   NOT rewound: ${nonRew.length}`);
  // ---- non-rewound cases: what are they?
  console.log("\n=== non-rewound reuse cases: breakdown ===");
  const cat=r=> r.reuse.firstJump||r.reuse.secondJump ? "jump-involved" : (r.reuse.bufForFirst.length===0?"walk, empty buffer":"walk, buffer non-empty");
  const byCat=new Map(); for(const r of nonRew){const k=cat(r); if(!byCat.has(k)) byCat.set(k,[]); byCat.get(k).push(r);}
  for(const [k,rs] of byCat) console.log(`${k.padEnd(26)} ${rs.length}   modes: ${[...new Set(rs.map(r=>r.mode))].join(",")}`);
  // examples
  console.log("\nexamples (non-rewound):");
  for(const r of nonRew.slice(0,6)) console.log(`  n=${r.n} d=${r.d} seed=${r.seed} ${r.mode}/${r.sched}: pad ${r.reuse.pad} P${r.reuse.first}${r.reuse.firstJump?"(jump)":""} then P${r.reuse.second}${r.reuse.secondJump?"(jump)":""}; sender believed P${r.reuse.first}@${r.reuse.believedPos} buf[${r.reuse.bufForFirst}] latestRecvPad=${r.reuse.latestRecvPad} left=${r.reuse.remaining}`);
  // ---- efficiency table per (n,d)
  console.log("\n=== efficiency per (n,d): worst case over all modes x schedules x seeds ===");
  console.log("   n    d  runs  reuse%   eff min (halt-on-reuse)   eff min (clean runs)   eff min (synchronous)   1-d/n");
  const key=r=>r.n+","+r.d; const byND=new Map(); for(const r of all){ if(!byND.has(key(r))) byND.set(key(r),[]); byND.get(key(r)).push(r); }
  const rows=[...byND.entries()].sort((a,b)=>{const [n1,d1]=a[0].split(",").map(Number),[n2,d2]=b[0].split(",").map(Number);return n1-n2||d1-d2;});
  for(const [k,rs] of rows){
    const [n,d]=k.split(",").map(Number); const clean=rs.filter(r=>!r.reuse), sync=rs.filter(r=>r.mode==="instant");
    const mn=a=>a.length?Math.min(...a.map(r=>r.eff)).toFixed(4):"  -   ";
    console.log(`${String(n).padStart(5)} ${String(d).padStart(4)} ${String(rs.length).padStart(5)}  ${(100*(rs.length-clean.length)/rs.length).toFixed(1).padStart(5)}%   ${mn(rs).padStart(10)}                ${mn(clean).padStart(10)}            ${mn(sync).padStart(10)}          ${(1-d/n).toFixed(4)}`);
  }
  // ---- CSV of cases
  const hdr="n,d,seed,mode,sched,pad,first,second,firstJump,secondJump,rewound,believedPos,latestRecvPad,bufForFirst,left,eff";
  fs.writeFileSync("reuse_cases.csv",hdr+"\n"+re.map(r=>[r.n,r.d,r.seed,r.mode,r.sched,r.reuse.pad,"P"+r.reuse.first,"P"+r.reuse.second,r.reuse.firstJump,r.reuse.secondJump,r.reuse.rewound,r.reuse.believedPos,r.reuse.latestRecvPad,'"'+r.reuse.bufForFirst.join(" ")+'"',r.reuse.remaining,r.eff.toFixed(4)].join(",")).join("\n")+"\n");
  fs.writeFileSync("reuse_resim.jsonl",re.map(r=>JSON.stringify(r)).join("\n")+"\n");
  console.log("\nwrote reuse_cases.csv");
});
