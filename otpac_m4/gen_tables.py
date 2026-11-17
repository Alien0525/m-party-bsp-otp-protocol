#!/usr/bin/env python3
"""LaTeX number macros and the efficiency table for the paper, from the test-suite results.

usage: python3 gen_tables.py [suite_results.jsonl] [out.tex] [suite_3p.jsonl] [suite_norecheck.jsonl] [interleave_4p.json]
The \\JRHOTXT sentence of the efficiency section uses the per-run jump count J and
slack rho that the suite records.
Every run counts in the efficiency figures; a run halted in an edge case counts its
remaining pads as wasted.
"""
import json, sys, os
from collections import defaultdict

SRC = sys.argv[1] if len(sys.argv) > 1 else "suite_results.jsonl"
OUT = sys.argv[2] if len(sys.argv) > 2 else "paper/tables_m4.tex"
SRC3 = sys.argv[3] if len(sys.argv) > 3 else None      # 3-party runs (P3 silent)
SRCNR = sys.argv[4] if len(sys.argv) > 4 else None     # runs without the re-check of Rule 4(b)
SRCIL = sys.argv[5] if len(sys.argv) > 5 else None     # interleave.js output: other Sends between announcements

R = [json.loads(l) for l in open(SRC) if l.strip()]
A = [r for r in R if r.get("tier") == "A"]
mean = lambda a: sum(a) / len(a)
f3 = lambda x: f"{x:.3f}"
num = lambda x: f"{x:,}".replace(",", "{,}")

def group(rs, key):
    g = defaultdict(list)
    for r in rs: g[key(r)].append(r)
    return g

def st(rs):
    inst = [r["eff"] for r in rs if r["mode"] == "instant"]
    return dict(n=len(rs), mean=mean([r["eff"] for r in rs]), min=min(r["eff"] for r in rs),
                sync=min(inst) if inst else None, waste=mean([r["n"] - r["used"] for r in rs]))

out = []
M = lambda name, val: out.append(f"\\newcommand{{\\{name}}}{{{val}}}")
M("NRUNS", num(len(R)))
gnd = group(R, lambda r: (r["n"], r["d"]))
out.append("\\newcommand{\\EFFMEANn}[1]{\\csname effmean#1\\endcsname}")
for (n, d), v in gnd.items():
    if d == 2:
        out.append(f"\\expandafter\\def\\csname effmean{n}\\endcsname{{{f3(st(v)['mean'])}}}")
big = st(gnd[(2048, 2)])
M("EFFMEANBIG", f3(big["mean"])); M("EFFSYNCBIG", f3(big["sync"])); M("EFFMINBIG", f3(big["min"]))
M("WASTEBIG", f"{big['waste']:.0f}"); M("WASTESMALL", f"{st(gnd[(256, 2)])['waste']:.0f}")
mm = [st(v)["mean"] for v in group(A, lambda r: r["mode"]).values()]
M("EFFMODELO", f3(min(mm))); M("EFFMODEHI", f3(max(mm)))

# halts for reuse (edge cases of the security section)
nre = sum(1 for r in R if r.get("reuse"))
M("NREUSE", num(nre)); M("PREUSE", f"{100*nre/len(R):.2f}")

# announcements (Rule 4): rounds, clashes, failed re-checks, announcement messages per run
def annstats(rs):
    a = [r["ann"] for r in rs if r.get("ann")]
    return dict(rounds=mean([x["rounds"] + x["clash"] + x["recheck"] for x in a]), msgs=mean([x["msgs"] for x in a]),
                clash=sum(x["clash"] for x in a), recheck=sum(x["recheck"] for x in a))
an = annstats(R)
M("EFFALL", f3(mean([r["eff"] for r in R])))
M("ANNROUNDS", f"{an['rounds']:.1f}"); M("ANNMSGS", f"{an['msgs']:.1f}")
M("ANNCLASH", num(an["clash"])); M("ANNRECHECK", num(an["recheck"]))
for src, tag in ((SRC3, "THREE"), (SRCNR, "NORECHECK")):
    if not src: continue
    X = [json.loads(l) for l in open(src) if l.strip()]
    M("NRUNS" + tag, num(len(X))); M("NREUSE" + tag, num(sum(1 for r in X if r.get("reuse"))))
    M("EFFALL" + tag, f3(mean([r["eff"] for r in X]))); M("ANNMSGS" + tag, f"{annstats(X)['msgs']:.1f}")

itxt = ""
if SRCIL:
    I = json.load(open(SRCIL)); h = {int(k): v for k, v in I["hist"].items()}; tot = sum(h.values())
    srt = sorted(k for k in h for _ in range(h[k])); q = lambda p: srt[min(len(srt) - 1, int(p * len(srt)))]
    w = I["worst"]
    itxt = (f"In {num(I['runs'])} of the four-player runs we recorded every announcement round ({num(tot)} rounds). "
            f"The number of other players' {{\\sf Send}} events between the first and the last announcement of a round "
            f"had median {q(0.5)}, was at most {q(0.9)} in 90\\% of the rounds and at most {q(0.99)} in 99\\%; the maximum, "
            f"{I['maxIn']}, occurred under the sender order {{\\em {w['sched']}}}. In {num(I['runsBoth'])} of these runs two players "
            f"had announcement rounds open at the same time. Rule 4 does not rely on the announcements being close together "
            f"in the send sequence: the jumping player lands only if no other player's announcement of the same pad is still "
            f"in force in its view and the spot is still valid.")
M("INTERLEAVETXT", itxt)

# J and rho: from the per-run counters the suite records (jumps, rho), over runs
# with d <= 16 that ended normally (all players halted, no reuse); a separate
# instrumented run (jstat.json) is no longer needed
txt = ""
rows = [r for r in R if not r.get("reuse") and not r.get("timeout") and r["d"] <= 16 and "jumps" in r]
if rows:
    def jm(n): v = [r["jumps"] for r in rows if r["n"] == n and r["d"] == 2]; return mean(v) if v else float("nan")
    bound = lambda r: 4 + r["rho"] + (r["jumps"] + r["rho"] + 2) * (16 * r["d"] + 18)
    worst = max((r["n"] - r["used"]) / bound(r) for r in rows)
    rhod = mean([r["rho"] / r["d"] for r in rows])
    txt = (f"In the {num(len(rows))} runs with $d\\le16$ that ended without a reuse, the number of jumps $J$ "
           f"grew slowly with $n$: for $d=2$ its mean rose from {jm(64):.1f} at $n=64$ to {jm(2048):.1f} at $n=2048$ "
           f"(maximum {max(r['jumps'] for r in rows)} over all runs); $\\rho$ stayed $O(d)$, about ${rhod:.1f}d$ on average; "
           f"and the waste never exceeded {100*worst:.0f}\\% of the bound of Theorem~\\ref{{th-a5-eff}}.")
M("JRHOTXT", txt)

# efficiency table
sel = [(64, 2), (128, 2), (256, 2), (512, 2), (1024, 2), (2048, 2), (128, 8), (512, 8), (2048, 8), (512, 16), (256, 32), (256, 63)]
rows = []
for n, d in sel:
    if (n, d) not in gnd: continue
    s = st(gnd[(n, d)])
    rows.append(f"{n} & {d} & {num(s['n'])} & {f3(s['mean'])} & {f3(s['sync'])} & {f3(s['min'])} \\\\")
out.append(r"""\newcommand{\TabEff}{%
\begin{table}[!htb]
\caption{Efficiency ratio by pad size $n$ and buffer bound $d$, over all delivery
adversaries and sender orders: the mean, the worst run under synchronous
delivery, and the worst run overall.}
\label{tab:eff}
\centering\small\setlength{\tabcolsep}{7pt}
\begin{tabular}{rrrccc}
\hline
$n$ & $d$ & runs & mean & worst (sync.) & worst (any) \\
\hline
""" + "\n".join(rows) + r"""
\hline
\end{tabular}
\end{table}}""")

os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
with open(OUT, "w") as f:
    f.write("% generated by gen_tables.py from " + os.path.basename(SRC) + " -- do not edit by hand\n")
    f.write("\n".join(out) + "\n")
print("wrote", OUT)
