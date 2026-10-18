#!/usr/bin/env python3
"""Paper Figure: a snapshot of protocol A5 from the visualizer (otpac_m4/index.html).

Reads paper/figs/state.json (dumped from the page: n=128, d=2, delivery worst, sequence
A30B30, seed 7, after 78 Sends) and draws the pad as two rows in a print-friendly style:
used pads coloured by party, current positions labelled, the pads that party C
reserves for the others hatched, and the shared landing node <96,97>.
usage: python3 make_fig_state.py [paper/figs/state.json] [paper/figs/state.pdf]
"""
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

SRC = sys.argv[1] if len(sys.argv) > 1 else "paper/figs/state.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "paper/figs/state.pdf"
S = json.load(open(SRC))
n = S["n"]
plt.rcParams.update({"font.family": "serif", "font.serif": ["DejaVu Serif"], "font.size": 8, "pdf.fonttype": 42})
COL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]          # validated categorical slots 1-4
LET = ["A", "B", "C", "D"]
used = {p: o for p, o in S["used"]}
pos = {p: i for i, (p, _) in enumerate(S["pos"])}
res = {}
for k, pads in S["res"].items():
    for q in pads:
        res.setdefault(q, int(k))
land = {l["pad"]: l for l in S["landings"]}

per_row = n // 2
fig, ax = plt.subplots(figsize=(4.8, 1.7))
cw, ch, gap_row = 1.0, 1.0, 1.9
for idx in range(1, n + 1):
    r = (idx - 1) // per_row
    c = (idx - 1) % per_row
    x, y = c * cw, -r * (ch + gap_row)
    face, edge, hatch, lw = "white", "#bbbbbb", None, 0.4
    if idx in used:
        face, edge = COL[used[idx]], "white"
    if idx in res and idx not in used and idx not in pos:
        face, edge, hatch, lw = "white", COL[res[idx]], "//////", 0.6
    ax.add_patch(Rectangle((x + 0.06, y), cw - 0.12, ch, facecolor=face, edgecolor=edge, lw=lw, hatch=hatch))
    if idx in pos:
        p = pos[idx]
        ax.add_patch(Rectangle((x + 0.06, y), cw - 0.12, ch, facecolor=COL[p], edgecolor="black", lw=0.9))
        ax.text(x + 0.5, y + 0.5, LET[p], ha="center", va="center", fontsize=6.4, color="white", fontweight="bold")
    elif idx in land:
        ax.text(x + 0.5, y + 0.5, "J", ha="center", va="center", fontsize=6, color="white", fontweight="bold")
# pad numbers under each row
for r in range(2):
    for idx in [1 + r * per_row, 16 + r * per_row, 32 + r * per_row, 48 + r * per_row, per_row + r * per_row]:
        c = (idx - 1) % per_row
        ax.text(c * cw + 0.5, -r * (ch + gap_row) + ch + 0.15, str(idx), ha="center", va="bottom", fontsize=6.6, color="#555")
    ax.text(-0.6, -r * (ch + gap_row) + 0.5, f"arena {r + 1}", ha="right", va="center", fontsize=7, color="#333")
# arena boundary and landing node
lp = sorted(land)
if lp:
    r = (lp[0] - 1) // per_row
    c0 = (lp[0] - 1) % per_row
    y = -r * (ch + gap_row)
    ax.plot([c0 * cw + 0.06, (c0 + len(lp)) * cw - 0.06], [y - 0.2] * 2, color="black", lw=0.7)
    M = min(l["node"] for l in S["landings"])
    ax.text((c0 + len(lp) / 2) * cw, y - 0.32, f"BSP node ⟨{M},{M + 1}⟩: B (←) landed on {M}, A (→) on {M + 1}", ha="center", va="top", fontsize=7)
ax.set_xlim(-5.2, per_row * cw + 0.3)
ax.set_ylim(-(ch + gap_row) - 1.3, ch + 1.0)
ax.set_aspect("equal")
ax.axis("off")
# legend
hs = [Rectangle((0, 0), 1, 1, facecolor=COL[i], edgecolor="white") for i in range(4)]
hs += [Rectangle((0, 0), 1, 1, facecolor="white", edgecolor="#777", hatch="//////", lw=0.6),
       Rectangle((0, 0), 1, 1, facecolor="white", edgecolor="#bbbbbb", lw=0.4)]
ax.legend(hs, [f"used by {l}" for l in LET] + ["reserved in C's view", "free"], loc="upper center",
          bbox_to_anchor=(0.5, 0.0), ncol=3, frameon=False, fontsize=6.8, handlelength=1.2, columnspacing=0.9, handletextpad=0.4)
fig.savefig(OUT, bbox_inches="tight", pad_inches=0.02)
print("wrote", OUT)
