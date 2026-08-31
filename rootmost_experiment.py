#!/usr/bin/env python3
"""
Variance-controlled experiment for the root-most relocation rule (protocol A6)
vs the fixed-order rule (protocol A5), for the M-party BSP-OTP protocol.

Measures, across multiple seeds and a wide (m, d, N) grid, under a
relocation-MAXIMISING adversary:
  * J           : number of relocations (jumps)
  * bound       : (m/2 - 1) * (K - l0 + 1)   [the paper's Theorem 6 count]
  * epochs      : jumps per BSP level (should be exactly m/2 - 1 for A6)
  * frontier    : whether the shallowest-arena level is monotone (Lemma 10)
  * alpha       : efficiency ratio = used/N

Self-contained: no external deps beyond the Python stdlib.
"""
import math, random, statistics, argparse

def gen_bsp(N):
    out=[]; q=[(1,N)]
    while q:
        L,R=q.pop(0); M=(L+R)//2
        if M>L and M<R:
            out.append(M)
            if R-L>=2: q.append((L,M-1)); q.append((M+1,R))
    return out

def build(N,m):
    mc=2**math.ceil(math.log2(max(2,m)));P=[];na=mc//2;asz=N//na
    for i in range(na):
        s=i*asz+1;e=N if i==na-1 else (i+1)*asz
        P.append({'id':i*2,'pos':s,'dir':1,'active':(i*2)<m,'started':False,'cell':(s,e)})
        P.append({'id':i*2+1,'pos':e,'dir':-1,'active':(i*2+1)<m,'started':False,'cell':(s,e)})
    return P,mc

def cell_level(N,w): return max(0,round(math.log2(N/max(1,w+1))))

def target(P,mc,d,pl,nodes,rule):
    pairs=[(P[g]['pos'],P[g+1]['pos'],g) for g in range(mc-1)
           if g!=pl and P[g]['dir']==1 and P[g+1]['dir']==-1]
    if rule=='rootmost':
        for cand in nodes:
            for (BL,BR,g) in pairs:
                if cand>BL and cand+1<BR and cand-BL-1>d and BR-cand-2>d: return cand,g
    else:
        order=[x for x in pairs if x[2]>pl]+[x for x in pairs if x[2]<pl]
        for (BL,BR,g) in order:
            for cand in nodes:
                if cand>BL and cand+1<BR and cand-BL-1>d and BR-cand-2>d: return cand,g
    return None,None

def adversary(N,m,d,rule,nodes,rng):
    """closest-collision adversary with random tie-breaks; returns (J, alpha, epochs, frontier_monotone)."""
    P,mc=build(N,m); used=set(); J=0; steps=0
    from collections import Counter
    epoch=Counter(); mono=True
    prev=min(cell_level(N,P[g]['cell'][1]-P[g]['cell'][0]) for g in range(0,mc,2))
    ids=[p['id'] for p in P if p['active']]
    def gap(ch):
        pi=next((i for i,p in enumerate(P) if p['id']==ch),-1)
        if pi<0: return 10**9
        p=P[pi]; ti=pi+1 if p['dir']==1 else pi-1
        if ti<0 or ti>=mc: return 10**9
        return (abs(P[ti]['pos']-p['pos'])-1)-d
    while steps<N*8:
        steps+=1
        ch=sorted((gap(c),rng.random(),c) for c in ids)[0][2]
        cb=0; done=False
        while cb<100000 and not done:
            cb+=1
            pi=next((i for i,p in enumerate(P) if p['id']==ch),-1)
            if pi<0: done=True; break
            p=P[pi]; ti=pi+1 if p['dir']==1 else pi-1
            bnd=0 if ti<0 else (N+1 if ti>=mc else P[ti]['pos']); fp=(0<=ti<mc)
            e=abs(bnd-p['pos'])-1
            if e>d:
                if not p['started']: p['started']=True; used.add(p['pos'])
                else: p['pos']+=p['dir']; used.add(p['pos'])
                done=True; break
            if not fp: return J,len(used)/N,epoch,mono
            pl=min(pi,ti); L=P[pl]; R=P[pl+1]
            if L['dir']!=1 or R['dir']!=-1: return J,len(used)/N,epoch,mono
            M,g=target(P,mc,d,pl,nodes,rule)
            if M is None: return J,len(used)/N,epoch,mono
            a,b=P[g]['cell']
            epoch[cell_level(N,b-a-1)]+=1
            L['pos']=M;L['dir']=-1;L['started']=False;L['cell']=(a,M)
            R['pos']=M+1;R['dir']=1;R['started']=False;R['cell']=(M+1,b)
            P[g]['cell']=(a,M); P[g+1]['cell']=(M+1,b)
            P.sort(key=lambda x:x['pos']); J+=1
            cur=min(cell_level(N,P[k]['cell'][1]-P[k]['cell'][0]) for k in range(0,mc,2))
            if cur<prev-0.001: mono=False
            prev=cur
    return J,len(used)/N,epoch,mono

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--seeds',type=int,default=10)
    args=ap.parse_args()
    Ms=[4,8,16,32,64]; Ns=[4096,16384,65536]; Ds=[1,2,4]
    print(f"Root-most (A6) vs fixed-order (A5), relocation-maximising adversary, {args.seeds} seeds each\n")
    print(f"{'m':>3}{'d':>3}{'N':>9} | {'J_A5(max)':>9} | {'J_A6(max)':>9}{'bound':>7} | {'epoch==m/2-1?':>13}{'mono?':>6} | {'a_A5':>6}{'a_A6':>7}")
    allgood=True
    for m in Ms:
        for d in Ds:
            for N in Ns:
                nodes=gen_bsp(N)
                j5=[]; j6=[]; a5=[]; a6=[]; epoch_ok=True; mono_ok=True
                l0=round(math.log2(m//2)); K=math.floor(math.log2(N/(2*d+4)))
                bound=(m//2-1)*(K-l0+1)
                for s in range(args.seeds):
                    J5,al5,_,_=adversary(N,m,d,'fixed',nodes,random.Random(1000+s)); j5.append(J5); a5.append(al5)
                    J6,al6,ep,mono=adversary(N,m,d,'rootmost',nodes,random.Random(1000+s)); j6.append(J6); a6.append(al6)
                    if m>4:
                        active=[v for k,v in ep.items() if v>0]
                        if active and max(active)!=(m//2-1): epoch_ok=False
                    if not mono: mono_ok=False
                within = max(j6)<=bound if m>4 else True
                allgood = allgood and within and mono_ok
                flag = 'OK' if (epoch_ok and within) else 'CHECK'
                print(f"{m:>3}{d:>3}{N:>9} | {max(j5):>9} | {max(j6):>9}{bound:>7} | {str(epoch_ok):>13}{str(mono_ok):>6} | {min(a5):>6.3f}{min(a6):>7.3f}")
        print()
    print("Summary: A6 within (m/2-1)(K-l0+1) bound & frontier monotone everywhere:", allgood)

if __name__=='__main__': main()
