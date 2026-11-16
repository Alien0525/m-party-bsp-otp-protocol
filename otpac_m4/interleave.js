// Measure, per announcement round: other parties' Send events between the 1st and the last
// announcement, and between the last announcement and the landing / give-up.
// usage: [THREE=1] node interleave.js <outFile>
const S=require("./otpac_test_suite.js"), fs=require("fs");
const three=process.env.THREE==="1";
const jobs=S.buildJobs().filter(j=>(j.tier==="A"&&j.seed<30)||(j.tier==="B"&&j.seed===1000)||j.tier==="D"&&j.seed===3000);
const hist={}, histPost={}; let rounds=0, maxIn=0, maxInRel=0, overlapPairs=0, overlapArenas=0, runsBoth=0, worst=null;
for(const j of jobs){
  const log=[]; const r=S.simulate({...j,three,log});
  const P="ABCD"; let act={}; let bothThisRun=false;
  const cur={};                       // party -> {q,startIdx,others,k,lastIdx,post}
  for(const line of log){
    let m=line.match(/^([ABCD]) announces jump to (\d+) \((\d+)\/(\d+)\)/);
    let s=line.match(/^([ABCD]) sends on (\d+)/);
    const who=m?m[1]:s?s[1]:null; if(!who) continue;
    // count this Send event for every other party with an open round
    for(const p in cur){ if(p===who) continue; const c=cur[p]; if(c.k<c.tot) c.others++; else c.post++; }
    if(m){ const k=+m[3], tot=+m[4];
      if(k===1){ if(cur[who]) finish(who); cur[who]={q:+m[2],k:1,tot,others:0,post:0};
        const open=Object.keys(cur).filter(p=>p!==who);
        if(open.length){ bothThisRun=true; for(const p of open){ if(Math.floor(P.indexOf(p)/2)===Math.floor(P.indexOf(who)/2)) overlapPairs++; else overlapArenas++; } } }
      else cur[who].k=k; }
    else if(cur[who] && cur[who].k===cur[who].tot) finish(who);
  }
  if(bothThisRun) runsBoth++;
  function finish(p){ const c=cur[p]; delete cur[p]; rounds++;
    hist[c.others]=(hist[c.others]||0)+1; histPost[c.post]=(histPost[c.post]||0)+1;
    if(c.others>maxIn){maxIn=c.others; worst={...j,q:c.q,party:p};}
    if(c.others/j.d>maxInRel) maxInRel=c.others/j.d; }
}
const out={three,runs:jobs.length,rounds,hist,histPost,maxIn,worst,maxInRel,overlapPairs,overlapArenas,runsBoth};
fs.writeFileSync(process.argv[2],JSON.stringify(out,null,1)); console.log(JSON.stringify(out));
