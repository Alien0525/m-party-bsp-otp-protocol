# Verification of protocol A5 under Giovanni's three schedule families (2026-10-08)

**Rules tested:** R1–R10, the rules in force on 2026-10-08. The current rules (R1–R9 and R11) are covered in TEST_REPORT.md.

**Short answer: in some cases there was pad reuse.**

- The exhaustive search finds a pad reuse at n = 24, d = 1, after only 16 sends.
- The probabilistic schedules find reuses at every pad size tested, from n = 32 to n = 512.

All failures have the same cause, described in the [root cause](#root-cause) section below.

**Convention.** Throughout, d is the **maximum number of messages that may be undelivered to a party when it sends**. This is what the test suite enforces. The paper's family U_d forbids d undelivered messages, so it allows only d − 1. Our "d = 1" is therefore the paper's U_2. Both should use one convention before the paper is final.

## (1) All possible sequences, small n and d — `verify_exhaustive.js`

The search runs a DFS over the global state, and identical states are explored only once.

**Fixed delivery adversary, every send order.** This is the family exactly as Giovanni asked. It covers every send order under three fixed adversaries:

- `worst`: maximal delay, releasing the oldest message;
- `lifo`: releasing the newest message;
- `instant`: synchronous delivery.

| n | d | worst: reuse | lifo: reuse | instant: reuse | exact worst-case efficiency (worst / lifo / instant) |
|---|---|---|---|---|---|
| 16 | 1 | 0 | 0 | 0 | 0.688 / 0.625 / 0.625 |
| 20 | 1 | 0 | 0 | 0 | 0.750 / 0.700 / 0.700 |
| **24** | **1** | **564 executions** | 0 | 0 | 0.708 / 0.708 / 0.750 |
| **28** | **1** | **1,612 executions** | 0 | 0 | 0.679 / 0.714 / 0.714 |
| 32 | 1 | (search too large) | – | 0 | – / – / 0.750 |
| 16 – 32 | 2 | 0 | 0 | 0 | e.g. n=32: 0.781 (worst) |

Two further points about these results:

- **No jumps below these sizes.** A landing needs more than 4d+3 consecutive free pads, and an arena has only n/2 − 2 interior pads. So no jump is possible for n ≤ 20 at d = 1, and only barely for n ≤ 32 at d = 2.
  - Those runs exercise only walking, and walking is safe in every case.
  - The failures start exactly where jumps become possible.
- **Every send order and every delivery order.** This is full model checking. It is only feasible for tiny n:
  - n = 8, d = 1: 4,479 states, no reuse, worst-case efficiency 0.25;
  - n = 12: more than 2 million states without finishing.
  - At these sizes no jump is possible, so this mode adds nothing beyond walking.

## (2) Party x sends with probability p_x — `verify_prob.js`

**The vectors.** Taking p_1, p_2, p_3 in 0, 0.1, …, 1 gives 11³ = 1,331 combinations. Only **286** of them leave p_4 ≥ 0 so that the vector sums to 1, and those are the ones used.

**Setup.** Each vector was run under all 9 delivery adversaries for several (n, d) and seeds, for **41,184 runs** in total. If the chosen party has halted, the probabilities are renormalised over the parties still running.

| n, d | runs | runs with a reuse | efficiency min / mean |
|---|---|---|---|
| 32, 1 | 7,722 | 2 | 0.563 / 0.785 |
| 64, 1 | 7,722 | 12 | 0.688 / 0.880 |
| 64, 2 | 7,722 | 34 | 0.625 / 0.853 |
| 128, 2 | 7,722 | 41 | 0.727 / 0.916 |
| 256, 2 | 5,148 | 37 | 0.797 / 0.952 |
| 256, 8 | 2,574 | 13 | 0.668 / 0.867 |
| 512, 2 | 2,574 | 29 | 0.867 / 0.972 |
| **total** | **41,184** | **168 (0.41%)** | |

**Where the reuses occur.**

- **Number of senders.** No reuse occurs with a single sending party. Reuses occur in 122 of the 286 vectors, including very skewed ones such as (0, 0, 0.1, 0.9).
- **Delivery adversary.** Reuses occur only under adversaries that delay messages:

  | Adversary | Runs with a reuse |
  |---|---|
  | worst | 76 |
  | randcap | 41 |
  | adversarial | 33 |
  | shuffle | 12 |
  | random | 6 |
  | instant, lifo, target-sender, target-recv | 0 |

## (3) Schedule (2) until close to full or close to each other, then (1) — `verify_hybrid.js`

**Switch point.** Schedule (2) runs until one of two conditions holds, then the search switches to the exhaustive mode:

- (3a) at least 85% of the pads are used;
- (3b) some party has another party ahead of it in its direction within 2d+2 pads.

**Exhaustive phase.** From that exact state (positions, every party's view, messages in flight), the search explores:

- every send order and every delivery order for the next few sends;
- every send order under the `worst` and `lifo` adversaries for a longer window.

**Coverage.** Exhaustive search to completion is infeasible beyond n ≈ 30, so the windows are bounded. The coverage is reported.

**Setup.** The probability vectors are the 0.2-step grid (52 vectors with at least two senders). The prefix runs under the `random` and `worst` adversaries, giving 104 prefixes per (n, d) and trigger.

| n, d | trigger | prefixes reaching the switch point | switch states from which some continuation reuses a pad |
|---|---|---|---|
| 64, 1 | 3a (85% used) | 64 / 104 (the rest halted earlier) | 0 |
| 64, 1 | 3b (parties close) | 104 / 104 | **29** (worst: 29, lifo: 2) |
| 128, 2 | 3a | 101 / 104 | **3** (every delivery order: 1, worst: 3, lifo: 3) |
| 128, 2 | 3b | 104 / 104 | 0 |

**Window sizes.**

| n | Every send and delivery order | `worst` and `lifo` |
|---|---|---|
| 64 | next 4 sends | next 8 sends |
| 128 | next 3 sends | next 6 sends |

**Completeness.**

- **`worst` and `lifo` windows.** Explored completely.
- **Every-delivery-order windows.** Complete for 3a at n = 64. Partly cut off by the state budget otherwise: 59 of 101 complete for 3a at n = 128; 0 of 104 and 39 of 104 for 3b at n = 64 and n = 128.

**Example, n = 64, d = 1** (prefix p = (0, 0.2, 0.2, 0.6), `random` delivery, switched at step 37 under 3b):

1. **C jumps.** C jumps to 17.
2. **D jumps.** D, a left-mover, jumps to 8, the left slot of node ⟨8,9⟩.
3. **B jumps onto D's slot.** B, also a left-mover, walks to 19, is blocked, and jumps. It has not heard D's jump, so it picks the same slot 8. **Reuse.**

This is the same mechanism as in the minimal counterexample below. B's choice of node depends on news it has not received yet.

## A minimal counterexample (n = 24, d = 1, adversary `worst`)

Parties are A, B (arena [1,12], A moves right, B moves left) and C, D (arena [13,24], C moves right, D moves left).

1. **A walks.** A sends on pads 2, 3, …, 10.
2. **A jumps.** At pad 10, A's next pad 11 is reserved for B in A's view, so A jumps. The root-most valid node is ⟨18,19⟩, and as a right-mover A lands on **19**.
3. **B jumps, without knowing A did.** B has heard A up to pad 10 but not the jump. So B believes A is at 10 and about to take pad 11, and B jumps too. As a left-mover, B lands on **18** of the same node.
4. **C mispredicts B.** C *has* heard A's jump (A at 19) but not B's. In C's view pad 11 is free for B, so C predicts that B walks to 11 and reserves 11 for B.
5. **C walks into B's landing.** C walks 14, 15, 16, 17 and then uses **18**, B's landing pad. **Reuse.**

Throughout, at most one message (B's jump) is undelivered to C at each of C's sends, so the run is inside the model.

## Root cause

Whether a party walks or jumps depends on what it has heard about a *third* party. Here, B jumps only because it has not yet heard that A jumped away.

An observer (C) predicts that decision using its *own* knowledge of the third party, which can be newer or older than the knowing party's (B's). The bound d limits how many messages are undelivered to C when C sends. It does not limit how far C can walk while one message, B's jump, stays undelivered. So an incorrect prediction is not caught by the >2d clearance.

The paper's "prediction agreement" condition is exactly what fails. Every reuse in all three families is a jump that some observer predicted differently. Rules R3, R9 and R10 shrink the gap but cannot close it.

## Possible fixes (not implemented; for discussion)

1. **Reserve for every view the other party could have.**
   - **Rule.** When C predicts B, it also considers that B's view of each third party may lag C's own by up to d messages, and reserves the union of B's possible next pads.
   - **Example.** In the counterexample C would reserve both 11 (if B walks) and 18 (if B believes A is still at 10 and jumps), and would stop at 17.
   - **Cost.** More reserved pads, so lower efficiency.
2. **Base walk-or-jump decisions only on information every party is guaranteed to have.** For example, a decision could use only pads used at least d messages earlier. Then observers can reproduce the decision.
3. **Halt on detected contention and abandon the contested region.** This is Giovanni's earlier suggestion: it trades pads for security.

## Files

- `verify_exhaustive.js`: exhaustive search.
  - `node verify_exhaustive.js <n> <d> [maxStates] [all|worst|lifo|instant]`
  - `all` explores every delivery order as well as every send order.
- `verify_prob.js`: schedule (2).
  - `node verify_prob.js [workers] [n:d:seeds,...]`
- `verify_hybrid.js`: schedule (3).
  - `GRID=5 WIN_ALL=4 WIN_POL=8 node verify_hybrid.js [workers] [n:d,...] [budget]`
- `otpac_test_suite.js`: gained two things.
  - The `prob` schedule (`cfg.p`).
  - A `switchWhen` hook that hands the current global state to the exhaustive checker, plus `cfg.log` for event traces.
