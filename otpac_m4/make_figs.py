#!/usr/bin/env python3
"""Figures for the paper's evaluation section, from the test-suite results.

usage: python3 make_figs.py [suite_results.jsonl] [outdir]
Writes eff_n_d.pdf (efficiency vs n and vs d) and eff_mode_sched.pdf (by delivery
adversary and sender order). Every run counts: a run halted in an edge case counts
its remaining pads as wasted.
"""
import json, sys, os
from collections import defaultdict
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

SRC = sys.argv[1] if len(sys.argv) > 1 else "suite_results.jsonl"
OUT = sys.argv[2] if len(sys.argv) > 2 else "paper/figs"
os.makedirs(OUT, exist_ok=True)

plt.rcParams.update({
    "font.family": "serif", "font.serif": ["DejaVu Serif"], "mathtext.fontset": "dejavuserif",
    "font.size": 7.5, "axes.titlesize": 8, "axes.labelsize": 7.5, "legend.fontsize": 6.5,
    "xtick.labelsize": 6.5, "ytick.labelsize": 6.5, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": "#e2e2e2", "grid.linewidth": 0.5, "axes.axisbelow": True,
    "savefig.bbox": "tight", "savefig.pad_inches": 0.02, "pdf.fonttype": 42, "lines.linewidth": 1.4,
})
# validated categorical slots (light mode): blue, orange, aqua, yellow
C1, C2, C3, C4 = "#2a78d6", "#eb6834", "#1baf7a", "#eda100"
INK2 = "#555555"
W = 4.8  # llncs text width in inches

R = [json.loads(l) for l in open(SRC) if l.strip()]
mean = lambda a: sum(a) / len(a)

def group(rs, key):
    g = defaultdict(list)
    for r in rs: g[key(r)].append(r)
    return g

def st(rs):
    inst = [r["eff"] for r in rs if r["mode"] == "instant"]
    return dict(mean=mean([r["eff"] for r in rs]), min=min(r["eff"] for r in rs), sync=min(inst) if inst else None)

# ---------------------------------------------------------------- efficiency vs n (d=2) and vs d
fig, (a1, a2) = plt.subplots(1, 2, figsize=(W, 1.9))
g = group([r for r in R if r["d"] == 2], lambda r: r["n"])
ns = sorted(g); S = [st(g[n]) for n in ns]
a1.plot(ns, [s["mean"] for s in S], "-o", ms=2.6, color=C1, label="mean")
a1.plot(ns, [s["sync"] for s in S], "-s", ms=2.4, color=C3, label="worst, synchronous")
a1.plot(ns, [s["min"] for s in S], "-^", ms=2.6, color=C2, label="worst, any delivery")
a1.set_xscale("log", base=2)
tk = [16, 64, 256, 1024]
a1.set_xticks(tk); a1.set_xticklabels([str(t) for t in tk]); a1.minorticks_off()
a1.set_xlabel("pad size $n$ ($d=2$)")
a1.set_ylabel("efficiency ratio")
a1.set_ylim(0, 1.02)
a1.legend(loc="lower right", frameon=False, handlelength=1.6)
a1.set_title("(a) growing $n$", loc="left")

for col, n, mk in [(C1, 64, "o"), (C3, 128, "s"), (C4, 256, "D"), (C2, 512, "^")]:
    gd = group([r for r in R if r["n"] == n], lambda r: r["d"])
    ds = sorted(gd)
    if len(ds) < 2: continue
    a2.plot(ds, [st(gd[d])["mean"] for d in ds], "-" + mk, ms=2.4, color=col, label=f"$n={n}$")
a2.set_xscale("log", base=2)
a2.set_xticks([1, 2, 4, 8, 16, 32, 64, 128]); a2.set_xticklabels(["1", "2", "4", "8", "16", "32", "64", "128"]); a2.minorticks_off()
a2.set_xlabel("buffer bound $d$ (mean over runs)")
a2.set_ylim(0, 1.02)
a2.legend(loc="lower left", frameon=False, handlelength=1.6)
a2.set_title("(b) growing $d$", loc="left")
fig.tight_layout(w_pad=1.2)
fig.savefig(f"{OUT}/eff_n_d.pdf"); plt.close(fig)

# ---------------------------------------------------------------- by delivery adversary and by sender order (tier A)
A = [r for r in R if r.get("tier") == "A"]
MODES = ["instant", "worst", "random", "adversarial", "lifo", "randcap", "shuffle", "target-sender", "target-recv"]
SCHEDS = ["random", "rr", "flood", "flood-rev", "skew", "arena-skew", "burst", "silent1", "silent2", "pair-alt", "greedy-gap", "stale-max"]
fig, (b1, b2) = plt.subplots(1, 2, figsize=(W, 2.15), gridspec_kw={"width_ratios": [1, 1]})
for ax, key, order, title in [(b1, "mode", MODES, "(a) delivery adversary"), (b2, "sched", SCHEDS, "(b) sender order")]:
    gg = group(A, lambda r: r[key])
    order = [k for k in order if k in gg]
    s = [st(gg[k]) for k in order]
    y = list(range(len(order)))[::-1]
    ax.barh(y, [x["mean"] for x in s], height=0.62, color=C1, label="mean")
    ax.plot([x["min"] for x in s], y, "|", ms=6, mew=1.3, color=C2, label="worst run")
    ax.set_yticks(y); ax.set_yticklabels(order)
    ax.set_xlim(0.6, 1.0); ax.set_xticks([0.6, 0.7, 0.8, 0.9, 1.0])
    ax.grid(axis="y", visible=False)
    ax.set_title(title, loc="left")
    ax.set_xlabel("efficiency ratio")
h, l = b1.get_legend_handles_labels()
fig.tight_layout(w_pad=1.0, rect=(0, 0.07, 1, 1))
fig.legend(h, l, loc="lower center", ncol=2, frameon=False, handlelength=1.4, bbox_to_anchor=(0.5, -0.01))
fig.savefig(f"{OUT}/eff_mode_sched.pdf"); plt.close(fig)
print("figures written to", OUT)
