"use strict";
// ===========================================================================
// Asynchronous m=4 OTPAC simulator -- INDIVIDUAL-JUMP design.
//
// §5 FIX + Aman's jumpspot-invalidation rule (this version):
//
//  * Each per-(observer, party K) reserved buffer is RECOMPUTED FRESH from K's
//    confirmed position on every occupancy change (any party's move). Because
//    it is regenerated each time, a stale/phantom jumpspot is never reproduced
//    -> self-cleaning (fixes the "buffer jams full of a jumpspot K never took"
//    regression).
//
//  * A reserved jumpspot is SPECULATIVE. It is only ever produced while it
//    passes the jump-target validity test (>2d clearance measured OUTSIDE the
//    node, node not fully occupied). The moment another party's approach breaks
//    that clearance -- and K has not been confirmed to have jumped -- the next
//    recompute yields NO jumpspot for K, so it silently drops. (Aman's rule:
//    "if a party reserved a jumpspot, later another party makes it invalid, and
//    I never heard the jumper jump -> the jump never happened -> unreserve it.")
//
//  * Reservations for different parties may OVERLAP. Prediction of K's path uses
//    GENUINE WALLS ONLY -- used pads + other parties' confirmed positions -- and
//    NOT other parties' reservations. So the approaching party's buffer extends
//    LINEARLY through pads that were speculatively reserved for K, and the same
//    pad may sit in several parties' buffers at once.
//
//  * A party's OWN Send (nextSlot) still treats the UNION of all buffers + used
//    + positions as walls, so it never sends a pad reserved (undelivered) for
//    anyone, and jumps at the overlap. node-as-unit (M,M+1), default side
//    (right->M+1, left->M), >2d clearance outside the node, direction preserved.
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

// --- OWN-MOVE occupancy: what a sender must NOT write. Union of used pads,
// every tracked party's confirmed position, and every tracked party's reserved
// buffer (all of them = the security check), plus the sender's own position.
function occupancy(view){
  const blocked=new Set();
  const owner=new Map();
  for(const [id,o] of view.others){
    if(typeof id!=="number") { for(const b of o.buf) blocked.add(b); continue; }
    blocked.add(o.pos); owner.set(o.pos,id);
    for(const b of o.buf){ blocked.add(b); if(!owner.has(b)) owner.set(b,id); }
  }
  blocked.add(view.self.pos);
  if(view.used) for(const u of view.used){ blocked.add(u); if(!owner.has(u)) owner.set(u,'used'); }
  return {blocked,owner};
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
// is NOT reserved again for K (reservations are DISJOINT: each pad is reserved
// for at most one party). Speculative stale jumpspots are still handled by the
// fresh recompute + validity test (Rules 4,7). `extra` = pads already placed in
// K's own buffer this pass (so a step never duplicates one).
function predBlocked(view,k,extra){
  const blocked=new Set();
  if(view.used) for(const u of view.used) blocked.add(u);
  for(const [id,o] of view.others){
    if(id===k||typeof id!=="number") continue;
    blocked.add(o.pos);
    for(const b of o.buf) blocked.add(b);   // disjoint reservations: don't reserve another party's pad
  }
  blocked.add(view.self.pos);
  if(extra) for(const e of extra) blocked.add(e);
  return blocked;
}

// --- root-most not-fully-occupied node, default side by dir, >2d clearance
// measured OUTSIDE the node's own two pads. A jumpspot is VALID only while this
// returns it; when an approaching party breaks the clearance it returns a
// different node or null, so a fresh recompute drops the now-invalid jumpspot.
function jumpTarget(dir,blocked,n,d,nodes){
  for(const M of nodes){
    const left=M,right=M+1; if(right>n) continue;
    if(blocked.has(left)&&blocked.has(right)) continue;   // fully occupied -> descend
    const cand = dir===+1 ? right : left;
    if(blocked.has(cand)) continue;                       // my slot taken -> descend
    if(clearOutside(left,-1,blocked,n) > 2*d && clearOutside(right,+1,blocked,n) > 2*d) return cand;
  }
  return null;                                            // no valid node -> halt
}
function clearOutside(edge,step,blocked,n){let c=0,q=edge+step;while(q>=1&&q<=n&&!blocked.has(q)){c++;q+=step;}return c;}
function clearance(p,step,blocked,n){let c=0,q=p+step;while(q>=1&&q<=n&&!blocked.has(q)){c++;q+=step;}return c;}

// --- one step of a path: WALK if next linear pad free of `blocked`, else JUMP
// to the root-most VALID node. Returns {pad, jumped, face} or null (halt).
function stepOf(pos,dir,blocked,n,d,nodes){
  const lin=pos+dir;
  if(lin>=1 && lin<=n && !blocked.has(lin)) return {pad:lin,jumped:false,face:dir};  // walk
  const t=jumpTarget(dir,blocked,n,d,nodes);                                          // overlap -> jump
  if(t==null) return null;
  return {pad:t,jumped:true,face:dir};
}

// Public: a party's OWN next move, from its view (union-of-buffers occupancy).
function nextSlot(pos,dir,view,n,d,nodes){
  const {blocked}=occupancy(view);
  return stepOf(pos,dir,blocked,n,d,nodes);
}

// --- RECOMPUTE K's reserved buffer FRESH: K's next d pads from K's confirmed
// position, jump-aware, against GENUINE WALLS only, using only CURRENTLY-VALID
// jumpspots. Self-cleaning: a jumpspot that another party has since invalidated
// is simply not produced, and if K's linear path is blocked with no valid
// jumpspot, K halts (buffer stops -- no phantom reservation).
function refreshBuffer(observerView,k,n,d,nodes){
  const ko=observerView.others.get(k);
  if(!ko) return;
  let p=ko.pos, dir=ko.dir;
  const buf=[];
  for(let s=0;s<d;s++){
    const blocked=predBlocked(observerView,k,buf);
    const st=stepOf(p,dir,blocked,n,d,nodes);
    if(!st) break;                       // K would halt here -> reserve nothing further
    buf.push(st.pad);
    p=st.pad; if(st.jumped) dir=st.face;
  }
  ko.buf=buf;
}

// --- RECEIVE: observer hears party `fromId` used pad `pad` moving `dir`.
// Record it used, advance that party's confirmed position, then RE-VALIDATE
// EVERY tracked party's buffer -- because this party's move may have
// invalidated another party's speculative jumpspot (Aman's rule) or freed pads
// the mover can now reserve linearly.
function deliverBuffer(observerView,fromId,pad,dir,n,d,nodes){
  const o=observerView.others.get(fromId);
  if(!o) return;
  if(observerView.used) observerView.used.add(pad);
  o.pos=pad; if(dir!==undefined) o.dir=dir;
  for(const [id] of observerView.others){ if(typeof id==="number") refreshBuffer(observerView,id,n,d,nodes); }
}

module.exports={bspNodes,initWorld,occupancy,buildBlocked,predBlocked,jumpTarget,stepOf,nextSlot,refreshBuffer,deliverBuffer};
