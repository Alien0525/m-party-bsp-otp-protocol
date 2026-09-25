# OTPAC m=4 — Session Handoff / Resume Doc

Paste the **"RESUME PROMPT"** at the bottom into a fresh chat to continue. Everything above it is the context that prompt refers to.

---

## 0. What this project is

Academic cryptography paper + reference implementation, with **Prof. Giovanni Di Crescenzo** (advisor/co-author). Student: **Aman**.

**OTPAC** = One-Time-Pad Asynchronous Communication. `m` parties share a single random pad of `n` words `[1..n]`. Each party, on a Send, consumes one pad index (XOR the message with that pad word) and broadcasts a header carrying the index. **Security = no pad index is ever used by two Send events** (no one-time-pad reuse).

**Model (paper Section 2):**
- Broadcast network, **unbounded** async delays, **order not preserved**.
- Delay family `U^{m,n}_{A,d}`: **no Send event has `d` undelivered messages** (i.e. before a party sends, at most `d` messages addressed to it are still in flight). Reuse ⇒ some Send had ≥ `d+1` undelivered.
- Efficiency ratio `α` = fraction of pad used before deadlock; want `α → 1`.

## 1. The protocol we are building (individual-jump, m=4)

Two facing pairs over `[1..n]`: initial arenas `[1, n/2]` (P0→ at 1, P1← at n/2) and `[n/2+1, n]` (P2→ at n/2+1, P3← at n). Right-movers (dir +1): P0, P2. Left-movers (dir −1): P1, P3.

Core rules (all **stated by Aman**, verbatim intent):
- **Per-party jumps** (NOT per-pair). Whoever needs more pads jumps alone; a party that stops just stays put. Pairings therefore change over time.
- Each party keeps, **for every other party K**, a reserved **buffer** = the next `d` pad indices K might have consumed but that this observer hasn't heard yet (K's `d` pads ahead, in K's direction).
- **Walk vs jump trigger = overlap.** A party tries `pos+dir`. If free → walk. If `pos+dir` is reserved-for-another / used (a real wall) → **jump this step** (at the overlap, never at distance `d`).
- **Direction is preserved on a jump** (NOT inverted). Jump target = a **BSP node**, and the party keeps moving in its original direction after landing.
- **BSP node = a PAIR of center pads (M, M+1).** Left-mover takes **M**, right-mover takes **M+1** (fixed default side, so a left- and right-mover completing the same node **diverge**, never collide). Root-most = the shallowest node (breadth-first over the static tree) that is not fully occupied. A node is skipped only when **both** its pads are consumed.
- **Jump-target validity:** the landing pad needs `> 2d` free pads on **both** sides, measured **outside** the node's own two pads (a partner on the other slot is by design, not an obstacle). `>2d` (not `>d`) — see §3.
- **Walk-then-jump:** a jumper finishes its current arena first, then lands at the jumpspot and continues in the same direction.
- **Halting:** a party halts when no valid root-most node exists anywhere.

## 2. Paper's m=2 base (Section 3.4 of `april26v3.tex`) — the ground truth to match

This is **protocol A4** (Giovanni wrote it; the m=4 protocol must lift THIS structure). Each party keeps `PUbuffer` = `d` pads in the OTHER party's direction that might be undelivered.
- `I`: party1 → `myind=0, dir=+1, PU=(n, n-1, …, n-d+1)`; party2 → `myind=n+1, dir=-1, PU=(1, 2, …, d)`.
- `S`: `nextind = myind+dir`; if `nextind ∈ PU` → **HALT**; else `myind=nextind`, send it.
- `R(recind)`: find `recind` in PU, **remove it and shift**; append **exactly one** new pad `newpuind = PU[d-1] − dir`; if `dir*(newpuind − myind) ≤ 0` → **HALT**; else set `PU[d-1]=newpuind`.
- Key lemmas: **`le-new2p-buffer`** (any undelivered pad from the other party is ALWAYS in the buffer — holds under out-of-order delivery because R removes the *specific* received index and appends one) and **`le-new2p-secure`** (Send refuses any buffer pad ⇒ no reuse). "remove-1 / add-1 per receive ⇒ never more than 1 new pad reserved."

## 3. Where the code stands (files in /mnt/user-data/outputs/)

- **`otpac_trace.html`** — SELF-CONTAINED simulator + trace UI (push to GitHub / open directly). Inlined engine == `otpac_m4.js`. Controls: N, d, seed, delivery (worst/random/adversarial), sender order (random/rr/flood), max steps. Shows: pad strip (positions + each party's reserved buffers as colored ticks + **red ✕ on any reused pad** + consumed-pad history), per-party view panels (what each party believes about the others + reserved buffer + "N behind" staleness), a step scrubber, and a **filterable log** (by party, by event type walk/jump/halt/reuse). Status bar reports reuse + whether the ≤d invariant held.
- **`otpac_m4.js`** — Node module engine: `bspNodes, initWorld, occupancy, jumpTarget (uses >2d clearance measured outside the node), clearOutside, clearance, stepOf, nextSlot, refreshBuffer`. Driver logic (per-recipient delay `capQueues`, per-party views) lives in the HTML's `simulate()` and in helper scripts.
- Older/companion (superseded design, ignore unless asked): `index.html, protocol.js, style.css, test-suite.html, rootmost_experiment.py, april26v1.tex, Section4/5_*_derivations.tex`.

**Verified facts (Node engine and HTML `simulate()` agree, deterministic by seed):**
- Delivery invariant (≤ d undelivered) holds in 100% of runs (independent tracker: 0 violations).
- Relative drift between two observers' view of the same party is **≤ 2d in MESSAGES** (measured max 2 for d=2), but **unbounded in PADS across an undelivered jump** (one jump message ⇒ ~n/2 pad displacement; measured pad-drift up to 148). This is why `>2d` *pad* clearance provably absorbs WALK disagreements but not JUMP ones.
- Bugs already FOUND & FIXED across the session: (a) buffer poisoning itself (a party's own future pads treated as obstacles), (b) delivery model not enforcing ≤d continuously, (c) not seeding used/consumed pads, (d) jump trigger firing at distance d instead of at overlap (premature jumps), (e) node-as-unit / both-pads / default-side, (f) clearance counting the node's own partner pad, (g) raised clearance `>d → >2d` (Aman's idea: cut reuse 2.3%→0.7%, efficiency held ~97.7%).
- Current reuse rate: **~2/300 seeds** at n=256, d=2, worst delivery, random sender. Repro seeds: **81 and 195** (also 1 reaches min facing-gap 0).

## 4. THE CURRENT OPEN BUG (this is where we stopped)

**Symptom (seed 81, n=256, d=2, worst, random):** two facing parties converge and both end up able to use the same pad. Concretely: P3 (←) and P2 (→) approach; P3 truly at 193, P2 truly at 195 (or similar), and both contest pad **194** → reuse (P3 consumes 194, P2's next legal step is also 194). Min facing-gap across runs reaches **0** (adjacent), which should never happen — parties should stay `> d` apart.

**Root cause identified (agreed):** my `refreshBuffer` **recomputes** a party's whole buffer from its last-received position every receive. That silently **assumes in-order delivery**, so under reordering a genuinely-undelivered pad can be absent from the buffer → Lemma `le-new2p-buffer` fails → Send is no longer protected → the contest slips through. The paper's `R` instead does strict **remove-the-received-index-and-append-exactly-one** (a sliding window robust to out-of-order delivery). **My buffer layer must be reimplemented to match the paper's `R` exactly.**

## 5. THE PENDING FIX WE JUST AGREED ON (implement this next)

Aman's refinement, on top of matching the paper's `R`:

**Reservations for different parties must be allowed to OVERLAP (a pad may sit in the reserved buffer of more than one party at once).** Right now my code treats a pad reserved for P0 as "taken," so when extending P3's buffer it skips that pad — which is why P2 reserved 195 for P0 but NOT for P3, and thus never reserved 194 for P3, allowing the contest.

Rules to implement:
1. A pad reserved for party A does **not** block that pad from also being reserved for party B. Each party's buffer is maintained independently; buffers may share pads. (P2 should reserve 195 for BOTH P0 and P3, because P2 cannot be sure P0's *predicted* jump to 195 will actually happen — P0 may never jump, P3 may never have reserved it. Duplication is harmless: it only makes the sender MORE conservative about what it will send.)
2. Another party's reservation **must not by itself trigger a jump** when extending a buffer. A jump is triggered only by a genuine wall (the facing partner's real approach / used pads / no room). If there is **no new root-most jumpspot available**, keep extending the buffer **linearly** even through pads reserved for other parties.
3. Keep the paper's `R` maintenance (remove-1/append-1, out-of-order-safe) as the underlying per-(observer, party) buffer mechanic, with the append rolling onto the jump target only when the party would genuinely jump.

**MUST re-test after implementing** (Aman is rightly cautious it may create new issues):
- Does a pad reserved for two parties, then actually used by one, ever hide a real conflict? (Check the ground-truth `used` map still catches any true double-write.)
- Re-run seeds 81, 195, and the full 0–300 sweep (n=256, d=2, worst + random + adversarial). Report reuse count, min facing-gap, efficiency, and confirm the ≤d invariant still holds (independent tracker).
- Confirm the earlier-fixed seeds (18, 57, 112, 114, 127) stay clean.

## 6. Build order (Aman's standing instruction)

1) get the protocol/implementation correct → 2) run tests → 3) THEN write the paper (m=4 and m=2^ℓ sections of `april26v3.tex` are still stubs; only §3.4 m=2 is written). Do NOT write paper sections until the implementation is verified.

Paper compile note: `april26v3.tex` is `llncs`; compile via article-class workaround; **no amsmath** → use `\frac` not `\tfrac`, `\mbox` not `\text`.

## 7. Access notes

- Aman's real repo is local (assistant has NO access): `/Users/amanns/Documents/crypto-paper/...`. Delivered files are drop-in replacements he pushes to GitHub and verifies via the HTML.
- Deterministic repro: everything is seeded (`mulberry32(seed)`), so HTML and Node give identical results for the same (n, d, seed, mode, sender).

---

## RESUME PROMPT (paste this into a fresh chat, and attach `otpac_trace.html` + `otpac_m4.js`)

> I'm continuing work on my OTPAC m=4 async one-time-pad simulator (crypto paper with Prof. Giovanni). I'm attaching the current `otpac_trace.html` (self-contained sim + trace UI) and `otpac_m4.js` (engine), plus a handoff doc `OTPAC_HANDOFF.md` that has the full design, the current open bug, and the exact fix we agreed on. **Please read OTPAC_HANDOFF.md first**, especially §4 (open bug) and §5 (pending fix).
>
> Do NOT rewrite everything or start patching blindly — the handoff explains the design rules precisely; follow them. Ask me before assuming any rule you're unsure about (I've caught many implementation mis-reads; the protocol itself has been correct).
>
> **Task:** implement the §5 fix — (1) reimplement the per-(observer, party) buffer to match the paper's Section 3.4 `R` procedure exactly (remove-the-received-index-and-append-exactly-one, out-of-order safe), and (2) allow reservations for different parties to OVERLAP (a pad can be reserved for more than one party; another party's reservation neither blocks a buffer from also covering that pad nor by itself triggers a jump; if no new root-most jumpspot exists, extend the buffer linearly through others' reserved pads). Keep everything else (overlap-trigger, node-as-unit, default side M/M+1, `>2d` clearance measured outside the node, per-recipient ≤d delivery).
>
> Then **re-test**: seeds 81 and 195 (n=256, d=2, worst delivery, random sender) must go clean; run the 0–300 seed sweep and report reuse count, min facing-gap (should never drop below d), efficiency, and confirm the ≤d delivery invariant still holds via an independent staleness tracker; confirm previously-fixed seeds 18/57/112/114/127 stay clean. Update `otpac_trace.html` and `otpac_m4.js` and give them back to me to push. If new reuse appears, give me the exact repro (seed + the two jumps/walks) so I can analyze the log — don't declare it fundamental.
>
> Context recap of the immediate bug: two facing parties (e.g. P2→ and P3←) converge and both contest one pad (e.g. 194) because my buffer recompute assumes in-order delivery and drops a still-undelivered pad, and because reservations for different parties are wrongly mutually-exclusive so P2 reserved 195 for P0 but not also for P3. The paper's m=2 §3.4 handles the 2-party version via the buffer invariant `le-new2p-buffer` (any undelivered pad is always in the buffer). Match that.
