"use strict";
// ===========================================================================
// Asynchronous m=4 OTPAC simulator -- INDIVIDUAL-JUMP design.
//
// RULES:
//  1. Own Send / security: use pos+dir only if it is in NO reserved buffer and
//     not used; else jump; else halt.
//  2. Jump target = BSP node (M,M+1); right-mover -> M+1, left-mover -> M;
//     direction preserved; root-most not-fully-occupied node.
//  3. Jump validity: >2d free pads on BOTH sides measured OUTSIDE the node. On
//     the lander's back side (the partner slot's side), pads merely reserved for
//     parties moving the opposite way (away from the node) do not count;
//     positions and used pads always count.
//  4. Predictions are RECOMPUTED fresh on any occupancy change (walk-predicted
//     pads are additionally held, Rule 9).
//  5. Reservations are DISJOINT: a pad reserved for one party is not reserved
//     for another (prediction treats others' buffers as obstacles too).
//  6. Speculative-jumpspot invalidation: a jumpspot is produced only while it
//     passes Rule 3; an approaching party that breaks its clearance (with no
//     confirmed jump) makes the next recompute drop it.
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
//  9. Sticky reservations: a WALK-predicted pad stays reserved until all of the
//     party's messages up to the one it was predicted for have arrived (then it
//     is either known used or proven unused). Jump-predicted pads follow Rule 6.
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
//   sticky    -- Rule 9: walk-predicted reservations are held until proven resolved
//   oppExempt -- Rule 3 refinement: on the lander's back side, pads merely reserved for
//                parties moving the opposite way (away from the node) are not obstacles
const OPT={sticky:true, oppExempt:true, stickyJumps:false};   // stickyJumps: comparison only -- also hold jump-predicted pads (i.e. no Rule 6)
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
function predBlocked(view,k,extra){
  const blocked=new Set(), hard=new Set(), resDir=new Map();
  if(view.used) for(const u of view.used){ blocked.add(u); hard.add(u); }
  for(const [id,o] of view.others){
    if(id===k||typeof id!=="number") continue;
    blocked.add(o.pos); hard.add(o.pos);
    for(const b of o.buf){ blocked.add(b); if(!resDir.has(b)) resDir.set(b,o.dir); }   // disjoint reservations
  }
  blocked.add(view.self.pos); hard.add(view.self.pos);
  if(extra) for(const e of extra){ blocked.add(e); hard.add(e); }
  for(const h of hard) resDir.delete(h);
  return {blocked,resDir};
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
function jumpTarget(dir,blocked,n,d,nodes,resDir){
  for(const M of nodes){
    const left=M,right=M+1; if(right>n) continue;
    if(blocked.has(left)&&blocked.has(right)) continue;   // fully occupied -> descend
    const cand = dir===+1 ? right : left;
    if(blocked.has(cand)) continue;                       // my slot taken -> descend
    const front = dir===+1 ? clearOutside(right,+1,blocked,n) : clearOutside(left,-1,blocked,n);
    const back = (OPT.oppExempt && resDir)
      ? (dir===+1 ? clearOutsideExempt(left,-1,blocked,n,resDir,-dir) : clearOutsideExempt(right,+1,blocked,n,resDir,-dir))
      : (dir===+1 ? clearOutside(left,-1,blocked,n) : clearOutside(right,+1,blocked,n));
    if(front > 2*d && back > 2*d) return cand;
  }
  return null;                                            // no valid node -> halt
}
function clearOutside(edge,step,blocked,n){let c=0,q=edge+step;while(q>=1&&q<=n&&!blocked.has(q)){c++;q+=step;}return c;}
// as clearOutside, but a pad reserved for a party moving in `awayDir` is treated as free
function clearOutsideExempt(edge,step,blocked,n,resDir,awayDir){let c=0,q=edge+step;while(q>=1&&q<=n&&(!blocked.has(q)||resDir.get(q)===awayDir)){c++;q+=step;}return c;}
function clearance(p,step,blocked,n){let c=0,q=p+step;while(q>=1&&q<=n&&!blocked.has(q)){c++;q+=step;}return c;}

// --- one step of a path: WALK if next linear pad free of `blocked`, else JUMP
// to the root-most VALID node. Returns {pad, jumped, face} or null (halt).
function stepOf(pos,dir,blocked,n,d,nodes,resDir){
  const lin=pos+dir;
  if(lin>=1 && lin<=n && !blocked.has(lin)) return {pad:lin,jumped:false,face:dir};  // walk
  const t=jumpTarget(dir,blocked,n,d,nodes,resDir);                                   // overlap -> jump
  if(t==null) return null;
  return {pad:t,jumped:true,face:dir};
}

// Public: a party's OWN next move, from its view (union-of-buffers occupancy).
function nextSlot(pos,dir,view,n,d,nodes){
  const {blocked,resDir}=occupancy(view);
  return stepOf(pos,dir,blocked,n,d,nodes,resDir);
}

// --- K's reserved buffer = FRESH prediction + HELD (sticky) pads.
//   fwd: K's next d pads from K's confirmed position, jump-aware, recomputed on
//        every occupancy change. Jump-predicted pads (a landing and the walk after
//        it) live only here, so an invalidated jumpspot drops (Rule 6).
//   held (Rule 9): every WALK-predicted pad (those before the first predicted jump)
//        is also remembered with the message # it was predicted for, and stays
//        reserved until all of K's messages up to that # have arrived (then the pad
//        is either known used, or proven unused). See deliverBuffer.
function refreshBuffer(observerView,k,n,d,nodes){
  const ko=observerView.others.get(k);
  if(!ko) return;
  let p=ko.pos, dir=ko.dir;
  const fwd=[]; let firstJump=-1;
  for(let s=0;s<d;s++){
    const {blocked,resDir}=predBlocked(observerView,k,fwd);
    const st=stepOf(p,dir,blocked,n,d,nodes,resDir);
    if(!st) break;                       // K would halt here -> predict nothing further
    if(st.jumped && firstJump<0) firstJump=fwd.length;
    fwd.push(st.pad);
    p=st.pad; if(st.jumped) dir=st.face;
  }
  ko.fwd=fwd;
  const buf=fwd.slice();
  if(OPT.sticky){
    const held=ko.held||(ko.held=new Map());          // pad -> message # it was predicted for
    const last=ko.lastNum||0, lin=(OPT.stickyJumps||firstJump<0)?fwd.length:firstJump;
    for(let i=0;i<lin;i++){ const q=fwd[i], s=last+1+i; if(!(held.get(q)>=s)) held.set(q,s); }
    const used=observerView.used;
    for(const [q] of held){ if(used&&used.has(q)) held.delete(q); else if(!buf.includes(q)) buf.push(q); }
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
    if(o.held) for(const [q,s] of o.held) if(s<=o.prefix) o.held.delete(q);
  }
  // else: older message -> pad is marked used above; position stays where it is
  for(const [id] of observerView.others){ if(typeof id==="number") refreshBuffer(observerView,id,n,d,nodes); }
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
  if(pred.length>k && pred[k]===pad){ kase="predicted"; for(let i=0;i<k;i++) marks.push(pred[i]); }
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

module.exports={bspNodes,initWorld,occupancy,buildBlocked,predBlocked,jumpTarget,stepOf,nextSlot,refreshBuffer,deliverBuffer,setSkipJumpPolicy,setOptions};
