"use strict";
// ===========================================================================
// Asynchronous m=4 OTPAC simulator -- INDIVIDUAL-JUMP design.
//
// RULES:
//  1. Own Send / security: use pos+dir only if it is in NO reserved buffer and
//     not used; else jump; else halt.
//  2. Jump target = BSP node (M,M+1); right-mover -> M+1, left-mover -> M;
//     direction preserved; root-most not-fully-occupied node.
//  3. Jump validity: >2d free pads on BOTH sides of the node, measured OUTSIDE the node.
//     A pad in another party's reserved/held buffer counts as taken, so the check runs
//     from that party's furthest reserved pad, not from its believed position (option
//     frontOnly=true checks only the lander's front side; off since 2026-11-06). On
//     the lander's back side (the partner slot's side), pads merely reserved for
//     parties moving the opposite way (away from the node) do not count;
//     positions and used pads always count.
//  4. Predictions are RECOMPUTED fresh on any occupancy change (walk-predicted
//     pads are additionally held, Rule 9).
//  5. Reservations are DISJOINT: a pad reserved for one party is not reserved
//     for another (prediction treats others' buffers as obstacles too).
//  6. Speculative-jumpspot invalidation: a jumpspot is PREDICTED only while it
//     passes Rule 3; once an approaching party breaks its clearance it is no
//     longer predicted for new reservations (a pad already reserved for it stays
//     held under Rule 9 until the party's messages prove it unused).
//  7. On every Receive, re-validate ALL tracked parties' buffers, not just the
//     sender's.
//  8. Message order (header carries a per-sender message #):
//     (a) an OLDER message only marks its pad used -- it never moves the
//         sender's believed position backward;
//     (b) a NEWER message that skips k numbers means the sender used k pads on
//         the way; those pads are marked occupied, carefully around jumps:
//         only the reservation if the sender provably followed it, only the
//         straight-line pads if it provably walked, and for an unforeseen jump
//         every pad it could have used (see assumeSkipped).
//  9. Sticky reservations: a predicted pad (walk or jump) stays reserved until
//     all of the party's messages up to the one it was predicted for have arrived
//     or been accounted for by Rule 8(b) (then it is known used or proven unused).
// 10. (removed 2026-10-17) Shared slot assignment by party priority. It made a party
//     ignore the predicted landing of a lower-priority party and land on that slot
//     itself, which caused reuses when the other party had already jumped. Kept as an
//     option (sharedSlots, default OFF) for comparison runs only.
// 11. (removed 2026-11-04) Keep your own next pad: an observer never predicted another
//     party into its own next pad. With the observer's own position kept current (bug fix
//     2026-10-21) it caused walking collisions: two parties walking toward each other each
//     kept the pad between them and both used it. Kept as option contested="always"
//     (default "off") for comparison runs only.
// 13. Legal landings only (selfAhead, default ON): an observer never predicts another party
//     to land on one of the observer's own next d pads, and every prediction is recomputed
//     after each move (the observer's own included). "reserved" = current legal prediction;
//     pads reserved earlier stay "held" until resolved (Rule 9). Neither is ever used (R1).
// 12. Halt-all (Prof. Di Crescenzo, 2026-11-04): when any party cannot send (no valid
//     jumpspot), the whole protocol halts and all remaining pads count as wasted. This is
//     enforced by the drivers (test suite, tracer, visualizer), not by this engine.
// 15. Own reservation (selfRes, default ON, Aman 2026-11-06): every observer also reserves its
//     OWN next d pads (walking, or its jump landing and the walk after it), computed in its
//     place in the priority order P0, P1, P2, P3. Lower-priority parties are never predicted
//     to land on them, so a party about to jump keeps the jumpspot everyone else predicts
//     for it instead of leaving it to a same-direction party that jumps after it.
//     Like the reservations others make for it (Rule 14), it covers both timelines (walk W and,
//     when an opposite-direction party's walk blocks it, jump J), and earlier own reservations
//     stay held until the observer has sent the message they were predicted for.
// ===========================================================================

function bspNodes(n){                      // static BSP center-pad pairs, root-first
  const out=[]; const q=[[1,n]];
  while(q.length){const [L,R]=q.shift();const M=(L+R)>>1;
    if(M>L&&M<R){out.push(M);if(R-L>=2){q.push([L,M-1]);q.push([M+1,R]);}}}
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

// Options (both ON by default; switchable for comparison runs):
//   sticky      -- Rule 9: predicted reservations are held until proven resolved
//   stickyJumps -- apply Rule 9 to jump-predicted pads too (default ON); OFF = those
//                  follow the older Rule 6 (dropped as soon as the prediction changes)
//   oppExempt -- Rule 3 refinement: on the lander's back side, pads merely reserved for
//                parties moving the opposite way (away from the node) are not obstacles
const OPT={sticky:true, oppExempt:true, stickyJumps:true, sharedSlots:false, contested:"off", backPass:false, fallback:"off", frontOnly:false, selfAhead:true, twoTimelines:true, selfRes:true};
// twoTimelines -- (ON by default, Aman 2026-11-04) Rule 14. When two parties approach head-on and their
//             predicted pads overlap, the order in which they will meet is unknown, so an
//             observer reserves BOTH timelines for each of them: (W) the walk timeline, where
//             K walks on regardless of opposite-direction reservations (the contested pads are
//             reserved for both), and (J) the jump timeline, where the opponent's walk timeline
//             (or the observer's own next d pads, if the observer is the opponent) blocks K and
//             K jumps; K's jumpspot is reserved. Both stay held (Rule 9) until K's messages
//             resolve them. Rule 8(b) matches a skipped message against either timeline.
// selfAhead -- (ON by default since 2026-11-04, Aman) when an observer predicts another party's
//             LANDING, its own next d pads (the pads it will walk into) are not legal landing
//             slots and count as occupied for that node's clearance. Walking predictions are
//             unchanged. Drivers also recompute every prediction after a party's own move,
//             so "reserved" always holds only currently legal spots; earlier reservations stay
//             in "held" (Rule 9) and are never used.
// frontOnly -- (OFF by default again since 2026-11-06, Aman: a lander must also check its back
//             side, where a same-direction party may be walking toward the node) Rule 3 checks only the lander's FRONT side, the
//             side it will walk into (left of the node for a left-mover, right for a right-mover);
//             the back side, behind the lander, is not checked.
// fallback -- (experimental) when an observer predicts party K and K must jump but no node is
//             valid in the observer's view, the observer still reserves ONE pad for K: K's
//             landing slot at its next jumpspot, since K (or another observer) may have seen that
//             node as valid. "first": root-most node whose slot is free, clearance ignored;
//             "best": the node with free slot and the most clearance (min of both sides).
// backPass -- Rule 3 extension (experimental): on the lander's BACK side, used pads and the
//             positions of parties moving away from the node do not count as obstacles
//             either (only parties that could come towards the landing matter).
// contested -- Rule 11 (experimental): a party does not give its OWN next pad away. When the
//              observer's next pad is also the next pad another party K is predicted to walk
//              into, the observer does not predict K into it ("always": every party keeps its
//              own next pad; "low"/"high": only if it has the lower/higher id). The pad stays
//              reserved for whoever others have been holding it for (Rule 9), so the party that
//              arrived later is the one that jumps. "off" = old behaviour.
// sharedSlots -- old Rule 10 (REMOVED, option OFF by default): jump LANDING slots are assigned in one fixed priority order
//                (party id: P0 first), the observer's own landing included.
function setOptions(o){ Object.assign(OPT,o); }

// --- OWN-MOVE occupancy: what a sender must NOT write. Union of used pads,
// every tracked party's confirmed position, and every tracked party's reserved
// buffer (all of them = the security check), plus the sender's own position.
// resDir: pad -> direction of the party it is reserved for, only for pads that are
// blocked SOLELY by a reservation (not used, not anyone's position).
function occupancy(view){
  const blocked=new Set(), owner=new Map(), hard=new Set(), resDir=new Map();
  for(const [id,o] of view.others){
    if(typeof id!=="number") { for(const b of o.buf) blocked.add(b); continue; }
    blocked.add(o.pos); hard.add(o.pos); owner.set(o.pos,id);
    for(const b of o.buf){ blocked.add(b); if(!owner.has(b)) owner.set(b,id); if(!resDir.has(b)) resDir.set(b,o.dir); }
  }
  blocked.add(view.self.pos); hard.add(view.self.pos);
  if(view.used) for(const u of view.used){ blocked.add(u); hard.add(u); if(!owner.has(u)) owner.set(u,'used'); }
  for(const h of hard) resDir.delete(h);
  return {blocked,owner,resDir};
}

// --- reservedBy: pads reserved (undelivered) for SOME OTHER party in this view,
// used by the driver's badWrite assertion (a sender must never pick one).
function buildBlocked(view,n){
  const reservedBy=new Map();
  for(const [id,o] of view.others){
    if(typeof id!=="number") continue;
    for(const b of o.buf){ if(!reservedBy.has(b)) reservedBy.set(b,id); }
  }
  return {reservedBy};
}

// --- PREDICTION occupancy for party K. Obstacles are: used pads, every OTHER
// tracked party's confirmed position, the observer's own position, AND every
// OTHER party's reserved buffer -- so a pad already reserved for another party
// is NOT reserved again for K (reservations are DISJOINT). `extra` = pads already
// placed in K's own buffer this pass. Returns {blocked, resDir} (see occupancy).
function predBlocked(view,k,extra,skipDir){
  const blocked=new Set(), hard=new Set(), resDir=new Map();
  if(view.used) for(const u of view.used){ blocked.add(u); hard.add(u); }
  for(const [id,o] of view.others){
    if(id===k||typeof id!=="number") continue;
    blocked.add(o.pos); hard.add(o.pos);
    if(skipDir!==undefined && o.dir===skipDir) continue;   // Rule 14 walk timeline: ignore opposite-direction reservations
    for(const b of o.buf){ blocked.add(b); if(!resDir.has(b)) resDir.set(b,o.dir); }   // disjoint reservations
  }
  blocked.add(view.self.pos); hard.add(view.self.pos);
  if(extra) for(const e of extra){ blocked.add(e); hard.add(e); }
  for(const h of hard) resDir.delete(h);
  return {blocked,resDir};
}

// the observer's own id = the one party id it does not track
function selfIdOf(view){ for(let i=0;i<=view.others.size;i++) if(!view.others.has(i)) return i; return -1; }

// --- Rule 10: walls for choosing party X's LANDING slot. Starting from the normal
// walls, drop pads that are only LANDING claims of lower-priority parties (id > X;
// they yield to X), and add the observer's own landing claim if the observer has
// higher priority than X. Used pads, positions, X's own pads so far and every
// party's WALKING pads are never dropped.
function landingWalls(view,X,blocked,resDir,extra){
  if(!OPT.sharedSlots) return {blocked,resDir};
  const sid=selfIdOf(view), lb=new Set(blocked), lr=new Map(resDir), prot=new Set();
  if(view.used) for(const u of view.used) prot.add(u);
  prot.add(view.self.pos); if(extra) for(const e of extra) prot.add(e);
  for(const [id,o] of view.others){
    if(typeof id!=="number") continue;
    if(id!==X) prot.add(o.pos);
    for(const b of (o.fwd||[])) if(!(o.landClaim&&o.landClaim.has(b))) prot.add(b);
    if(o.held) for(const [q] of o.held) if(!(o.heldLand&&o.heldLand.has(q))) prot.add(q);
  }
  for(const [id,o] of view.others){
    if(typeof id!=="number"||id===X||id<X) continue;          // only LOWER-priority parties
    if(o.landClaim) for(const q of o.landClaim) if(!prot.has(q)){ lb.delete(q); lr.delete(q); }
    if(o.heldLand)  for(const q of o.heldLand)  if(!prot.has(q)){ lb.delete(q); lr.delete(q); }
  }
  if(view.selfClaim && sid<X) for(const q of view.selfClaim){ lb.add(q); if(!prot.has(q)) lr.set(q,view.self.dir); }
  return {blocked:lb,resDir:lr};
}

// one predicted step for party X: walk if free, else land on the slot Rule 10 gives X
// the observer's own next d pads in its direction, up to the first used pad (option selfAhead)
function selfAheadPads(view,n,d){
  const out=[]; if(!OPT.selfAhead||!view.self||view.self.pos==null) return out;
  let q=view.self.pos;
  for(let i=0;i<d;i++){ q+=view.self.dir; if(q<1||q>n||(view.used&&view.used.has(q))) break; out.push(q); }
  return out;
}
function predStep(view,X,p,dir,blocked,resDir,extra,n,d,nodes){
  const lin=p+dir;
  if(lin>=1 && lin<=n && !blocked.has(lin)) return {pad:lin,jumped:false,face:dir};
  let L=landingWalls(view,X,blocked,resDir,extra);
  const ahead=selfAheadPads(view,n,d);
  if(OPT.selfRes && view.selfRes && view.selfRes.length && X>selfIdOf(view)) for(const q of view.selfRes) if(!ahead.includes(q)) ahead.push(q);   // Rule 15
  if(ahead.length){ const b=new Set(L.blocked), r=new Map(L.resDir); for(const q of ahead){ b.add(q); r.delete(q); } L={blocked:b,resDir:r}; }
  const t=jumpTarget(dir,L.blocked,n,d,nodes,L.resDir,passMap(view));
  return t==null?null:{pad:t,jumped:true,face:dir};
}

// --- Rule 10: the observer's OWN prospective landing (and the walk after it within
// d steps), so that lower-priority parties' predicted landings avoid it.
function computeSelfClaim(view,n,d,nodes){
  if(!OPT.sharedSlots){ view.selfClaim=null; return; }
  const X=selfIdOf(view); let p=view.self.pos, dir=view.self.dir; const fwd=[]; let firstJump=-1;
  for(let s=0;s<d;s++){
    const {blocked,resDir}=occupancy(view); for(const e of fwd) blocked.add(e);
    const st=predStep(view,X,p,dir,blocked,resDir,fwd,n,d,nodes);
    if(!st) break;
    if(st.jumped && firstJump<0) firstJump=fwd.length;
    fwd.push(st.pad); p=st.pad; if(st.jumped) dir=st.face;
  }
  view.selfClaim=new Set(firstJump<0?[]:fwd.slice(firstJump));
}

// Rule 15: the observer's own next d pads from its current view, in both timelines (as others
// reserve them for it, Rule 14): its walk W and, if an opposite-direction party's walk timeline
// blocks it, its jump timeline J. Earlier own reservations stay held until the observer has sent
// the message they were predicted for (or the pad is used).
function computeSelfRes(view,n,d,nodes){
  if(!OPT.selfRes||!view.self||view.self.pos==null){ view.selfRes=null; return; }
  if(view._selfLastPos!==view.self.pos){ if(view._selfLastPos!==undefined) view._selfSent=(view._selfSent||0)+1; view._selfLastPos=view.self.pos; }
  const sent=view._selfSent||0;
  const ownPath=extra=>{ let p=view.self.pos, dir=view.self.dir; const out=[];
    for(let s=0;s<d;s++){
      const {blocked,resDir}=occupancy(view); for(const e of out) blocked.add(e);
      if(extra) for(const q of extra){ if(q!==p){ blocked.add(q); resDir.delete(q); } }
      const st=stepOf(p,dir,blocked,n,d,nodes,resDir,passMap(view));
      if(!st) break; out.push(st.pad); p=st.pad; if(st.jumped) dir=st.face;
    }
    return out; };
  const W=ownPath(null), seqs=[W];
  if(OPT.twoTimelines){
    const block=new Set(), Wc=view._W;
    for(const [id,o] of view.others) if(typeof id==="number" && o.dir===-view.self.dir){
      const wp=(Wc&&Wc.has(id))?Wc.get(id):pathFor(view,id,n,d,nodes,-o.dir,null); for(const q of wp) block.add(q); }
    if(block.size){ const J=ownPath(block); if(J.join()!==W.join()) seqs.push(J); }
  }
  const held=view.selfHeld||(view.selfHeld=new Map());
  for(const sq of seqs) for(let i=0;i<sq.length;i++){ const q=sq[i], s=sent+1+i; if(!(held.get(q)>=s)) held.set(q,s); }
  const out=[]; for(const sq of seqs) for(const q of sq) if(!out.includes(q)) out.push(q);
  for(const [q,s] of [...held]){ if((view.used&&view.used.has(q))||s<=sent) held.delete(q); else if(!out.includes(q)) out.push(q); }
  view.selfRes=out;
}
// recompute every party in priority order (P0 first), the observer's own claim in its place
function refreshAll(view,n,d,nodes){
  const sid=selfIdOf(view), N=view.others.size+1;
  if(OPT.twoTimelines){                    // Rule 14: every party's walk timeline, once per pass
    view._W=new Map(); for(const [id,o] of view.others) if(typeof id==="number") view._W.set(id,pathFor(view,id,n,d,nodes,-o.dir,null));
  }
  for(let id=0;id<N;id++){ if(id===sid){ computeSelfClaim(view,n,d,nodes); computeSelfRes(view,n,d,nodes); } else if(view.others.has(id)) refreshBuffer(view,id,n,d,nodes); }
  view._W=null;
}

// --- root-most not-fully-occupied node, default side by dir, >2d clearance
// measured OUTSIDE the node's own two pads.
//   FRONT side (the side the lander travels toward): every obstacle counts.
//   BACK side (where the node's partner slot is): pads merely RESERVED for parties
//     moving the OPPOSITE way -- i.e. away from this node -- do not count (e.g. a
//     right-mover predicted to land on the partner slot M+1 and walk right does not
//     invalidate M for a left-mover). Positions and used pads always count.
// A jumpspot is VALID only while this returns it; when an approaching party
// breaks the clearance it returns a different node or null (Rule 6).
function passMap(view){
  if(!OPT.backPass||!view) return null;
  const m=new Map();
  for(const [id,o] of view.others) if(typeof id==="number") m.set(o.pos,o.dir);
  m.set(view.self.pos,view.self.dir);
  if(view.used) for(const u of view.used) m.set(u,0);
  return m;
}
function jumpTarget(dir,blocked,n,d,nodes,resDir,pass){
  for(const M of nodes){
    const left=M,right=M+1; if(right>n) continue;
    if(blocked.has(left)&&blocked.has(right)) continue;   // fully occupied -> descend
    const cand = dir===+1 ? right : left;
    if(blocked.has(cand)) continue;                       // my slot taken -> descend
    const front = dir===+1 ? clearOutside(right,+1,blocked,n) : clearOutside(left,-1,blocked,n);
    const back = (OPT.oppExempt && resDir)
      ? (dir===+1 ? clearOutsideExempt(left,-1,blocked,n,resDir,-dir,pass) : clearOutsideExempt(right,+1,blocked,n,resDir,-dir,pass))
      : (dir===+1 ? clearOutside(left,-1,blocked,n) : clearOutside(right,+1,blocked,n));
    if(front > 2*d && (OPT.frontOnly || back > 2*d)) return cand;
  }
  return null;                                            // no valid node -> halt
}
// fallback jumpspot for a party with no valid node (option `fallback`)
function fallbackTarget(dir,blocked,n,d,nodes,resDir,pass,mode){
  let best=null, bestScore=-1;
  for(const M of nodes){
    const left=M,right=M+1; if(right>n) continue;
    if(blocked.has(left)&&blocked.has(right)) continue;
    const cand = dir===+1 ? right : left;
    if(blocked.has(cand)) continue;
    if(mode==="first") return cand;
    const front = dir===+1 ? clearOutside(right,+1,blocked,n) : clearOutside(left,-1,blocked,n);
    const back = (OPT.oppExempt && resDir)
      ? (dir===+1 ? clearOutsideExempt(left,-1,blocked,n,resDir,-dir,pass) : clearOutsideExempt(right,+1,blocked,n,resDir,-dir,pass))
      : (dir===+1 ? clearOutside(left,-1,blocked,n) : clearOutside(right,+1,blocked,n));
    const sc=OPT.frontOnly?front:Math.min(front,back); if(sc>bestScore){bestScore=sc; best=cand;}
  }
  return best;
}
function clearOutside(edge,step,blocked,n){let c=0,q=edge+step;while(q>=1&&q<=n&&!blocked.has(q)){c++;q+=step;}return c;}
// as clearOutside, but a pad reserved for a party moving in `awayDir` is treated as free
function clearOutsideExempt(edge,step,blocked,n,resDir,awayDir,pass){let c=0,q=edge+step;
  while(q>=1&&q<=n&&(!blocked.has(q)||resDir.get(q)===awayDir||(pass&&pass.has(q)&&(pass.get(q)===0||pass.get(q)===awayDir)))){c++;q+=step;}return c;}
function clearance(p,step,blocked,n){let c=0,q=p+step;while(q>=1&&q<=n&&!blocked.has(q)){c++;q+=step;}return c;}

// --- one step of a path: WALK if next linear pad free of `blocked`, else JUMP
// to the root-most VALID node. Returns {pad, jumped, face} or null (halt).
function stepOf(pos,dir,blocked,n,d,nodes,resDir,pass){
  const lin=pos+dir;
  if(lin>=1 && lin<=n && !blocked.has(lin)) return {pad:lin,jumped:false,face:dir};  // walk
  const t=jumpTarget(dir,blocked,n,d,nodes,resDir,pass);                              // overlap -> jump
  if(t==null) return null;
  return {pad:t,jumped:true,face:dir};
}

// Public: a party's OWN next move, from its view (union-of-buffers occupancy).
function nextSlot(pos,dir,view,n,d,nodes){
  const {blocked,resDir}=occupancy(view);
  return stepOf(pos,dir,blocked,n,d,nodes,resDir,passMap(view));
}

// --- K's reserved buffer = FRESH prediction + HELD (sticky) pads.
//   fwd: K's next d pads from K's confirmed position, jump-aware, recomputed on
//        every occupancy change. Jump-predicted pads (a landing and the walk after
//        it) live only here, so an invalidated jumpspot drops (Rule 6).
//   held (Rule 9): every predicted pad (with stickyJumps OFF: only those before the
//        first predicted jump) is also remembered with the message # it was
//        predicted for, and stays reserved until all of K's messages up to that #
//        have arrived or been accounted for (then it is known used or proven unused).
// Rule 14: K's predicted path under a given set of extra obstacles / ignored reservations.
function pathFor(view,k,n,d,nodes,skipDir,extraBlock){
  const ko=view.others.get(k); let p=ko.pos, dir=ko.dir; const fwd=[];
  for(let s=0;s<d;s++){
    const {blocked,resDir}=predBlocked(view,k,fwd,skipDir);
    if(extraBlock) for(const q of extraBlock){ if(q!==p){ blocked.add(q); resDir.delete(q); } }
    const st=predStep(view,k,p,dir,blocked,resDir,fwd,n,d,nodes);
    if(!st) break;
    fwd.push(st.pad); p=st.pad; if(st.jumped) dir=st.face;
  }
  return fwd;
}
// the observer's own next d pads, regardless of selfAhead (Rule 14 jump timeline)
function ownAhead(view,n,d){
  const out=[]; if(!view.self||view.self.pos==null) return out; let q=view.self.pos;
  for(let i=0;i<d;i++){ q+=view.self.dir; if(q<1||q>n||(view.used&&view.used.has(q))) break; out.push(q); }
  return out;
}
function refreshTimelines(observerView,k,n,d,nodes){
  const ko=observerView.others.get(k), dir=ko.dir;
  const Wc=observerView._W, wOf=(id,o)=>(Wc&&Wc.has(id))?Wc.get(id):pathFor(observerView,id,n,d,nodes,-o.dir,null);
  const W=wOf(k,ko);                                                    // walk timeline
  const block=new Set();
  for(const [id,o] of observerView.others) if(id!==k && typeof id==="number" && o.dir===-dir)
    for(const q of wOf(id,o)) block.add(q);                             // opponents' walk timelines
  if(observerView.self && observerView.self.dir===-dir) for(const q of ownAhead(observerView,n,d)) block.add(q);
  const J=pathFor(observerView,k,n,d,nodes,undefined,block);           // jump timeline
  const seqs=[J]; if(W.join()!==J.join()) seqs.push(W);
  const fwd=J.slice(); for(const q of W) if(!fwd.includes(q)) fwd.push(q);
  ko.seqs=seqs; ko.fwd=fwd; ko.landClaim=new Set();
  const buf=fwd.slice();
  if(OPT.sticky){
    const held=ko.held||(ko.held=new Map()), heldLand=ko.heldLand||(ko.heldLand=new Set());
    const last=ko.lastNum||0;
    for(const sq of seqs) for(let i=0;i<sq.length;i++){ const q=sq[i], s=last+1+i; if(!(held.get(q)>=s)) held.set(q,s); }
    const used=observerView.used;
    for(const [q] of held){ if(used&&used.has(q)){ held.delete(q); heldLand.delete(q); } else if(!buf.includes(q)) buf.push(q); }
  }
  ko.buf=buf;
}
function refreshBuffer(observerView,k,n,d,nodes){
  const ko=observerView.others.get(k);
  if(!ko) return;
  if(OPT.twoTimelines) return refreshTimelines(observerView,k,n,d,nodes);
  ko.seqs=null;
  let p=ko.pos, dir=ko.dir;
  const fwd=[]; let firstJump=-1;
  // Rule 11: the observer keeps its own next pad if it has priority over K
  let keep=null;
  if(OPT.contested!=="off"){
    const sid=selfIdOf(observerView), sn=observerView.self.pos+observerView.self.dir;
    const prio = OPT.contested==="always" ? true : OPT.contested==="low" ? sid<k : sid>k;
    if(prio && sn>=1 && sn<=n && !(observerView.used&&observerView.used.has(sn))) keep=sn;
  }
  for(let s=0;s<d;s++){
    const {blocked,resDir}=predBlocked(observerView,k,fwd);
    if(keep!==null){ blocked.add(keep); resDir.delete(keep); }
    const st=predStep(observerView,k,p,dir,blocked,resDir,fwd,n,d,nodes);
    if(!st){                             // K would halt here -> predict nothing further
      if(OPT.fallback!=="off"){          // ...except one pad at K's next jumpspot (option fallback)
        const fb=fallbackTarget(dir,blocked,n,d,nodes,resDir,passMap(observerView),OPT.fallback);
        if(fb!=null){ if(firstJump<0) firstJump=fwd.length; fwd.push(fb); }
      }
      break;
    }
    if(st.jumped && firstJump<0) firstJump=fwd.length;
    fwd.push(st.pad);
    p=st.pad; if(st.jumped) dir=st.face;
  }
  ko.fwd=fwd;
  ko.landClaim=new Set(firstJump<0?[]:fwd.slice(firstJump));   // Rule 10: predicted landing (+ walk after it)
  const buf=fwd.slice();
  if(OPT.sticky){
    const held=ko.held||(ko.held=new Map());          // pad -> message # it was predicted for
    const heldLand=ko.heldLand||(ko.heldLand=new Set());  // held pads that were predicted LANDING pads
    const last=ko.lastNum||0, lin=(OPT.stickyJumps||firstJump<0)?fwd.length:firstJump;
    for(let i=0;i<lin;i++){ const q=fwd[i], s=last+1+i; if(!(held.get(q)>=s)) held.set(q,s);
      if(firstJump>=0 && i>=firstJump) heldLand.add(q); else heldLand.delete(q); }
    const used=observerView.used;
    for(const [q] of held){ if(used&&used.has(q)){ held.delete(q); heldLand.delete(q); } else if(!buf.includes(q)) buf.push(q); }
  }
  ko.buf=buf;
}

// --- RECEIVE: observer hears party `fromId` used pad `pad` moving `dir`, in
// that party's message number `num` (header = sender, pad, message #).
//
//   OLDER message (num <= highest # already received from this sender):
//     only mark `pad` as used. The believed position/direction do NOT move
//     (an older message must never move a party backward).
//   NEWER message that skips k numbers (num = last + 1 + k):
//     the party must have used k pads to get here, so the first k pads of the
//     current reservation for it are ASSUMED OCCUPIED (marked used). Then the
//     believed position/direction move to `pad`.
//
// Then RE-VALIDATE EVERY tracked party's buffer, because this move may have
// invalidated another party's speculative jumpspot or freed pads it can now
// reserve. (If `num` is omitted, falls back to the old behaviour: always move.)
function deliverBuffer(observerView,fromId,pad,dir,n,d,nodes,num){
  const o=observerView.others.get(fromId);
  if(!o) return;
  if(observerView.used) observerView.used.add(pad);
  const last=o.lastNum||0;
  const recv=o.recv||(o.recv=new Set());
  if(num===undefined || num>last){
    if(num!==undefined){
      const k=num-last-1;                                    // messages skipped
      if(k>0){
        // Rule 8(b) marks every pad the skipped messages could have used; if that
        // accounting is complete, the skipped numbers count as resolved (Rule 9).
        const accounted=assumeSkipped(observerView,o,pad,k,n);
        if(accounted) for(let c=last+1;c<num;c++) recv.add(c);
      }
      o.lastNum=num;
    }
    o.pos=pad; if(dir!==undefined) o.dir=dir;
  }
  if(num!==undefined){
    // Rule 9: once messages 1..prefix are all received or accounted for, every held
    // pad predicted for a message # <= prefix is resolved (known used, or proven unused).
    recv.add(num);
    o.prefix=o.prefix||0; while(recv.has(o.prefix+1)) o.prefix++;
    if(o.held) for(const [q,s] of o.held) if(s<=o.prefix){ o.held.delete(q); if(o.heldLand) o.heldLand.delete(q); }
  }
  // else: older message -> pad is marked used above; position stays where it is
  refreshAll(observerView,n,d,nodes);   // every party, in priority order (Rule 10)
}

// --- Rule 8(b): party K sent k messages we have not received between its last
// confirmed pad (o.pos) and `pad`. Mark as occupied the pads K used for them.
// K's direction never changes (direction is preserved across jumps).
//  (i)  PREDICTED: `pad` is the (k+1)-th pad of our current reservation for K, so K
//       followed the predicted path (walks and any predicted jump) -> the first k
//       reserved pads are certain.
//  (ii) STRAIGHT WALK: pad = o.pos + (k+1)*dir. A jump can never land there (a
//       landing needs >2d free pads around it), so K walked -> the k pads between
//       are certain, whatever the reservation said.
//  (iii) UNFORESEEN JUMP: K walked j pads (0<=j<=k), jumped, then walked into `pad`;
//       j is unknown, so which pads K used is unknown. Policy (SKIP_JUMP_POLICY):
//         "both"   (default) mark every pad K could have used: the k pads right
//                  after o.pos and the k pads right before `pad` (<= k extra pads);
//         "guided" guess j from our reservation's walk prefix (pads it predicted K
//                  would walk before jumping) and mark only that guess;
//         "none"   mark nothing.
let SKIP_JUMP_POLICY="both";
function setSkipJumpPolicy(p){ SKIP_JUMP_POLICY=p; }
function assumeSkipped(view,o,pad,k,n){
  const dir=o.dir, marks=[]; let kase; const pred=o.fwd||o.buf;   // the fresh prediction, in order
  const hit=(o.seqs||[pred]).find(sq=>sq.length>k && sq[k]===pad);   // Rule 14: either timeline
  if(hit){ kase="predicted"; for(let i=0;i<k;i++) marks.push(hit[i]); }
  else if(pad===o.pos+(k+1)*dir){ kase="straight"; for(let i=1;i<=k;i++) marks.push(o.pos+i*dir); }
  else {
    kase="jump";
    if(SKIP_JUMP_POLICY==="both"){ for(let i=1;i<=k;i++){ marks.push(o.pos+i*dir); marks.push(pad-i*dir); } }
    else if(SKIP_JUMP_POLICY==="guided"){
      let j=0; while(j<k && j<pred.length && pred[j]===o.pos+(j+1)*dir) j++;     // predicted walks before the jump
      for(let i=1;i<=j;i++) marks.push(o.pos+i*dir);                          // pre-jump walks
      for(let i=1;i<=k-j;i++) marks.push(pad-i*dir);                           // landing + walks after it
    }
  }
  for(const q of marks){
    if(q<1||q>n) continue;
    if(view.used) view.used.add(q);
    (o.assumed=o.assumed||[]).push(q);                        // for display
    (o.assumedLog=o.assumedLog||[]).push({pad:q,kase});       // for test statistics
  }
  // complete accounting: the path is certain, or every possible pad was marked
  return kase!=="jump" || SKIP_JUMP_POLICY==="both";
}

if(typeof module!=="undefined") module.exports={bspNodes,initWorld,occupancy,buildBlocked,predBlocked,jumpTarget,stepOf,nextSlot,refreshBuffer,refreshAll,deliverBuffer,setSkipJumpPolicy,setOptions};
