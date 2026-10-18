// ===========================================================================
// OTPAC m=4 · interactive monitor (UI driver for otpac_m4.js).
// The protocol logic lives entirely in otpac_m4.js (Rules R1-R9 and R11); this file
// only schedules Sends, models the network (at most d undelivered messages per
// recipient, as in the paper's family U^{4,n}_{A,d}) and draws the state.
// Parties: A = P0 (->), B = P1 (<-) share arena [1, n/2]; C = P2 (->), D = P3 (<-)
// share arena [n/2+1, n].
// ===========================================================================
const LETTERS = ['A', 'B', 'C', 'D'];
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#8b5cf6'];

let N, D, MODE, SEED, world, views, inflight, gseq, rng, steps, queue, qi, after;
let landings = [];          // [{pad, node, party, step}]
let running = false, finished = false, haltInfo = null;

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const $ = id => document.getElementById(id);

function log(msg, type = 'sys') {
    const el = document.createElement('div');
    el.innerText = msg;
    if (type) el.className = 'log-' + type;
    $('logBox').appendChild(el);
    $('logBox').scrollTop = $('logBox').scrollHeight;
}

function parseSequence(seq) {
    return seq.toUpperCase().replace(/[^A-D0-9]/g, '').replace(/([A-D])(\d*)/g, (m, c, k) => c.repeat(k ? parseInt(k, 10) : 1));
}

// --------------------------------------------------------------------------- init
function initSystem() {
    $('blockedOverlay').style.display = 'none';
    $('logBox').innerHTML = '';
    running = false; finished = false; haltInfo = null; landings = [];
    N = parseInt($('inpN').value, 10); D = parseInt($('inpD').value, 10);
    MODE = $('inpMode').value; SEED = parseInt($('inpSeed').value, 10) || 0;
    if (!(N >= 16) || !(D >= 1) || D > Math.floor(N / 4) - 1) {
        log(`[CONFIG ERROR] Need n ≥ 16 and 1 ≤ d ≤ ⌊n/4⌋−1 (got n=${N}, d=${D}).`, 'err');
        world = null; setButtons(); renderAll(); return;
    }
    world = initWorld(N, D, 4);
    rng = mulberry32(SEED * 2654435761 >>> 0 ^ 0x9e3779b9);
    views = new Map(); inflight = []; gseq = 0; steps = 0;
    for (const me of world.parties) {
        const others = new Map();
        for (const k of world.parties) if (k.id !== me.id) others.set(k.id, { pos: k.pos, dir: k.dir, buf: [] });
        const v = { self: { pos: me.pos, dir: me.dir }, others, used: new Set() };
        for (const k of world.parties) if (k.id !== me.id) refreshBuffer(v, k.id, N, D, world.nodes);
        views.set(me.id, v);
        me.jumps = 0;
    }
    queue = parseSequence($('inpSeq').value).split('');
    qi = 0;
    log(`[INIT] n=${N}, d=${D}, delivery=${MODE}, seed=${SEED}. A,B in [1,${Math.floor(N / 2)}]; C,D in [${Math.floor(N / 2) + 1},${N}].`, 'sys');
    log(`[INIT] Each party reserves, for every other party, the next ≤ ${D} pads it may already have used without being heard (R1, R4–R9).`, 'sys');
    setButtons(); renderAll();
}

// --------------------------------------------------------------------------- network
function applyRecv(rid, m) { deliverBuffer(views.get(rid), m.from, m.pad, m.dir, N, D, world.nodes, m.sseq); }
function removeSet(del) { if (!del.size) return; inflight = inflight.filter(m => !del.has(m)); }
function deliverBefore(rid) {
    const mine = inflight.filter(m => m.to === rid), del = new Set();
    if (MODE === 'random' || MODE === 'adversarial') {
        const p = MODE === 'random' ? 0.5 : 0.1;
        for (const m of mine) if (rng() < p) { applyRecv(rid, m); del.add(m); }
    } else if (MODE === 'shuffle') {
        for (let i = mine.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [mine[i], mine[j]] = [mine[j], mine[i]]; }
        for (const m of mine) if (rng() < 0.3) { applyRecv(rid, m); del.add(m); }
    }
    removeSet(del);
}
function deliverAfterSend() {
    if (MODE === 'instant') { for (const m of inflight) applyRecv(m.to, m); inflight = []; }
}
function capQueues() {   // enforce: at most d undelivered messages per recipient
    const policy = MODE === 'lifo' ? 'newest' : (MODE === 'randcap' || MODE === 'shuffle') ? 'random' : 'oldest';
    for (const r of world.parties) {
        let mine = inflight.filter(m => m.to === r.id), ex = mine.length - D;
        if (ex <= 0) continue;
        const del = new Set();
        if (policy === 'oldest') mine.sort((a, b) => a.gseq - b.gseq);
        if (policy === 'newest') mine.sort((a, b) => b.gseq - a.gseq);
        while (ex > 0) {
            const cand = mine.filter(m => !del.has(m));
            const m = policy === 'random' ? cand[Math.floor(rng() * cand.length)] : cand[0];
            applyRecv(r.id, m); del.add(m); ex--;
        }
        removeSet(del);
    }
}

// --------------------------------------------------------------------------- one Send
function nextParty() {
    const live = world.parties.filter(p => !p.halted);
    if (!live.length) return null;
    while (qi < queue.length) {
        const id = LETTERS.indexOf(queue[qi++]);
        const p = world.parties[id];
        if (!p.halted) return p;
        log(`Party ${LETTERS[id]} has halted; skipping its send request.`, 'warn');
    }
    if (after === 'random') return live[Math.floor(rng() * live.length)];
    return null;
}

function stepOnce() {
    if (!world || finished) return false;
    after = $('inpAfter').value;
    const me = nextParty();
    if (!me) { finish(); return false; }
    deliverBefore(me.id);
    const v = views.get(me.id); v.self.pos = me.pos; v.self.dir = me.dir;
    const nx = nextSlot(me.pos, me.dir, v, N, D, world.nodes);
    steps++;
    const L = LETTERS[me.id];
    if (!nx) {
        me.halted = true;
        log(`[${steps}] ${L} @${me.pos}: next pad refused and no BSP node has > 2d = ${2 * D} free pads on both sides → ${L} halts.`, 'warn');
        if (world.parties.every(p => p.halted)) finish();
        renderAll(); return true;
    }
    if (world.used.has(nx.pad)) {     // edge case: views disagreed on a jump
        haltInfo = { reuse: true, pad: nx.pad, party: me.id };
        log(`[${steps}] ${L} would use pad ${nx.pad}, already used by ${LETTERS[world.used.get(nx.pad)]} → potential reuse, protocol halts.`, 'err');
        finish(); renderAll(); return false;
    }
    const from = me.pos;
    me.pos = nx.pad; if (nx.jumped) me.dir = nx.face; me.sent++;
    world.used.set(nx.pad, me.id); v.used.add(nx.pad); gseq++;
    if (nx.jumped) {
        me.jumps++;
        const M = me.dir > 0 ? nx.pad - 1 : nx.pad;
        landings.push({ pad: nx.pad, node: M, party: me.id, step: steps });
        log(`[${steps}] ${L} JUMPS ${from} → ${nx.pad}: root-most valid node ⟨${M},${M + 1}⟩ (${me.dir > 0 ? 'right-mover lands on M+1' : 'left-mover lands on M'}).`, 'warn');
    } else {
        log(`[${steps}] ${L} uses pad ${nx.pad}  (message #${me.sent})`, '');
    }
    for (const k of world.parties) if (k.id !== me.id) inflight.push({ to: k.id, from: me.id, pad: nx.pad, dir: me.dir, gseq, sseq: me.sent });
    deliverAfterSend();
    capQueues();
    renderAll();
    return true;
}

function finish() {
    if (finished) return;
    finished = true; running = false; setButtons();
    const used = world.used.size;
    log(`--- Finished after ${steps} steps: ${used}/${N} pads used (efficiency ${(100 * used / N).toFixed(1)}%), ${N - used} wasted. ---`, 'sys');
    if (world.parties.every(p => p.halted) || haltInfo) showHaltModal();
    renderAll();
}

async function runSequence() {
    if (!world) return;
    if (finished) initSystem();
    running = true; setButtons();
    const speed = Math.max(0, parseInt($('inpSpeed').value, 10) || 0);
    while (running && !finished) {
        const ok = stepOnce();
        if (!ok) break;
        if (speed > 0) await new Promise(r => setTimeout(r, speed));
        else if (steps % 25 === 0) await new Promise(r => setTimeout(r, 0));
    }
    running = false; setButtons();
}

// --------------------------------------------------------------------------- rendering
function setButtons() {
    $('btnRun').disabled = running || !world;
    $('btnStep').disabled = running || !world || finished;
    const lamp = $('statusLamp');
    const st = finished && (haltInfo || (world && world.parties.every(p => p.halted))) ? ['halt', 'Halted'] : running ? ['running', 'Running'] : ['ready', 'Ready'];
    lamp.setAttribute('data-state', st[0]); lamp.querySelector('.status-text').textContent = st[1];
}

function renderAll() { renderStats(); renderState(); renderView(); renderGrid(); renderTree(); setButtons(); }

function renderStats() {
    if (!world) { $('live-stats').innerHTML = '<span class="readout-idle">Invalid configuration.</span>'; return; }
    const per = world.parties.map(p => {
        let c = 0; for (const [, o] of world.used) if (o === p.id) c++;
        return `<span style="color:${COLORS[p.id]};font-weight:bold">${LETTERS[p.id]}: ${c}</span>`;
    }).join(' &nbsp;|&nbsp; ');
    const used = world.used.size;
    $('live-stats').innerHTML =
        `Step ${steps} &nbsp;·&nbsp; Used: [ ${per} ]<br>` +
        `Total ${used}/${N} &nbsp;·&nbsp; <span style="color:${finished ? '#f2585f' : '#37d19a'};font-weight:bold">${finished ? 'Wasted' : 'Unused'}: ${N - used}</span>` +
        ` &nbsp;·&nbsp; Efficiency ${(100 * used / N).toFixed(1)}%<br>` +
        `Messages in flight: ${inflight.length} &nbsp;(≤ d = ${D} per recipient)`;
}

function renderState() {
    const tb = $('stateBody'); tb.innerHTML = '';
    if (!world) return;
    for (const p of world.parties) {
        const tr = document.createElement('tr');
        if (p.halted) tr.style.opacity = '0.5';
        const fl = inflight.filter(m => m.from === p.id).length;
        tr.innerHTML = `<td style="color:${COLORS[p.id]};font-weight:bold">${LETTERS[p.id]}${p.halted ? '<span class="halted-tag">halted</span>' : ''}</td>` +
            `<td>${p.pos}</td><td class="dir-arrow ${p.dir > 0 ? 'dir-right' : 'dir-left'}">${p.dir > 0 ? '→' : '←'}</td>` +
            `<td class="num">${p.sent}</td><td class="num">${fl}</td>`;
        tb.appendChild(tr);
    }
}

function obsId() { return parseInt($('inpObs').value, 10); }

function renderView() {
    const box = $('viewBox'); box.innerHTML = '';
    if (!world) return;
    const o = obsId(), v = views.get(o);
    let html = '';
    for (const [k, ko] of v.others) {
        const fwd = ko.fwd || ko.buf, held = (ko.buf || []).filter(x => !fwd.includes(x));
        const truth = world.parties[k].pos, behind = inflight.filter(m => m.from === k && m.to === o).length;
        html += `<div class="view-row"><span class="who" style="color:${COLORS[k]}">${LETTERS[k]}</span> ` +
            `<span class="k">believed @</span>${ko.pos}${ko.dir > 0 ? '→' : '←'} <span class="k">(truly ${truth}, ${behind} unheard)</span><br>` +
            `<span class="k">reserved</span> <span class="pads">[${fwd.join(', ')}]</span>` +
            (held.length ? ` <span class="k">held</span> <span class="pads">[${held.join(', ')}]</span>` : '') + `</div>`;
    }
    if (v.selfClaim && v.selfClaim.size) html += `<div class="view-row"><span class="k">own landing claim</span> <span class="pads">[${[...v.selfClaim].join(', ')}]</span></div>`;
    html += `<div class="view-note">${LETTERS[o]} never uses a pad that is used, someone's believed position, or reserved here (R1). Its reservations are outlined on the pad array.</div>`;
    box.innerHTML = html;
}

function renderGrid() {
    const grid = $('padGrid'); grid.innerHTML = '';
    if (!world) return;
    const o = obsId(), v = views.get(o);
    const resBy = new Map();
    for (const [k, ko] of v.others) for (const q of ko.buf || []) if (!resBy.has(q)) resBy.set(q, k);
    const posOf = new Map(world.parties.map(p => [p.pos, p]));
    const landSet = new Set(landings.map(l => l.pad));
    const lastLand = landings.length ? landings[landings.length - 1].pad : null;
    for (let i = 1; i <= N; i++) {
        const el = document.createElement('div');
        el.className = 'pad'; el.id = 'pad-' + i;
        let title = `pad ${i}`;
        const owner = world.used.get(i);
        if (owner !== undefined) {
            el.classList.add('active');
            el.style.backgroundColor = COLORS[owner];
            el.innerText = landSet.has(i) ? 'J' : (world.parties[owner].dir > 0 ? '→' : '←');
            title += ` · used by ${LETTERS[owner]}`;
        }
        const p = posOf.get(i);
        if (p) {
            el.classList.add('pos'); el.style.backgroundColor = COLORS[p.id]; el.innerText = LETTERS[p.id];
            title += ` · ${LETTERS[p.id]} is here`;
        }
        if (owner === undefined && !p && resBy.has(i)) {
            el.classList.add('reserved'); el.style.borderColor = COLORS[resBy.get(i)];
            el.style.color = COLORS[resBy.get(i)]; el.innerText = i;
            title += ` · reserved for ${LETTERS[resBy.get(i)]} in ${LETTERS[o]}'s view`;
        }
        if (i === lastLand) el.classList.add('landing');
        el.title = title;
        grid.appendChild(el);
    }
}

function renderTree() {
    const container = $('tree-container');
    if (!world) { container.innerHTML = '<svg id="tree-lines"></svg>'; return; }
    const targets = new Set(landings.map(l => l.node));
    if (!targets.size) targets.add(Math.floor((1 + N) / 2));
    const nodesByLevel = {}, nodeData = new Map(); let maxLevel = 1;
    targets.forEach(t => {
        let L = 1, R = N, parent = null, level = 1;
        while (L <= R) {
            const M = Math.floor((L + R) / 2);
            if (!nodeData.has(M)) { nodeData.set(M, { M, level, parent }); (nodesByLevel[level] = nodesByLevel[level] || []).push(M); maxLevel = Math.max(maxLevel, level); }
            if (M === t) break;
            parent = M; if (t < M) R = M - 1; else L = M + 1; level++;
        }
    });
    const last = landings.length ? landings[landings.length - 1].node : null;
    let html = '<svg id="tree-lines"></svg>';
    for (let i = 1; i <= maxLevel; i++) {
        if (!nodesByLevel[i]) continue;
        html += '<div class="tree-level">';
        for (const M of nodesByLevel[i]) {
            const used = targets.has(M) && landings.length;
            html += `<div class="tree-node ${M === last ? 'active-jump' : ''}" id="bsp-node-${M}" style="left:${(M / N) * 100}%;${used && M !== last ? 'border-color:var(--gold-line);color:var(--gold-hi)' : ''}" title="node ⟨${M},${M + 1}⟩">${M}</div>`;
        }
        html += '</div>';
    }
    container.innerHTML = html;
    setTimeout(() => {
        const svg = $('tree-lines'); if (!svg) return;
        const sr = svg.getBoundingClientRect(); let s = '';
        nodeData.forEach(nd => {
            if (nd.parent === null) return;
            const a = $(`bsp-node-${nd.parent}`), b = $(`bsp-node-${nd.M}`); if (!a || !b) return;
            const r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect();
            s += `<line x1="${r1.left + r1.width / 2 - sr.left}" y1="${r1.top + r1.height / 2 - sr.top}" x2="${r2.left + r2.width / 2 - sr.left}" y2="${r2.top + r2.height / 2 - sr.top}" stroke="#3a4a5e" stroke-width="2"/>`;
        });
        svg.innerHTML = s;
    }, 30);
}

function showHaltModal() {
    const tb = $('blockedTableBody'); tb.innerHTML = '';
    for (const p of world.parties) {
        let c = 0; for (const [, o] of world.used) if (o === p.id) c++;
        const tr = document.createElement('tr');
        tr.innerHTML = `<td style="color:${COLORS[p.id]};font-weight:bold">Party ${LETTERS[p.id]}</td><td>${c}</td><td>${p.jumps}</td>`;
        tb.appendChild(tr);
    }
    if (haltInfo && haltInfo.reuse) {
        $('haltTitle').textContent = 'EDGE CASE';
        $('haltText').textContent = `Party ${LETTERS[haltInfo.party]}'s next pad (${haltInfo.pad}) was already used: the parties' views of a jump disagreed. The protocol halts and the remaining pads are wasted.`;
    } else {
        $('haltTitle').textContent = 'NO JUMP SPOT';
        $('haltText').textContent = `No party has a valid BSP jump spot left (more than 2d = ${2 * D} free pads on both sides of the node).`;
    }
    const w = N - world.used.size;
    $('statsWasted').innerText = `${w} / ${N} (${(100 * w / N).toFixed(1)}%)`;
    $('blockedOverlay').style.display = 'flex';
}
function closePopup() { $('blockedOverlay').style.display = 'none'; }

// --------------------------------------------------------------------------- wiring
(function () {
    document.querySelectorAll('.chip[data-seq]').forEach(btn => btn.addEventListener('click', () => {
        $('inpSeq').value = btn.getAttribute('data-seq'); initSystem();
    }));
    ['inpN', 'inpD', 'inpMode', 'inpSeed'].forEach(id => $(id).addEventListener('change', initSystem));
    $('inpSeq').addEventListener('change', initSystem);
    ['inpN', 'inpD', 'inpSeq', 'inpSpeed', 'inpSeed'].forEach(id => $(id).addEventListener('keydown', e => {
        if (e.key === 'Enter' && !$('btnRun').disabled) { e.preventDefault(); initSystem(); runSequence(); }
    }));
    $('inpObs').addEventListener('change', () => { renderView(); renderGrid(); });
    window.addEventListener('resize', renderTree);
})();
window.onload = initSystem;
