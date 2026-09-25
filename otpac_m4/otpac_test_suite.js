"use strict";
// ===========================================================================
// OTPAC m=4 -- extended test suite (buffer-based, individual-jump engine).
//
// Uses the engine in ./otpac_m4.js. Adds:
//   * 9 delivery adversaries (all keep <= d undelivered per recipient, i.e. the
//     run stays inside the paper's family U^{4,n}_{A,d}):
//       instant, worst, random, adversarial   (first 3 = legacy, reproducible)
//       lifo, randcap, shuffle, target-sender, target-recv
//   * 12 sender schedules:
//       random, rr, flood, flood-rev, skew, arena-skew, burst, silent1,
//       silent2, pair-alt, greedy-gap, stale-max
//   * a grid of pad sizes n (incl. tiny, odd, non-power-of-2) and buffer sizes d
//     (incl. d=1 and the boundary d = floor(n/4)-1).
//
// HALT-ON-REUSE: if a party is about to use a pad that was already used, the
// whole protocol HALTS before that send is committed. Every pad not yet used is
// counted as WASTED, and efficiency = used / n. No pad is ever used twice.
//
// Each halt is diagnosed: remaining pads, width of the free area around the
// contested pad (in units of d), whether the sender had already received a LATER
// message from the first user (= out-of-order delivery), and walk/jump types.
//
// Usage:
//   node otpac_test_suite.js                 # full suite (tiers A,B,C,D), ~18 min on 2 cores
//   node otpac_test_suite.js A               # just one tier
//   node otpac_test_suite.js legacy          # parity check vs earlier sweep (n=256,d=2)
//   node analyze_suite.js                    # after a full run: mechanisms + efficiency table
// Results: suite_results.jsonl (one record per run) + printed summary.
//
// Messages carry the sender's message number (Rule 8 in otpac_m4.js).
//   LEGACY_RECEIVE=1 node otpac_test_suite.js
//       reproduces the OLD receive behaviour (no message number; the believed
//       position always moves to the pad of whichever message arrived last),
//       for before/after comparison. Output: suite_results_legacyreceive.jsonl
//   SKIP_JUMP_POLICY=guided|none node otpac_test_suite.js
//       alternative policies for Rule 8(b) case (iii), an unforeseen jump among the
//       skipped messages (default "both"; see assumeSkipped in otpac_m4.js).
// ===========================================================================
const E = require("./otpac_m4.js");

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

const LEGACY_RECEIVE = (process.env.LEGACY_RECEIVE==="1");       // reproduce pre-Rule-8 behaviour (for comparison only)
const SKIP_JUMP_POLICY = process.env.SKIP_JUMP_POLICY || "both";   // Rule 8(b) case (iii): both | guided | none
E.setSkipJumpPolicy(SKIP_JUMP_POLICY);
const MODES = ["instant","worst","random","adversarial","lifo","randcap","shuffle","target-sender","target-recv"];
const SCHEDS = ["random","rr","flood","flood-rev","skew","arena-skew","burst","silent1","silent2","pair-alt","greedy-gap","stale-max"];

// ---------------------------------------------------------------------------
function simulate(cfg){
  const {n,d,seed,mode,sched} = cfg;
  const maxSteps = cfg.maxSteps || (4*n+50);          // steps <= n+4 always; exceeding = liveness bug
  const w = E.initWorld(n,d,4);
  const rng = mulberry32(seed);                          // main stream (legacy-compatible)
  const aux = mulberry32(((seed*2654435761)>>>0) ^ 0x5bd1e995); // seeded choices for new modes/schedules
  const ids = w.parties.map(p=>p.id);
  const P = id => w.parties.find(p=>p.id===id);

  // seeded roles
  const targetParty = ids[Math.floor(aux()*4)];         // target-sender / target-recv
  const fav = ids[Math.floor(aux()*4)];                  // skew
  const favArena = Math.floor(aux()*2);                  // arena-skew
  const sil1 = ids[Math.floor(aux()*4)];
  const sil2 = ids[(ids.indexOf(sil1) + 1 + Math.floor(aux()*3)) % 4];   // always different from sil1
  const silent = new Set(sched==="silent1"?[sil1]:sched==="silent2"?[sil1,sil2]:[]);
  const firstPair = Math.floor(aux()*2);

  // views
  const views = new Map();
  for(const me of w.parties){
    const others=new Map();
    for(const k of w.parties) if(k.id!==me.id) others.set(k.id,{pos:k.pos,dir:k.dir,buf:[]});
    const v={self:{pos:me.pos,dir:me.dir},others,used:new Set()};
    for(const k of w.parties) if(k.id!==me.id) E.refreshBuffer(v,k.id,n,d,w.nodes);
    views.set(me.id,v);
  }

  const inflight = [];                                   // {to,from,pad,dir,gseq}
  let g = 0;
  const sentCount = {0:0,1:0,2:0,3:0};
  const maxRecv = {};                                    // maxRecv[obs][sender] = highest gseq received
  const maxRecvPad = {};                                 // pad of that highest-gseq message
  for(const o of ids){ maxRecv[o]={}; maxRecvPad[o]={}; for(const k of ids) if(k!==o){ maxRecv[o][k]=0; maxRecvPad[o][k]=null; } }
  const padInfo = new Map();                             // pad -> {by, gseq, jumped}
  let lateOlder = 0;                                     // # deliveries of an OLDER msg after a newer one (same sender)

  function applyRecv(rid,m){
    const v=views.get(rid); if(!v.others.get(m.from)) return;
    // Rule 8: pass the sender's message number (m.sseq). With LEGACY_RECEIVE=1 the
    // number is withheld, reproducing the old behaviour (position always moves to
    // the pad of whichever message arrived last).
    E.deliverBuffer(v,m.from,m.pad,m.dir,n,d,w.nodes, LEGACY_RECEIVE?undefined:m.sseq);
    if(m.gseq>maxRecv[rid][m.from]){ maxRecv[rid][m.from]=m.gseq; maxRecvPad[rid][m.from]=m.pad; }
    else lateOlder++;
  }
  function removeSet(del){ if(!del.size) return; const keep=inflight.filter(m=>!del.has(m)); inflight.length=0; inflight.push(...keep); }

  // early deliveries to rid right before rid sends
  function deliverBefore(rid){
    if(mode==="random"||mode==="adversarial"){
      const pe = mode==="random"?0.5:0.1; const del=new Set();
      for(const m of inflight.filter(m=>m.to===rid)){ if(rng()<pe){applyRecv(rid,m);del.add(m);} }
      removeSet(del);
    } else if(mode==="shuffle"){
      const mine = inflight.filter(m=>m.to===rid);
      for(let i=mine.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[mine[i],mine[j]]=[mine[j],mine[i]];}
      const del=new Set(); for(const m of mine){ if(rng()<0.3){applyRecv(rid,m);del.add(m);} }
      removeSet(del);
    }
  }
  // deliveries right after a send (instant / targeted modes)
  function deliverAfterSend(){
    if(mode==="instant"){ const all=inflight.slice(); for(const m of all) applyRecv(m.to,m); inflight.length=0; return; }
    if(mode==="target-sender"){ const del=new Set(); for(const m of inflight) if(m.from!==targetParty){applyRecv(m.to,m);del.add(m);} removeSet(del); return; }
    if(mode==="target-recv"){ const del=new Set(); for(const m of inflight) if(m.to!==targetParty){applyRecv(m.to,m);del.add(m);} removeSet(del); return; }
  }
  // enforce <= d undelivered per recipient; which message is released depends on mode
  const capPolicy = (mode==="lifo"||mode==="target-sender"||mode==="target-recv") ? "newest"
                  : (mode==="randcap"||mode==="shuffle") ? "random" : "oldest";
  function capQueues(){
    for(const r of w.parties){
      let mine = inflight.filter(m=>m.to===r.id);
      let ex = mine.length - d; if(ex<=0) continue;
      const del = new Set();
      if(capPolicy==="oldest"){ mine.sort((a,b)=>a.gseq-b.gseq); for(let i=0;i<ex;i++){applyRecv(r.id,mine[i]);del.add(mine[i]);} }
      else if(capPolicy==="newest"){ mine.sort((a,b)=>b.gseq-a.gseq); for(let i=0;i<ex;i++){applyRecv(r.id,mine[i]);del.add(mine[i]);} }
      else { while(ex>0){ const cand=mine.filter(m=>!del.has(m)); const m=cand[Math.floor(rng()*cand.length)]; applyRecv(r.id,m); del.add(m); ex--; } }
      removeSet(del);
    }
  }

  // ---- sender schedules
  let burstParty=null, burstLeft=0, pairTurn=0;
  function pick(steps){
    const live = w.parties.filter(p=>!p.halted && !silent.has(p.id));
    if(!live.length) return null;
    const uni = () => live[Math.floor(rng()*live.length)];
    switch(sched){
      case "random": return uni();
      case "rr": return live[steps%live.length];
      case "flood": return live[0];
      case "flood-rev": return live[live.length-1];
      case "skew": { const f=live.find(p=>p.id===fav); return (f && rng()<0.7) ? f : uni(); }
      case "arena-skew": {
        const inA = live.filter(p=>Math.floor(p.id/2)===favArena), out = live.filter(p=>Math.floor(p.id/2)!==favArena);
        if(inA.length && (rng()<0.8 || !out.length)) return inA[Math.floor(rng()*inA.length)];
        return out.length ? out[Math.floor(rng()*out.length)] : uni(); }
      case "burst": {
        if(burstParty && !burstParty.halted && burstLeft>0){ burstLeft--; return burstParty; }
        burstParty = uni(); burstLeft = Math.floor(rng()*3*d); return burstParty; }
      case "silent1": case "silent2": return uni();
      case "pair-alt": {
        const pairs = firstPair===0 ? [[0,1],[2,3]] : [[2,3],[0,1]];
        for(const pr of pairs){
          const lp = pr.map(P).filter(p=>!p.halted && !silent.has(p.id));
          if(lp.length){ pairTurn++; return lp[pairTurn%lp.length]; }
        }
        return uni(); }
      case "greedy-gap": {       // party with the smallest true gap to anyone ahead of it
        let best=[], bestGap=Infinity;
        for(const p of live){
          let gap = p.dir>0 ? (n - p.pos) : (p.pos - 1);
          for(const q of w.parties){ if(q===p) continue; const s=(q.pos-p.pos)*p.dir; if(s>0 && s<gap) gap=s; }
          if(gap<bestGap){bestGap=gap;best=[p];} else if(gap===bestGap) best.push(p);
        }
        return best[Math.floor(rng()*best.length)]; }
      case "stale-max": {        // party with the most of its own messages still undelivered
        const cnt={}; for(const p of live) cnt[p.id]=0;
        for(const m of inflight) if(cnt[m.from]!==undefined) cnt[m.from]++;
        let mx=-1, best=[]; for(const p of live){ if(cnt[p.id]>mx){mx=cnt[p.id];best=[p];} else if(cnt[p.id]===mx) best.push(p); }
        return best[Math.floor(rng()*best.length)]; }
      default: throw new Error("unknown sched "+sched);
    }
  }

  let steps=0, reuse=null, badWrite=0, invViol=0, maxPending=0;
  while(steps<maxSteps){
    const me = pick(steps);
    if(!me) break;
    deliverBefore(me.id);
    // paper's undelivery at this Send: messages addressed to me still in flight
    const pend = inflight.reduce((c,m)=>c+(m.to===me.id?1:0),0);
    if(pend>maxPending) maxPending=pend;
    if(pend>d) invViol++;
    const v = views.get(me.id); v.self.pos=me.pos; v.self.dir=me.dir;
    const nx = E.nextSlot(me.pos,me.dir,v,n,d,w.nodes);
    steps++;
    if(!nx){ me.halted=true; continue; }
    if(E.buildBlocked(v,n).reservedBy.has(nx.pad)) badWrite++;
    if(w.used.has(nx.pad)){                                   // would-be REUSE -> halt the protocol
      const info = padInfo.get(nx.pad);
      let l=0,r=0; for(let q=nx.pad-1;q>=1&&!w.used.has(q);q--) l++; for(let q=nx.pad+1;q<=n&&!w.used.has(q);q++) r++;
      const pendingFromFirst = inflight.filter(m=>m.to===me.id && m.from===info.by).length;
      reuse = { pad:nx.pad, first:info.by, second:me.id, firstJump:info.jumped, secondJump:nx.jumped,
                remaining:n-w.used.size, freeRun:l+r,
                undeliveredToSender: inflight.some(m=>m.to===me.id && m.from===info.by && m.pad===nx.pad),
                reorder: maxRecv[me.id][info.by] > info.gseq,     // sender already heard a LATER msg of first user
                // sender's believed position of the first user was REWOUND by a late older message
                rewound: maxRecvPad[me.id][info.by]!==null && v.others.get(info.by).pos!==maxRecvPad[me.id][info.by],
                believedPos: v.others.get(info.by).pos, latestRecvPad: maxRecvPad[me.id][info.by],
                bufForFirst: v.others.get(info.by).buf.slice(),
                pendingFromFirst, step:steps };
      break;
    }
    // commit
    me.pos=nx.pad; if(nx.jumped) me.dir=nx.face; me.sent++; sentCount[me.id]++;
    g++; w.used.set(nx.pad,me.id); v.used.add(nx.pad); padInfo.set(nx.pad,{by:me.id,gseq:g,jumped:nx.jumped});
    for(const k of w.parties) if(k.id!==me.id) inflight.push({to:k.id,from:me.id,pad:nx.pad,dir:me.dir,gseq:g,sseq:me.sent});
    deliverAfterSend();
    capQueues();
  }
  // Rule 8(b) statistics: marks made per case, and how many were right (the party really used that pad)
  const assume={predicted:{marks:0,right:0},straight:{marks:0,right:0},jump:{marks:0,right:0}};
  for(const [,v] of views) for(const [K,o] of v.others){ if(!o.assumedLog) continue;
    for(const e of o.assumedLog){ const st=assume[e.kase]; st.marks++; if(w.used.get(e.pad)===K) st.right++; } }
  const used = w.used.size;
  return { assume, n,d,seed,mode,sched, used, eff:used/n, wasted:n-used, steps, timeout:steps>=maxSteps,
           reuse, badWrite, invViol, maxPending, lateOlder };
}

// ---------------------------------------------------------------------------
// test grid
function dList(n, cands){ const dmax=Math.floor(n/4)-1; return [...new Set(cands.filter(x=>x>=1&&x<=dmax).concat(dmax>=1?[dmax]:[]))].sort((a,b)=>a-b); }
function buildJobs(tier){
  const jobs=[];
  const all = (n,d,seeds,modes,scheds,t) => { for(const mode of modes) for(const sched of scheds) for(const seed of seeds) jobs.push({tier:t,n,d,seed,mode,sched}); };
  const range = (a,b) => { const r=[]; for(let i=a;i<=b;i++) r.push(i); return r; };
  if(tier==="legacy"){ for(const mode of ["worst","random","adversarial"]) for(let s=0;s<=300;s++) jobs.push({tier:"legacy",n:256,d:2,seed:s,mode,sched:"random"}); return jobs; }
  if(!tier||tier==="A"){ all(256,2,range(0,99),MODES,SCHEDS,"A"); }                           // deep: canonical config
  if(!tier||tier==="B"){                                                                        // breadth: many n, d
    for(const n of [16,20,32,50,64,100,128,200,257,333,512])
      for(const d of dList(n,[1,2,3,5,8,16])) all(n,d,[1000,1001,1002],MODES,SCHEDS,"B");
  }
  if(!tier||tier==="C"){                                                                        // scale: large n
    for(const n of [1000,1024,2048]) for(const d of [2,8])
      all(n,d,[2000,2001],MODES,["random","flood","greedy-gap","burst","stale-max"],"C");
  }
  if(!tier||tier==="D"){                                                                        // d near the boundary, many seeds
    for(const n of [64,128,256]) for(const d of [Math.floor(n/8), Math.floor(n/4)-2, Math.floor(n/4)-1])
      all(n,d,range(3000,3009),MODES,["random","greedy-gap","burst","stale-max"],"D");
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// parallel runner (worker_threads)
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
if(!isMainThread){
  const out=[]; for(const j of workerData.jobs){ const r=simulate(j); r.tier=j.tier; out.push(r); }
  parentPort.postMessage(out);
} else if(require.main===module){
  const fs=require("fs"), os=require("os");
  const tier=process.argv[2];
  const jobs=buildJobs(tier);
  const W=Math.max(1,Math.min(os.cpus().length, 8));
  // interleave jobs so each worker gets a similar mix of fast/slow runs
  const chunks=Array.from({length:W},()=>[]); jobs.forEach((j,i)=>chunks[i%W].push(j));
  const t0=Date.now();
  console.error(`running ${jobs.length} runs on ${W} workers...`);
  Promise.all(chunks.map(c=>new Promise((res,rej)=>{ const wk=new Worker(__filename,{workerData:{jobs:c}}); wk.on("message",res); wk.on("error",rej); })))
  .then(parts=>{
    const res=parts.flat();
    const outFile = (tier ? `suite_results_${tier}` : "suite_results") + (LEGACY_RECEIVE ? "_legacyreceive" : "") + (SKIP_JUMP_POLICY!=="both" ? "_skip"+SKIP_JUMP_POLICY : "") + ".jsonl";
    fs.writeFileSync(outFile, res.map(r=>JSON.stringify(r)).join("\n")+"\n");
    console.error(`done in ${((Date.now()-t0)/1000).toFixed(1)}s -> ${outFile}`);
    summarize(res);
  });
}

// ---------------------------------------------------------------------------
function summarize(res){
  const pct=(a,b)=>b?(100*a/b).toFixed(2)+"%":"-";
  const f4=x=>x.toFixed(4);
  const group=(key)=>{ const m=new Map(); for(const r of res){ const k=key(r); if(!m.has(k)) m.set(k,[]); m.get(k).push(r);} return m; };
  const row=(label,rs)=>{
    const ru=rs.filter(r=>r.reuse), clean=rs.filter(r=>!r.reuse);
    const effAll=rs.map(r=>r.eff), effClean=clean.map(r=>r.eff);
    const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
    return `${label.padEnd(26)} runs=${String(rs.length).padStart(6)}  reuse-halts=${String(ru.length).padStart(4)} (${pct(ru.length,rs.length).padStart(6)})  `+
           `eff[min ${f4(Math.min(...effAll))} mean ${f4(mean(effAll))}]  clean-only min ${effClean.length?f4(Math.min(...effClean)):"  -   "}`;
  };
  console.log("\n================ OVERALL ================");
  console.log(row("all runs",res));
  console.log(`invariant (<= d undelivered at every Send) violations: ${res.reduce((s,r)=>s+r.invViol,0)}  | max undelivered seen vs d: ${res.every(r=>r.maxPending<=r.d)?"always <= d":"EXCEEDED"}`);
  if(res[0] && res[0].assume){
    const A={predicted:{marks:0,right:0},straight:{marks:0,right:0},jump:{marks:0,right:0}};
    for(const r of res) for(const k in A){ A[k].marks+=r.assume[k].marks; A[k].right+=r.assume[k].right; }
    console.log(`Rule 8(b) assumed-occupied marks (policy for unforeseen jumps: ${SKIP_JUMP_POLICY}):`);
    for(const k in A) console.log(`   ${k.padEnd(10)} marks=${String(A[k].marks).padStart(7)}  really used by that party=${String(A[k].right).padStart(7)}  phantom=${A[k].marks-A[k].right}`);
  }
  console.log(`badWrite (sender picked a pad reserved in its own view): ${res.reduce((s,r)=>s+r.badWrite,0)}  | timeouts (liveness): ${res.filter(r=>r.timeout).length}`);
  console.log("\n---------------- by delivery mode ----------------");
  for(const [k,rs] of group(r=>r.mode)) console.log(row(k,rs));
  console.log("\n---------------- by sender schedule ----------------");
  for(const [k,rs] of group(r=>r.sched)) console.log(row(k,rs));
  console.log("\n---------------- by tier ----------------");
  for(const [k,rs] of group(r=>r.tier)) console.log(row("tier "+k,rs));
  console.log("\n---------------- order-preserving vs reordering delivery ----------------");
  const FIFO=new Set(["instant","worst"]);
  console.log(row("FIFO modes (instant,worst)",res.filter(r=>FIFO.has(r.mode))));
  console.log(row("reordering modes (other 7)",res.filter(r=>!FIFO.has(r.mode))));
  if(res.length && res[0].lateOlder!==undefined){
    console.log(row("runs w/ NO late-older msg",res.filter(r=>r.lateOlder===0)));
    console.log(row("runs w/ late-older msgs",res.filter(r=>r.lateOlder>0)));
  }
  const ru=res.filter(r=>r.reuse);
  if(ru.length){
    console.log("\n---------------- reuse-halt diagnostics ----------------");
    const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
    const rem=ru.map(r=>r.reuse.remaining/r.d), fr=ru.map(r=>r.reuse.freeRun/r.d);
    console.log(`pads left unused at halt (units of d): median ${q(rem,0.5).toFixed(1)}  p90 ${q(rem,0.9).toFixed(1)}  max ${Math.max(...rem).toFixed(1)}`);
    console.log(`free area around contested pad (units of d): median ${q(fr,0.5).toFixed(1)}  p90 ${q(fr,0.9).toFixed(1)}  max ${Math.max(...fr).toFixed(1)}`);
    console.log(`contested pad was undelivered to the sender: ${ru.filter(r=>r.reuse.undeliveredToSender).length}/${ru.length}`);
    console.log(`sender had already received a LATER msg from the first user (out-of-order): ${ru.filter(r=>r.reuse.reorder).length}/${ru.length}`);
    console.log(`first user got the pad by jump: ${ru.filter(r=>r.reuse.firstJump).length}/${ru.length}   second user by jump: ${ru.filter(r=>r.reuse.secondJump).length}/${ru.length}`);
    if(ru[0].reuse.rewound!==undefined)
      console.log(`sender's believed position of first user was REWOUND by a late older msg: ${ru.filter(r=>r.reuse.rewound).length}/${ru.length}   (buffer for first user empty: ${ru.filter(r=>r.reuse.bufForFirst.length===0).length}/${ru.length})`);
  }
}

module.exports={simulate,buildJobs,summarize,MODES,SCHEDS};
