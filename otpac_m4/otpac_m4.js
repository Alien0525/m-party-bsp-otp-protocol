"use strict";
// ===========================================================================
// Asynchronous m=4 OTPAC protocol A5 -- reference implementation.
// Four parties over one pad [1..n]. P0 (->) and P1 (<-) start at the ends of
// [1, n/2]; P2 (->) and P3 (<-) start at the ends of [n/2+1, n]. A party walks one
// pad at a time in its direction, which never changes. At most d messages are
// undelivered to any party at any of its Send events (the paper's family U_{A,d}).
//
// RULES (numbering used in the paper, the tracer and the visualizer):
//
//  Moving
//   1. Safe send. A party uses its next pad only if that pad is unused, is no
//      other party's position and is in none of the buffers it keeps for the others
//      (Rules 5-8). Otherwise it jumps (Rules 2-4); with no valid jumpspot it halts.
//   2. Jumpspot. The BSP tree over [1..n] gives nodes (M, M+1), listed root first.
//      A right-mover lands on M+1, a left-mover on M. The party picks the first node
//      that is not fully occupied, whose slot for it is free and that is valid (Rule 3).
//   3. Valid node. More than 2d free pads on BOTH sides of the node, counted outside
//      M and M+1. Pads in other parties' buffers count as taken, except that on the
//      lander's back side a pad reserved only for a party moving away from the node
//      is free. Used pads and positions always count.
//   4. Announced jumps. A party that must jump picks q (Rules 2-3) and sends
//      "I jump to q" as d+1 separate public messages that use no pad; each carries
//      its position, its number of real messages so far and a round number. After
//      the last one, on its next turn it gives up q and announces a new spot if
//      (a) it has received another party's latest announcement for the same pad, or
//      (b) q is no longer valid in its view (re-check, Rule 3);
//      otherwise it sends its next real message on q and walks on from there.
//
//  Buffers (what a party keeps for each other party X)
//   5. Reserved pads. Before hearing an announcement from X: X's next d pads on
//      foot from X's last known position, stopping at a used pad, a party's position
//      or a pad reserved for a party moving the same way as X. Pads reserved for
//      parties coming towards X do not stop it, so a pad between two parties walking
//      head-on is reserved for both. After hearing X's latest announcement: exactly
//      X's pads up to the announced position, then q and the d-1 pads after it.
//   6. Recompute. Every buffer is recomputed from scratch, for every other party,
//      whenever the party's view changes: on every message it receives and after
//      each of its own moves.
//   7. Held pads. A pad reserved on foot stays held, with the number of X's message
//      it was reserved for, until X's messages up to that number have arrived or
//      been accounted for (Rule 8). Hearing X's announcement drops held pads off
//      X's announced path, since the announcement says exactly where X goes.
//   8. Message order. Every message carries the sender's message number.
//      (a) An older message only marks its pad used; X's position never moves back.
//      (b) A newer message that skips k numbers: the k pads X used unheard are
//          marked used. They are known exactly from X's position and the
//          announcements heard since. If the new pad does not fit (an announcement
//          not yet heard), the reserved path is used if it fits, else the straight
//          walk, else every pad X could have used (k after X's old position and k
//          before the new pad).
//
//  Stopping
//   9. Halt-all. When any party cannot send (no valid jumpspot), the whole protocol
//      halts and every unused pad counts as wasted. Enforced by the drivers (test
//      suite, tracer, visualizer).
//
// The 3-party protocol is this protocol with P3 silent at pad n for the whole run.
// Option recheck (default ON) switches Rule 4(b); OFF only for comparison runs.
// ===========================================================================

const OPT = { recheck: true, clash: "queue" };   // clash: queue (Rule 4a: rotating priority queue) | giveup (old rule, comparison only)
function setOptions(o){ Object.assign(OPT, o); }

// static BSP split points, root first
function bspNodes(n){
  const out=[]; const q=[[1,n]];
  while(q.length){ const [L,R]=q.shift(); const M=(L+R)>>1;
    if(M>L&&M<R){ out.push(M); if(R-L>=2){ q.push([L,M-1]); q.push([M+1,R]); } } }
  return out;
}
function initWorld(n,d,m){
  m=m||4; const parties=[]; const arenas=m/2, aw=Math.floor(n/arenas);
  for(let a=0;a<arenas;a++){
    const L=a*aw+1, R=(a===arenas-1)?n:(a+1)*aw;
    parties.push({id:2*a,   pos:L, dir:+1, halted:false, sent:0});
    parties.push({id:2*a+1, pos:R, dir:-1, halted:false, sent:0});
  }
  return {n,d,m,parties,used:new Map(),nodes:bspNodes(n)};
}

// --- Rule 1: what a party must not use. blocked = used pads, every position and every
// buffer. resDir: pad -> direction of the party it is reserved for, only for pads blocked
// solely by a reservation (used for the back-side exemption of Rule 3).
function occupancy(view){
  const blocked=new Set(), hard=new Set(), resDir=new Map();
  for(const [id,o] of view.others){
    if(typeof id!=="number"){ for(const b of o.buf) blocked.add(b); continue; }
    blocked.add(o.pos); hard.add(o.pos);
    for(const b of o.buf){ blocked.add(b); if(!resDir.has(b)) resDir.set(b,o.dir); }
  }
  blocked.add(view.self.pos); hard.add(view.self.pos);
  if(view.used) for(const u of view.used){ blocked.add(u); hard.add(u); }
  for(const h of hard) resDir.delete(h);
  return {blocked,resDir};
}
// pads reserved for some other party in this view (drivers assert a sender never picks one)
function buildBlocked(view){
  const reservedBy=new Map();
  for(const [id,o] of view.others){ if(typeof id!=="number") continue;
    for(const b of o.buf) if(!reservedBy.has(b)) reservedBy.set(b,id); }
  return {reservedBy};
}

// --- Rules 2-3
function clearOutside(edge,step,blocked,n){ let c=0,q=edge+step; while(q>=1&&q<=n&&!blocked.has(q)){ c++; q+=step; } return c; }
// back side: a pad reserved only for a party moving `awayDir` (away from the node) is free
function clearBack(edge,step,blocked,n,resDir,awayDir){ let c=0,q=edge+step;
  while(q>=1&&q<=n&&(!blocked.has(q)||resDir.get(q)===awayDir)){ c++; q+=step; } return c; }
// Rule 3 for the node whose slot for a `dir`-mover is `cand`
function nodeValid(cand,dir,blocked,resDir,n,d){
  if(cand<1||cand>n||blocked.has(cand)) return false;
  const left = dir===+1 ? cand-1 : cand, right = left+1;
  const front = dir===+1 ? clearOutside(right,+1,blocked,n) : clearOutside(left,-1,blocked,n);
  const back  = dir===+1 ? clearBack(left,-1,blocked,n,resDir,-dir) : clearBack(right,+1,blocked,n,resDir,-dir);
  return front>2*d && back>2*d;
}
// Rule 2: first node, root first, that is not fully occupied and valid for a `dir`-mover
function jumpTarget(dir,blocked,n,d,nodes,resDir){
  for(const M of nodes){
    if(M+1>n) continue;
    if(blocked.has(M)&&blocked.has(M+1)) continue;
    const cand = dir===+1 ? M+1 : M;
    if(nodeValid(cand,dir,blocked,resDir,n,d)) return cand;
  }
  return null;
}

// --- Rule 4: a party's own next action. st = its current announcement round or null.
// returns {type:"walk",pad} | {type:"ann",q,fresh,why} | {type:"land",q} | null (halt)
function annMove(pos,dir,st,view,n,d,nodes){
  const {blocked,resDir}=occupancy(view);
  const pick=()=>jumpTarget(dir,blocked,n,d,nodes,resDir);
  if(st && st.left>0) return {type:"ann",q:st.q,fresh:false};          // announcements still to send
  if(st && OPT.clash==="queue"){                                       // rotating priority queue (see syncRot)
    syncRot(view,st);
    const m=view.others.size+1; let me=0; while(view.others.has(me)) me++;
    const C=[]; let kstar=st.k||0;
    for(const [id,o] of view.others){ if(typeof id!=="number") continue;
      const a=latestAnn(o); if(!a||a.q!==st.q||(o.lastNum||0)>a.s0) continue;   // not clashing, or it already sent a ciphertext after it
      C.push(id); kstar=Math.max(kstar,a.k||0); }
    const key=id=>((id-kstar)%m+m)%m;            // queue after kstar rotations: party (kstar mod m) on top
    let why=null;
    if(C.some(id=>key(id)<key(me))) why="clash";                                  // someone is ahead of me in the queue
    else if(C.length){ if((st.waited||0)<d+1) return {type:"ann",q:st.q,fresh:false,wait:true};   // I am on top: keep q, wait for them to move
      why="clash"; }                                                              // no word from them in d+1 turns: give up
    if(!why && OPT.recheck && !nodeValid(st.q,dir,blocked,resDir,n,d)) why="recheck";
    if(!why) return {type:"land",q:st.q};
    const q=pick(); if(q==null) return null;
    return {type:"ann",q,fresh:true,why,k:view.rot||0};
  }
  if(st){                                                               // all d+1 sent
    let why=null;
    for(const [id,o] of view.others){ if(typeof id!=="number") continue;   // (a) clash
      for(const a of finalAnns(o).values()) if(a.q===st.q){ why="clash"; break; } if(why) break; }
    if(!why && OPT.recheck && !nodeValid(st.q,dir,blocked,resDir,n,d)) why="recheck";   // (b) re-check
    if(!why) return {type:"land",q:st.q};
    const q=pick(); if(q==null) return null;
    return {type:"ann",q,fresh:true,why};
  }
  const lin=pos+dir;
  if(lin>=1 && lin<=n && !blocked.has(lin)) return {type:"walk",pad:lin};   // Rule 1
  const q=pick(); if(q==null) return null;
  if(OPT.clash==="queue") syncRot(view,null);
  return {type:"ann",q,fresh:true,why:null,k:view.rot||0};
}
// latest announcement of an observed party
function latestAnn(o){ let a=null; if(o.anns) for(const x of o.anns.values()) if(!a||x.aseq>a.aseq) a=x; return a; }
// Rotating priority queue: view.rot = number of rotations this party has applied. Every announcement
// carries its round's count k. Seeing a larger k, or a clash (two parties' latest announcements of the
// same pad, own current round included), moves rot up to that k, resp. to the clash's largest k + 1.
// Using max makes this idempotent, so all parties end at the same count however late they hear things.
function syncRot(view,st){
  let rot=view.rot||0; const byPad=new Map();
  const add=(q,k)=>{ const b=byPad.get(q)||{c:0,k:0}; b.c++; b.k=Math.max(b.k,k||0); byPad.set(q,b); };
  for(const [id,o] of view.others){ if(typeof id!=="number") continue; const a=latestAnn(o); if(!a) continue; rot=Math.max(rot,a.k||0); add(a.q,a.k); }
  if(st) add(st.q,st.k);
  for(const b of byPad.values()) if(b.c>=2) rot=Math.max(rot,b.k+1);
  view.rot=rot;
}

// --- announcements as an observer keeps them: o.anns = round # -> {q,s0,pos0,aseq}
function finalAnns(o){                         // latest announcement per round start s0
  const m=new Map(); if(o.anns) for(const a of o.anns.values()){ const b=m.get(a.s0); if(!b||a.aseq>b.aseq) m.set(a.s0,a); }
  return m;
}
function activeAnn(o){                         // X's latest announcement, if X has not landed yet in this view
  if(!o.anns) return null; let best=null;
  for(const a of o.anns.values()) if(!best||a.aseq>best.aseq) best=a;
  return (best && best.s0>=(o.lastNum||0)) ? best : null;
}
// pad of X's message number c (> last), from X's last known position and the announcements since
function annPadAt(o,last){
  const dir=o.dir, fa=[...finalAnns(o).values()].filter(a=>a.s0>=last).sort((x,y)=>x.s0-y.s0);
  return c=>{ let a=null; for(const x of fa) if(x.s0<c) a=x; return a ? a.q+(c-a.s0-1)*dir : o.pos+(c-last)*dir; };
}

// --- Rule 5: X's next d pads on foot (stops when blocked; never predicts a jump)
function walkPath(view,k,n,d){
  const ko=view.others.get(k), dir=ko.dir, blocked=new Set();
  if(view.used) for(const u of view.used) blocked.add(u);
  for(const [id,o] of view.others){
    if(id===k||typeof id!=="number") continue;
    blocked.add(o.pos);
    if(o.dir===-dir) continue;                  // parties coming towards X do not stop X's walk
    for(const b of o.buf) blocked.add(b);
  }
  blocked.add(view.self.pos);
  const out=[]; let p=ko.pos;
  for(let s=0;s<d;s++){ const q=p+dir; if(q<1||q>n||blocked.has(q)) break; out.push(q); p=q; }
  return out;
}
// --- Rules 5 and 7: the buffer kept for party k.
//   fwd  = currently reserved pads; held = pad -> message # (Rule 7); buf = fwd + held
function refreshBuffer(view,k,n,d){
  const ko=view.others.get(k); if(!ko) return;
  const dir=ko.dir, last=ko.lastNum||0, used=view.used, a=activeAnn(ko);
  let W;
  if(a){ W=[]; const at=annPadAt(ko,last); for(let c=last+1;c<=a.s0;c++){ const q=at(c); if(q>=1&&q<=n) W.push(q); } }
  else W=walkPath(view,k,n,d);
  const L=[];
  if(a) for(let j=0,q=a.q; j<d && q>=1 && q<=n; j++, q+=dir){ if(j>0 && used && used.has(q)) break; L.push(q); }
  const seq=W.concat(L), fwd=[]; for(const q of seq) if(!fwd.includes(q)) fwd.push(q);
  ko.seq=seq; ko.fwd=fwd;
  const buf=fwd.slice(), held=ko.held||(ko.held=new Map());
  if(a){ for(const [q] of [...held]) if(!fwd.includes(q)) held.delete(q); }
  else for(let i=0;i<W.length;i++){ const q=W[i], s=last+1+i; if(!(held.get(q)>=s)) held.set(q,s); }
  for(const [q] of [...held]){ if(used && used.has(q)) held.delete(q); else if(!buf.includes(q)) buf.push(q); }
  ko.buf=buf;
}
// --- Rule 6: recompute every other party's buffer, in id order
function refreshAll(view,n,d){
  for(let id=0;id<=view.others.size;id++) if(view.others.has(id)) refreshBuffer(view,id,n,d);
}

// --- Receive an announcement from X
function deliverAnn(view,fromId,q,s0,pos0,aseq,n,d,k){
  const o=view.others.get(fromId); if(!o) return;
  const anns=o.anns||(o.anns=new Map());
  if(!anns.has(aseq)) anns.set(aseq,{q,s0,pos0,aseq,k:k||0});
  if(OPT.clash==="queue") syncRot(view,null);
  refreshAll(view,n,d);
}
// --- Receive X's real message number `num` on pad `pad` (Rule 8), then Rules 6-7
function deliverBuffer(view,fromId,pad,dir,n,d,nodes,num){
  const o=view.others.get(fromId); if(!o) return;
  if(view.used) view.used.add(pad);
  const last=o.lastNum||0, recv=o.recv||(o.recv=new Set());
  if(num>last){                                             // 8(a): older messages stop here
    if(num>last+1){ markSkipped(view,o,pad,last,num,n); for(let c=last+1;c<num;c++) recv.add(c); }
    o.lastNum=num; o.pos=pad; if(dir!==undefined) o.dir=dir;
  }
  recv.add(num);                                            // Rule 7: release held pads
  o.prefix=o.prefix||0; while(recv.has(o.prefix+1)) o.prefix++;
  for(const [q,s] of [...o.held||[]]) if(s<=o.prefix) o.held.delete(q);
  refreshAll(view,n,d);
}
// Rule 8(b): mark the pads of X's skipped messages last+1 .. num-1
function markSkipped(view,o,pad,last,num,n){
  const k=num-last-1, dir=o.dir, marks=[]; let kase;
  const at=annPadAt(o,last);
  if(at(num)===pad){ kase="exact"; for(let c=last+1;c<num;c++) marks.push(at(c)); }
  else if(o.seq && o.seq.length>k && o.seq[k]===pad){ kase="reserved"; for(let i=0;i<k;i++) marks.push(o.seq[i]); }
  else if(pad===o.pos+(k+1)*dir){ kase="straight"; for(let i=1;i<=k;i++) marks.push(o.pos+i*dir); }
  else { kase="both"; for(let i=1;i<=k;i++){ marks.push(o.pos+i*dir); marks.push(pad-i*dir); } }
  for(const q of marks){ if(q<1||q>n) continue;
    if(view.used) view.used.add(q);
    (o.assumed=o.assumed||[]).push(q);                      // for display
    (o.assumedLog=o.assumedLog||[]).push({pad:q,kase});     // for test statistics
  }
}

if(typeof module!=="undefined") module.exports={setOptions,bspNodes,initWorld,occupancy,buildBlocked,jumpTarget,nodeValid,annMove,activeAnn,refreshBuffer,refreshAll,deliverAnn,deliverBuffer};
