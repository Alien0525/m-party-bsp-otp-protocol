# One-Time-Pad Asynchronous Communication (OTPAC) protocols

Code, simulators and paper sources for the OTPAC paper by G. Di Crescenzo and Aman N. S.

The repository has two parts:

| Folder | What it is |
|---|---|
| [`otpac_m4/`](otpac_m4/) | **Current work.** Protocol A5 for m = 4 parties: per-party reserved buffers, individual jumps over a static BSP tree, up to d undelivered messages per party (Rules R1–R9 and R11). Includes the engine, the visualizer, the test suite and the paper. |
| [`old_protocol/`](old_protocol/) | The earlier m-party paired-jump BSP protocol, with its visualizer, test suite, experiment and derivation notes. See its own [README](old_protocol/README.md). |

The root `index.html` links to both visualizers (GitHub Pages).

## `otpac_m4/`

| File | Purpose |
|---|---|
| `index.html`, `app.js`, `style.css` | Interactive visualizer. Same look as the old one, but it runs protocol A5: choose n, d, a delivery adversary and a message sequence, then step through sends and inspect each party's view (believed positions, reserved and held pads). |
| `otpac_trace.html` | Step-by-step tracer. Replays any test-suite case (n, d, seed, delivery mode, sender order) with every party's view at every step. |
| `otpac_m4.js` | The protocol engine (Rules R1–R9 and R11; the old Rule 10 is kept only as an option, off by default). It is used by Node and by both pages. |
| `otpac_test_suite.js` | Test suite: 35,964 runs over 9 delivery adversaries × 12 sender orders. Run `node otpac_test_suite.js` (about 75 min on 2 cores). |
| `analyze_suite.js` | Post-analysis of the suite results. |
| `make_figs.py`, `make_fig_state.py`, `gen_tables.py` | Regenerate the paper's figures and tables from the suite results. |
| `TEST_RESULTS.md` | Detailed results and history of the rules. |
| `verify_exhaustive.js`, `verify_prob.js`, `verify_hybrid.js` | Checks for Prof. Di Crescenzo's schedules: every send sequence for small n and d; party x sends with probability p_x; and a probabilistic prefix followed by every continuation. |
| `dump_state.js` | Replays a visualizer run headlessly and dumps the state for the paper's state figure. |
| `paper/` | Paper sources (`april26v3 (1).tex`), figures (`paper/figs/`) and a compiled preview. |
| `OTPAC_HANDOFF.md` | Project handoff notes. |
