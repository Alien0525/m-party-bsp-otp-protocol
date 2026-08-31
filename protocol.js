// --- CORE LOGIC ---
let N, d, m_input, m_ceil;
let parties = []; 
let bspNodes = [];
let historicalMs = new Set(); 
let persistentTargets = new Set(); 
let padColors = {};
let finalWastedStr = null; // Tracks final waste for the UI
let usedPads = new Set();   // Model-owned ground truth of consumed pads (independent of the DOM)

// Landing rule for relocations (BSP jumps):
//   'rootmost' : protocol A6 -- always relocate into the LARGEST available cell
//                (scan BSP nodes root-first globally). Keeps arenas balanced, so the
//                relocation count J is logarithmic in N for every m (see paper, Sec. 5.1).
//   'fixed'    : protocol A5 -- scan other pairs in positional order, take the root-most
//                node of the first pair that admits one (the original behaviour).
// A6 and A5 coincide when m = 4 (only one other pair exists).
let LANDING_RULE = 'rootmost';

// Records that `pos` was consumed by `party` (idempotent). This is the single
// source of truth for padsUsed / wasted, so accounting no longer depends on
// CSS classes and stays correct even if rendering is skipped.
function consumePad(party, pos) {
    if (!usedPads.has(pos)) {
        usedPads.add(pos);
        party.padsUsed++;
    }
}
const colors = ['#3b82f6', '#ef4444', '#10b981', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899', '#84cc16', '#6366f1', '#f43f5e'];

function log(msg, type='sys') {
    const box = document.getElementById('logBox');
    const el = document.createElement('div');
    el.innerText = msg;
    if (type) el.className = 'log-' + type;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
}

function parseSequence(seq) {
    return seq.toUpperCase().replace(/\s+/g, '').replace(/([A-Z])(\d*)/g, (match, char, num) => {
        return char.repeat(num ? parseInt(num) : 1);
    });
}

function generateBSPNodes(N) {
    let nodes = [];
    let queue = [{L: 1, R: N, level: 1}];
    while(queue.length > 0) {
        let curr = queue.shift();
        let M = Math.floor((curr.L + curr.R) / 2);
        if (M > curr.L && M < curr.R) {
            nodes.push(M);
            if (curr.R - curr.L >= 2) {
                queue.push({L: curr.L, R: M - 1, level: curr.level + 1});
                queue.push({L: M + 1, R: curr.R, level: curr.level + 1});
            }
        }
    }
    return nodes;
}

function initSystem() {
    document.getElementById('blockedOverlay').style.display = 'none';
    historicalMs.clear();
    persistentTargets.clear();
    usedPads.clear();
    parties = [];          // reset up front so a rejected config leaves clean state
    finalWastedStr = null;
    
    N = parseInt(document.getElementById('inpN').value, 10);
    d = parseInt(document.getElementById('inpD').value, 10);
    m_input = parseInt(document.getElementById('inpM').value, 10);

    // --- Input validation: reject NaN / out-of-range values before they
    // corrupt the state array (e.g. zero-width arenas when N < parties). ---
    if (!Number.isFinite(N) || !Number.isFinite(d) || !Number.isFinite(m_input) ||
        N < 2 || d < 0 || m_input < 1) {
        log(`[CONFIG ERROR] Need integers N>=2, d>=0, m>=1. Got N=${N}, d=${d}, m=${m_input}.`, 'err');
        document.getElementById('btnRun').disabled = true;
        return;
    }

    m_ceil = Math.pow(2, Math.ceil(Math.log2(Math.max(2, m_input))));

    // Each of the m_ceil/2 arenas needs at least a few pads to be meaningful;
    // guard against N being too small to seat every (scaled) party.
    if (N < m_ceil) {
        log(`[CONFIG ERROR] N=${N} is too small for ${m_ceil} scaled endpoints; increase N or decrease m.`, 'err');
        document.getElementById('btnRun').disabled = true;
        return;
    }
    
    document.getElementById('logBox').innerHTML = '';
    log(`Initializing System: N=${N}, d=${d}, Real Parties=${m_input} (System Scaled to ${m_ceil})`);

    padColors = {};
    for (let i = 0; i < m_ceil; i++) {
        let char = String.fromCharCode(65 + i);
        padColors[char] = colors[i % colors.length];
    }

    parties = [];
    let num_arenas = m_ceil / 2;
    let arena_size = Math.floor(N / num_arenas);
    
    for (let i = 0; i < num_arenas; i++) {
        let start = (i * arena_size) + 1;
        let end = (i + 1) * arena_size;
        if (i === num_arenas - 1) end = N;

        let logL = String.fromCharCode(65 + (i*2));
        let logR = String.fromCharCode(65 + (i*2) + 1);

        let activeL = (i*2) < m_input;
        let activeR = (i*2) + 1 < m_input;

        parties.push({ logical_id: logL, pos: start, dir: 1, color: padColors[logL], active: activeL, hasStarted: false, padsUsed: 0 });
        parties.push({ logical_id: logR, pos: end, dir: -1, color: padColors[logR], active: activeR, hasStarted: false, padsUsed: 0 });
    }

    bspNodes = generateBSPNodes(N);
    
    renderGrid();
    updateStateTable();
    updateJumpSpotsUI(); 
    updateStatsUI();
    
    document.getElementById('btnRun').disabled = false;
}

function getNextBSPSpot(BoundL, BoundR) {
    for (let i = 0; i < bspNodes.length; i++) {
        let M = bspNodes[i];
        if (M > BoundL && M + 1 < BoundR) {
            if ((M - BoundL - 1 > d) && (BoundR - (M + 1) - 1 > d)) {
                return M;
            }
        }
    }
    return null;
}

// Protocol A6 (root-most rule): scan BSP nodes root-first (largest cells first)
// and return the first node that lands validly inside ANY of the candidate gaps,
// together with that gap's left index. This relocates into the largest available
// cell globally, rather than into the first pair in positional order.
// `gaps` is a list of left-indices g such that (parties[g], parties[g+1]) is a
// facing pair we may jump into.
function getGlobalRootMostSpot(gaps) {
    for (let i = 0; i < bspNodes.length; i++) {
        let M = bspNodes[i];
        for (let g of gaps) {
            let BoundL = parties[g].pos, BoundR = parties[g + 1].pos;
            if (M > BoundL && M + 1 < BoundR &&
                (M - BoundL - 1 > d) && (BoundR - (M + 1) - 1 > d)) {
                return { M: M, g: g };
            }
        }
    }
    return null;
}

function updateJumpSpotsUI() {
    document.querySelectorAll('.pad.jump-spot').forEach(el => {
        el.classList.remove('jump-spot');
        if (!el.classList.contains('active') && !el.classList.contains('ghost')) el.innerText = '';
    });

    for (let g = 0; g < m_ceil - 1; g++) {
        if (parties[g].dir === 1 && parties[g+1].dir === -1 && parties[g].pos < parties[g+1].pos) {
            let M = getNextBSPSpot(parties[g].pos, parties[g+1].pos);
            if (M !== null) {
                persistentTargets.add(M); 
                let el = document.getElementById('pad-' + M);
                if (el && !el.classList.contains('active') && !el.classList.contains('ghost')) {
                    el.classList.add('jump-spot');
                    el.innerText = M; 
                }
            }
        }
    }
    renderTree(); 
}

function updateStatsUI() {
    let usedStr = parties.filter(p => p.active).map(p => {
        return `<span style="color:${p.color}; font-weight:bold;">${p.logical_id}: ${p.padsUsed}</span>`;
    }).join(' &nbsp;|&nbsp; ');

    // If protocol has halted, show the final Wasted percentage instead of Available
    if (finalWastedStr) {
        document.getElementById('live-stats').innerHTML = 
            `Used: [ ${usedStr} ] &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; 
             <span style="color:#ef4444; font-weight:bold;">Final Wasted: ${finalWastedStr}</span>`;
        return;
    }

    let available = 0;
    
    for (let x = 1; x <= N; x++) {
        let el = document.getElementById('pad-' + x);
        if (el.classList.contains('active') || el.classList.contains('ghost')) continue;
        
        let availableToSomeone = false;
        let leftP = null, rightP = null;
        
        for(let i=0; i<parties.length; i++) {
            if (parties[i].pos < x) leftP = parties[i];
            if (parties[i].pos > x && rightP === null) rightP = parties[i];
        }
        
        if (leftP && leftP.dir === 1 && leftP.active) availableToSomeone = true;
        if (rightP && rightP.dir === -1 && rightP.active) availableToSomeone = true;
        
        if (availableToSomeone) available++;
    }

    document.getElementById('live-stats').innerHTML = 
        `Used: [ ${usedStr} ] &nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp; 
         <span style="color:#10b981; font-weight:bold;">Available: ${available}</span>`;
}

async function runSequence() {
    if (!parties.length) {
        log(`[CONFIG ERROR] System not initialized (check N, d, m). Nothing to run.`, 'err');
        return;
    }
    document.getElementById('btnRun').disabled = true;
    let rawSeq = document.getElementById('inpSeq').value;
    let seq = parseSequence(rawSeq);
    let speed = parseInt(document.getElementById('inpSpeed').value);
    
    log(`\n--- Parsed Input Sequence: ${seq} ---`, 'sys');

    for (let i = 0; i < seq.length; i++) {
        let char = seq[i];
        
        let pIdx = parties.findIndex(p => p.logical_id === char);
        if (pIdx === -1) {
            log(`Logical Party ${char} not found. Skipping.`, 'warn');
            continue;
        }

        let party = parties[pIdx];
        if (!party.active) {
            log(`Party ${char} is a disabled dummy. Cannot send message.`, 'err');
            continue;
        }

        log(`\n--- Processing Message: ${char} ---`, 'sys');
        
        let success = false;
        let circuitBreaker = 0;
        // A single message resolves in at most 2 iterations today (collide -> jump
        // -> ghost-anchor). The cap only guards against an unforeseen relocation
        // cycle; size it generously (one attempt per possible arena) so a correct
        // run is never truncated, and surface exhaustion explicitly below.
        const maxAttempts = m_ceil + 2;

        while (!success && circuitBreaker < maxAttempts) {
            circuitBreaker++;
            pIdx = parties.findIndex(p => p.logical_id === char); 
            party = parties[pIdx];

            let targetIdx = party.dir === 1 ? pIdx + 1 : pIdx - 1;
            let bound = (targetIdx < 0) ? 0 : (targetIdx >= m_ceil) ? N + 1 : parties[targetIdx].pos;
            let facingParty = (targetIdx >= 0 && targetIdx < m_ceil);

            let empty_pads = Math.abs(bound - party.pos) - 1;

            if (empty_pads > d) {
                if (!party.hasStarted) {
                    party.hasStarted = true;
                    consumePad(party, party.pos);
                    markPad(party.pos, party.logical_id, party.color, party.dir, true, false);
                    log(`[SUCCESS] ${char} sent. Anchored on initial pos: ${party.pos}`);
                } else {
                    party.pos += party.dir;
                    consumePad(party, party.pos);
                    markPad(party.pos, party.logical_id, party.color, party.dir, false, false);
                    log(`[SUCCESS] ${char} sent. New pos: ${party.pos}`);
                }
                updateStateTable();
                updateJumpSpotsUI();
                updateStatsUI();
                success = true;
            } else {
                if (!facingParty) {
                    // Defensive only: by the pairing invariant the extremal players
                    // always face inward (index 0 has dir +1, index m_ceil-1 has dir -1),
                    // so a party never actually reaches the true array boundary.
                    log(`[HALT] ${char} reached the array boundary with no facing pair. Deadlock.`, 'err');
                    showDeadlockModal();
                    return;
                }

                let targetID = parties[targetIdx].logical_id;
                log(`[COLLISION] Only ${empty_pads} empty pads remain between Party ${char} and Party ${targetID}. (Requires > ${d}).`, 'warn');
                
                let pairLeftIdx = Math.min(pIdx, targetIdx);
                let L_party = parties[pairLeftIdx];
                let R_party = parties[pairLeftIdx + 1];

                if (L_party.dir !== 1 || R_party.dir !== -1) {
                    log(`[FATAL] Invalid collision geometry!`, 'err');
                    showDeadlockModal();
                    return;
                }

                log(`[JUMP INITIATED] Pair (${L_party.logical_id}, ${R_party.logical_id}) scanning outward (right, then wrapping left)...`, 'warn');
                
                let jumpFound = false;
                let gapsToCheck = [];
                
                for (let g = 0; g < m_ceil - 1; g++) {
                    if (g !== pairLeftIdx && parties[g].dir === 1 && parties[g+1].dir === -1) {
                        gapsToCheck.push(g);
                    }
                }

                let orderedGaps = gapsToCheck.filter(g => g > pairLeftIdx).concat(gapsToCheck.filter(g => g < pairLeftIdx));

                // Choose the landing point according to the configured rule.
                // Both yield a target M and the host gap's left index g.
                let hop = null;
                if (LANDING_RULE === 'rootmost') {
                    // A6: largest available cell, scanning BSP nodes root-first globally.
                    hop = getGlobalRootMostSpot(orderedGaps);
                } else {
                    // A5: first pair in positional order that admits a valid node.
                    for (let g of orderedGaps) {
                        let M = getNextBSPSpot(parties[g].pos, parties[g + 1].pos);
                        if (M !== null) { hop = { M: M, g: g }; break; }
                    }
                }

                if (hop !== null) {
                    let M = hop.M;
                    log(`[JUMP SUCCESS] Valid BSP spot found at ${M} (rule: ${LANDING_RULE}).`, 'sys');

                    historicalMs.add(M);

                    // A never-started member only ever placed a ghost anchor,
                    // which was never counted as consumed; clear it from both the
                    // DOM and (defensively) the model so no phantom pad lingers.
                    if (!L_party.hasStarted) { clearPad(L_party.pos); usedPads.delete(L_party.pos); }
                    if (!R_party.hasStarted) { clearPad(R_party.pos); usedPads.delete(R_party.pos); }

                    L_party.pos = M;
                    L_party.dir = -1;
                    L_party.hasStarted = false;
                    markPad(M, L_party.logical_id, L_party.color, L_party.dir, true, true);

                    R_party.pos = M + 1;
                    R_party.dir = 1;
                    R_party.hasStarted = false;
                    markPad(M + 1, R_party.logical_id, R_party.color, R_party.dir, true, true);

                    parties.sort((a, b) => a.pos - b.pos);
                    updateStateTable();
                    updateJumpSpotsUI();
                    updateStatsUI();

                    jumpFound = true;
                }

                if (!jumpFound) {
                    log(`[FATAL] No safe BSP spot in any arena. Deadlock!`, 'err');
                    showDeadlockModal();
                    return;
                }
            }
        }

        // The loop should always exit via success (or an earlier deadlock return).
        // If it exhausts its attempt budget, treat it as a halt rather than
        // silently dropping the message.
        if (!success) {
            log(`[HALT] ${char} could not be routed within ${maxAttempts} attempts. Deadlock.`, 'err');
            showDeadlockModal();
            return;
        }

        if (speed > 0) await new Promise(r => setTimeout(r, speed));
    }
    log(`\n--- Sequence Complete ---`, 'sys');
    document.getElementById('btnRun').disabled = false;
}

// --- UI & MODAL RENDERING ---
function showDeadlockModal() {
    const tbody = document.getElementById('blockedTableBody');
    tbody.innerHTML = '';
    
    parties.filter(p => p.active).forEach(p => {
        let tr = document.createElement('tr');
        tr.innerHTML = `<td style="color:${p.color}; font-weight:bold;">Party ${p.logical_id}</td><td>${p.padsUsed}</td>`;
        tbody.appendChild(tr);
    });

    // Wasted derived from the model-owned consumed-pad set (single source of truth).
    let wasted = N - usedPads.size;
    let wastedPct = ((wasted / N) * 100).toFixed(1);
    
    // Store in global variable for when the modal is closed
    finalWastedStr = `${wasted} (${wastedPct}%)`;
    
    document.getElementById('statsWasted').innerText = finalWastedStr;
    document.getElementById('blockedOverlay').style.display = 'flex';
}

function closePopup() { 
    document.getElementById('blockedOverlay').style.display = 'none'; 
    updateStatsUI(); // This will trigger the display of finalWastedStr
}

function updateStateTable() {
    const tb = document.getElementById('stateBody');
    tb.innerHTML = '';
    parties.forEach((p, index) => {
        let tr = document.createElement('tr');
        if (!p.active) tr.style.opacity = '0.4'; 
        
        let dirArrow = p.dir === 1 ? '→' : '←';
        let dirClass = p.dir === 1 ? 'dir-right' : 'dir-left';
        
        tr.innerHTML = `
            <td><strong>${index + 1}</strong></td>
            <td style="color:${p.color}; font-weight:bold">${p.logical_id} ${!p.active ? '(Dummy)' : ''}</td>
            <td>${p.pos}</td>
            <td class="dir-arrow ${dirClass}">${dirArrow}</td>
        `;
        tb.appendChild(tr);
    });
}

function renderGrid() {
    const grid = document.getElementById('padGrid');
    grid.innerHTML = '';
    for (let i = 1; i <= N; i++) {
        let el = document.createElement('div');
        el.className = 'pad';
        el.id = 'pad-' + i;
        grid.appendChild(el);
    }
    parties.forEach(p => markPad(p.pos, p.logical_id, p.color, p.dir, true, !p.hasStarted));
}

function markPad(pos, id, color, dir, isStart=false, isGhost=false) {
    let el = document.getElementById('pad-' + pos);
    if (!el) return;
    
    if (isGhost) {
        el.style.backgroundColor = 'transparent';
        el.style.boxShadow = `inset 0 0 0 2px ${color}`; 
        el.style.color = color;
        el.classList.add('ghost');
        el.innerText = id;
    } else {
        // Rendering only: pad accounting is owned by consumePad()/usedPads.
        el.style.backgroundColor = color;
        el.style.boxShadow = 'none'; 
        el.style.color = '#fff'; 
        el.classList.add('active');
        el.classList.remove('jump-spot', 'ghost');
        el.innerText = isStart ? id : (dir === 1 ? '→' : '←');
    }
}

function clearPad(pos) {
    let el = document.getElementById('pad-' + pos);
    if (el) {
        el.style.backgroundColor = ''; el.style.boxShadow = ''; el.style.color = '';
        el.className = 'pad'; el.innerText = '';
    }
}

function renderTree() {
    let targets = new Set(historicalMs);
    persistentTargets.forEach(t => targets.add(t));
    
    if (targets.size === 0) targets.add(Math.floor((1 + N)/2)); 

    let nodesByLevel = {};
    let maxLevel = 1;
    let nodeData = new Map(); 

    targets.forEach(target => {
        let L = 1, R = N, parent = null, level = 1;
        while(L <= R) {
            let M = Math.floor((L+R)/2);
            if (!nodeData.has(M)) {
                nodeData.set(M, {M, level, parent});
                if (!nodesByLevel[level]) nodesByLevel[level] = [];
                nodesByLevel[level].push(M);
                maxLevel = Math.max(maxLevel, level);
            }
            if (M === target) break;
            parent = M;
            if (target < M) R = M - 1; else L = M + 1;
            level++;
        }
    });

    const container = document.getElementById('tree-container');
    let html = `<svg id="tree-lines"></svg>`;
    
    for (let i=1; i<=maxLevel; i++) {
        if(!nodesByLevel[i]) continue;
        html += `<div class="tree-level">`;
        nodesByLevel[i].forEach(M => {
            let pct = (M / N) * 100;
            let isJumpSpot = Array.from(document.querySelectorAll('.pad.jump-spot')).some(el => parseInt(el.innerText) === M);
            let ex = isJumpSpot ? 'active-jump' : '';
            html += `<div class="tree-node ${ex}" id="bsp-node-${M}" style="left: ${pct}%">${M}</div>`;
        });
        html += `</div>`;
    }
    container.innerHTML = html;

    setTimeout(() => {
        const svg = document.getElementById('tree-lines');
        if (!svg) return;
        let svgHtml = '';
        nodeData.forEach(data => {
            if (data.parent !== null) {
                let el1 = document.getElementById(`bsp-node-${data.parent}`);
                let el2 = document.getElementById(`bsp-node-${data.M}`);
                if (el1 && el2) {
                    let r1 = el1.getBoundingClientRect();
                    let r2 = el2.getBoundingClientRect();
                    let sr = svg.getBoundingClientRect();
                    let x1 = r1.left + r1.width/2 - sr.left;
                    let y1 = r1.top + r1.height/2 - sr.top;
                    let x2 = r2.left + r2.width/2 - sr.left;
                    let y2 = r2.top + r2.height/2 - sr.top;
                    svgHtml += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#cbd5e1" stroke-width="2" />`;
                }
            }
        });
        svg.innerHTML = svgHtml;
    }, 50);
}

window.onload = initSystem;