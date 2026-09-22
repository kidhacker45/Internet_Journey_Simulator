'use strict';
/* ============================================================
   Internet Journey Simulator
   ------------------------------------------------------------
   Everything below is a SIMULATION. No real network traffic
   is generated. All addresses, routes, AS numbers and servers
   are illustrative teaching models.
   ============================================================ */

/* ===========================
   1. NETWORK MODEL (simulated)
   =========================== */

// Simulated Google address — NOT a real, fixed Google IP.
const GOOGLE_IP = '142.250.72.14';
const GOOGLE_IP_LABEL = '142.250.x.x (simulated)';

const NET = {
  lan: '192.168.1.0/24',
  gateway: '192.168.1.1',
  router: {
    lanMac: 'AA:BB:CC:DD:EE:01',
    lanIp: '192.168.1.1',
    wanIp: '203.0.113.10',           // documentation range — simulated public IP
    wanMac: 'AA:BB:CC:DD:EE:02',
    ispGateway: '203.0.113.1',
    upstreamDns: '203.0.113.53'
  },
  mobile: {
    deviceIp: '10.1.2.3',            // private address on the mobile link
    cgnatShared: '100.64.12.7',      // RFC 6598 carrier shared space (simulated)
    publicIp: '198.51.100.7'         // documentation range — simulated carrier public IP
  }
};

function makePC(n) {
  const last = 19 + n;               // PC1 → .20 … PC5 → .24
  return {
    id: 'pc' + n,
    name: 'PC' + n,
    type: 'computer',
    ip: '192.168.1.' + last,
    mac: '02:42:AC:11:00:' + String(last),
    subnet: NET.lan,
    gateway: NET.gateway,
    dns: NET.gateway,
    connection: 'Wi-Fi'
  };
}
const PCS = [1, 2, 3, 4, 5].map(makePC);

/* ===========================
   2. SIMULATION STATE
   =========================== */

const sim = {
  mode: 'wifi',            // 'wifi' | 'mobile'
  clientNum: 3,            // selected PC (1-5)
  domain: 'google.com',
  step: -1,
  playing: false,
  speed: 1,
  level: 'beginner',
  failure: 'none',
  multi: false,
  stopped: false,          // fatal failure reached
  animating: false,
  nat: [],                 // NAT table entries
  dns: {},                 // DNS cache
  arp: {},                 // ARP cache
  stats: { packets: 0, retries: 0, roundTrips: 4 },
  timers: [],              // pending timeouts (for clean reset)
  anim: null               // current animation handle
};

const el = id => document.getElementById(id);
const client = () => PCS[sim.clientNum - 1];
const isWifi = () => sim.mode === 'wifi';
const clientLabel = () => isWifi() ? client().name : 'Phone';
const clientIp = () => isWifi() ? client().ip : NET.mobile.deviceIp;
const clientMac = () => isWifi() ? client().mac : 'cellular link (no MAC/ARP)';
const clientPort = () => sim.multi && isWifi() ? 50000 + sim.clientNum : 52143;
const publicPort = () => sim.multi && isWifi() ? 40000 + sim.clientNum : 40001;
const publicIp = () => isWifi() ? NET.router.wanIp : NET.mobile.publicIp;
const natDeviceName = () => isWifi() ? 'home router' : 'carrier CGNAT';

/* ===========================
   3. LOGGING + TIMERS
   =========================== */

function now() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg, cls = 'sys') {
  const li = document.createElement('li');
  li.className = cls;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = `[${now()}] `;
  li.appendChild(ts);
  li.appendChild(document.createTextNode(msg));
  el('event-log').appendChild(li);
  el('event-log').scrollTop = el('event-log').scrollHeight;
}

// Tracked timeout so Reset can clean up everything (no leaked timers).
function wait(ms) {
  return new Promise(resolve => {
    const id = setTimeout(() => { resolve(); }, ms);
    sim.timers.push({ id, resolve });
  });
}

function clearTimers() {
  sim.timers.forEach(t => { clearTimeout(t.id); t.resolve(); });
  sim.timers = [];
}

/* ===========================
   4. TOPOLOGY LAYOUTS (SVG)
   =========================== */

// Node: {id,name,icon,x,y,ip,sub,type,as?}
function wifiLayout() {
  const pcs = PCS.map((p, i) => ({
    id: p.id, name: p.name, icon: '💻', x: 170 + i * 170, y: 95,
    ip: p.ip, type: 'computer', ref: p
  }));
  return {
    nodes: [
      ...pcs,
      { id: 'router', name: 'Wi-Fi Router', icon: '📡', x: 510, y: 260, ip: NET.router.lanIp, sub: 'WAN: ' + NET.router.wanIp + ' (simulated)', type: 'router' },
      { id: 'isp', name: 'Your ISP', icon: '🏢', x: 170, y: 470, ip: 'AS64500', type: 'isp' },
      { id: 'r1', name: 'R1', icon: '🛣', x: 330, y: 470, ip: 'AS64500', type: 'irouter' },
      { id: 'r2', name: 'R2', icon: '🛣', x: 490, y: 470, ip: 'AS64501', type: 'irouter' },
      { id: 'r3', name: 'R3', icon: '🛣', x: 650, y: 470, ip: 'AS64501', type: 'irouter' },
      { id: 'r4', name: 'R4', icon: '🛣', x: 810, y: 470, ip: 'AS64501', type: 'irouter' },
      { id: 'edge', name: 'Google Edge', icon: '🏢', x: 960, y: 470, ip: 'AS15169 · anycast (simulated)', type: 'edge' },
      { id: 'server', name: 'Google Server', icon: '🖥', x: 1110, y: 470, ip: GOOGLE_IP_LABEL, type: 'server' }
    ],
    links: [
      ...PCS.map(p => ['pc' === '' ? null : p.id, 'router'].filter(Boolean)),
      ['router', 'isp'], ['isp', 'r1'], ['r1', 'r2'], ['r2', 'r3'],
      ['r3', 'r4'], ['r4', 'edge'], ['edge', 'server']
    ]
  };
}

function mobileLayout() {
  return {
    nodes: [
      { id: 'client', name: 'Phone / Client', icon: '📱', x: 170, y: 80, ip: NET.mobile.deviceIp + ' (private)', type: 'mdevice' },
      { id: 'tower', name: 'Cell Tower', icon: '📡', x: 170, y: 190, ip: 'radio access', type: 'tower' },
      { id: 'core', name: 'Mobile Core', icon: '🏢', x: 170, y: 305, ip: 'operator network', type: 'core' },
      { id: 'cgnat', name: 'CGNAT', icon: '🔀', x: 170, y: 420, ip: '100.64.x pool → ' + NET.mobile.publicIp, type: 'cgnat' },
      { id: 'isp', name: 'Carrier → Internet', icon: '🌐', x: 170, y: 545, ip: 'AS64500', type: 'isp' },
      { id: 'r1', name: 'R1', icon: '🛣', x: 350, y: 545, ip: 'AS64501', type: 'irouter' },
      { id: 'r2', name: 'R2', icon: '🛣', x: 520, y: 545, ip: 'AS64501', type: 'irouter' },
      { id: 'edge', name: 'Google Edge', icon: '🏢', x: 740, y: 545, ip: 'AS15169 · anycast (simulated)', type: 'edge' },
      { id: 'server', name: 'Google Server', icon: '🖥', x: 950, y: 545, ip: GOOGLE_IP_LABEL, type: 'server' }
    ],
    links: [
      ['client', 'tower'], ['tower', 'core'], ['core', 'cgnat'],
      ['cgnat', 'isp'], ['isp', 'r1'], ['r1', 'r2'],
      ['r2', 'edge'], ['edge', 'server']
    ]
  };
}

let layout = null;
const nodeById = id => layout.nodes.find(n => n.id === id);

function renderTopology() {
  layout = isWifi() ? wifiLayout() : mobileLayout();
  const svg = el('net');
  svg.innerHTML = '';

  // Backbone label
  const bb = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  bb.setAttribute('x', 600); bb.setAttribute('y', isWifi() ? 425 : 500);
  bb.setAttribute('text-anchor', 'middle');
  bb.setAttribute('fill', '#8a6d33'); bb.setAttribute('font-size', '10');
  bb.textContent = 'SIMULATED INTERNET PATH — not a real traceroute';
  svg.appendChild(bb);

  // Links
  layout.links.forEach(([a, b]) => {
    const na = nodeById(a), nb = nodeById(b);
    if (!na || !nb) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', na.x); line.setAttribute('y1', na.y);
    line.setAttribute('x2', nb.x); line.setAttribute('y2', nb.y);
    line.setAttribute('class', 'link');
    line.dataset.link = a + '|' + b;
    svg.appendChild(line);
  });

  // Nodes
  layout.nodes.forEach(n => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'node' + (n.id === 'pc' + sim.clientNum && isWifi() ? ' selected' : ''));
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', n.name + (n.ip ? ', ' + n.ip : ''));
    g.dataset.node = n.id;

    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', 'body'); c.setAttribute('r', '26');
    g.appendChild(c);

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    icon.setAttribute('class', 'icon'); icon.setAttribute('y', '7');
    icon.textContent = n.icon;
    g.appendChild(icon);

    const name = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    name.setAttribute('y', '44');
    name.textContent = n.name + (isWifi() && n.id === 'pc' + sim.clientNum ? ' ⭐' : '');
    g.appendChild(name);

    if (n.ip) {
      const ip = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      ip.setAttribute('class', 'ip'); ip.setAttribute('y', '57');
      ip.textContent = n.ip;
      g.appendChild(ip);
    }
    if (n.sub) {
      const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      sub.setAttribute('class', 'ip'); sub.setAttribute('y', '69');
      sub.textContent = n.sub;
      g.appendChild(sub);
    }

    g.addEventListener('click', () => openNodeModal(n.id));
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openNodeModal(n.id); }
    });
    svg.appendChild(g);
  });

  rebuildRoutingSelect();
}

// Visual helpers on the SVG
function svgNode(id) { return el('net').querySelector(`[data-node="${id}"]`); }
function highlightNodes(ids) {
  el('net').querySelectorAll('.node').forEach(g => g.classList.remove('active'));
  ids.forEach(id => { const g = svgNode(id); if (g) g.classList.add('active'); });
}
function dimOtherPCs(dim) {
  PCS.forEach(p => {
    const g = svgNode(p.id);
    if (!g) return;
    if (dim && p.id !== 'pc' + sim.clientNum) g.classList.add('dimmed');
    else g.classList.remove('dimmed');
  });
  const sel = svgNode('pc' + sim.clientNum);
  if (sel) sel.classList.toggle('receiver', dim);
}
function markLink(a, b, on) {
  el('net').querySelectorAll('.link').forEach(l => {
    const [x, y] = l.dataset.link.split('|');
    if ((x === a && y === b) || (x === b && y === a)) l.classList.toggle('active', on);
  });
}

/* ===========================
   5. PACKET ANIMATION
   =========================== */

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Remove any in-flight packet sprites.
function clearPackets() {
  if (sim.anim) { cancelAnimationFrame(sim.anim.raf); sim.anim.resolve(); sim.anim = null; }
  el('net').querySelectorAll('.pkt').forEach(p => p.remove());
}

/**
 * Animate a packet along a path of node ids.
 * opts: {label, dir('req'|'res'), perHop(ms), changes:{nodeId:newLabel},
 *        hopLogs:{nodeId:'log text'}, dropAt:nodeId}
 */
function animatePacket(path, opts = {}) {
  return new Promise(resolve => {
    const pts = path.map(nodeById).filter(Boolean);
    if (pts.length < 2 || REDUCED) { resolve(); return; }

    const perHop = (opts.perHop || 380) / sim.speed;
    const svg = el('net');

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'pkt ' + (opts.dir === 'res' ? 'pkt-res' : 'pkt-req'));

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '8');
    g.appendChild(dot);

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hit.setAttribute('r', '18');
    hit.setAttribute('fill', 'transparent');
    hit.style.pointerEvents = 'all';
    hit.addEventListener('click', () => switchTab('inspector'));
    g.appendChild(hit);

    const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    labelBg.setAttribute('class', 'node-label-bg');
    g.appendChild(labelBg);

    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.textContent = opts.label || '';
    g.appendChild(txt);

    svg.appendChild(g);
    sim.stats.packets++;

    const placeLabel = s => {
      txt.textContent = s;
      const w = Math.max(24, s.length * 6.4 + 10);
      labelBg.setAttribute('x', -w / 2); labelBg.setAttribute('y', -30);
      labelBg.setAttribute('width', w); labelBg.setAttribute('height', 15);
      labelBg.setAttribute('rx', 4);
      txt.setAttribute('y', -19);
    };
    placeLabel(opts.label || '');

    let seg = 0, start = null;
    const total = pts.length - 1;

    const stepFn = ts => {
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / perHop);
      const a = pts[seg], b = pts[seg + 1];
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      g.setAttribute('transform', `translate(${x},${y})`);

      if (t >= 1) {
        markLink(path[seg], path[seg + 1], true);
        const arrived = path[seg + 1];
        if (opts.changes && opts.changes[arrived]) placeLabel(opts.changes[arrived]);
        if (opts.hopLogs && opts.hopLogs[arrived]) log(opts.hopLogs[arrived]);
        if (opts.dropAt === arrived) {
          g.setAttribute('class', 'pkt pkt-dropped');
          txt.textContent = '✕ dropped';
          sim.anim = null;
          setTimeout(() => { g.remove(); resolve(); }, 900 / sim.speed);
          return;
        }
        seg++;
        start = ts;
        if (seg >= total) {
          g.remove();
          sim.anim = null;
          resolve();
          return;
        }
      }
      sim.anim = { raf: requestAnimationFrame(stepFn), resolve };
    };
    sim.anim = { raf: requestAnimationFrame(stepFn), resolve };
  });
}

/* ===========================
   6. PANEL RENDERERS
   =========================== */

function renderNat() {
  const tb = el('nat-rows');
  tb.innerHTML = '';
  if (!sim.nat.length) {
    el('nat-note').textContent = 'Empty — created when the ' + natDeviceName() + ' translates the first outbound packet.';
    return;
  }
  el('nat-note').textContent = sim.multi
    ? 'All 5 PCs share ONE public IP. The router tells connections apart by the public port.'
    : 'Created at the NAT stage. The ' + natDeviceName() + ' rewrites source IP/port and remembers the mapping.';
  sim.nat.forEach(e => {
    const tr = document.createElement('tr');
    if (e.current) tr.className = 'current';
    const mk = txt => { const td = document.createElement('td'); td.textContent = txt; return td; };
    tr.appendChild(mk(`${e.internalIp}:${e.internalPort}`));
    tr.appendChild(mk('→'));
    tr.appendChild(mk(`${e.publicIp}:${e.publicPort}`));
    tr.appendChild(mk(e.dest + ' (simulated)'));
    tb.appendChild(tr);
  });
}

function renderDns() {
  const tb = el('dns-rows');
  tb.innerHTML = '';
  const names = Object.keys(sim.dns);
  el('dns-note').textContent = names.length ? 'Cached answer — reused until the TTL expires.' : 'Empty.';
  names.forEach(name => {
    const e = sim.dns[name];
    const tr = document.createElement('tr');
    [name, e.type, e.value + ' (simulated)', e.ttl + 's'].forEach(v => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
}

function renderArp() {
  const tb = el('arp-rows');
  tb.innerHTML = '';
  const keys = Object.keys(sim.arp);
  el('arp-note').textContent = keys.length ? 'Learned via ARP — local network only. ARP never crosses the Internet.' : 'Empty — populated during the ARP stage.';
  keys.forEach(ip => {
    const tr = document.createElement('tr');
    [ip, sim.arp[ip]].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
    tb.appendChild(tr);
  });
}

const ROUTING_TABLES = {
  wifi: {
    router: {
      note: 'Home router. Longest-prefix match; no LAN match → default route to the ISP.',
      rows: [['192.168.1.0/24', 'directly connected (LAN)', 'wlan0'],
             ['0.0.0.0/0', NET.router.ispGateway + ' (ISP)', 'wan0']]
    },
    isp: {
      note: 'ISP router (AS64500, simulated). Learned Google routes via BGP.',
      rows: [[NET.router.wanIp + '/32', 'customer link', 'cust1'],
             ['142.250.0.0/16', 'R1', 'core0', ], ['0.0.0.0/0', 'R1 (transit)', 'core0']]
    },
    r1: { note: 'Backbone R1 (AS64501). AS path so far: 64500 → 64501.', rows: [['142.250.0.0/16', 'R2', 'eth0']] },
    r2: { note: 'Backbone R2 (AS64501). Next hop R3. Not a real traceroute.', rows: [['142.250.0.0/16', 'R3', 'eth1']] },
    r3: { note: 'Backbone R3 (AS64501). Next hop R4.', rows: [['142.250.0.0/16', 'R4', 'eth1']] },
    r4: { note: "R4 peers with Google's edge (AS15169) via BGP. AS path: 64500 → 64501 → 15169.", rows: [['142.250.0.0/16', 'Google Edge (AS15169)', 'peer0']] },
    edge: { note: 'Google edge (simulated). Anycast can steer a user toward a nearby entry point.', rows: [['service VIPs', 'internal fabric', 'fabric0']] }
  },
  mobile: {
    cgnat: {
      note: 'Carrier-grade NAT. Many subscribers share a pool of public IPv4 addresses; your phone usually never holds a public IPv4 of its own.',
      rows: [['10.0.0.0/8 (subscribers)', 'translate → 198.51.100.0/24 pool', 'nat0'],
             ['0.0.0.0/0', 'carrier upstream', 'up0']]
    },
    isp: { note: 'Carrier edge into the public Internet (AS64500, simulated).', rows: [['142.250.0.0/16', 'R1', 'core0']] },
    r1: { note: 'Transit router (AS64501, simulated).', rows: [['142.250.0.0/16', 'R2', 'eth0']] },
    r2: { note: "R2 peers with Google's edge. AS path: 64500 → 64501 → 15169 (simulated).", rows: [['142.250.0.0/16', 'Google Edge (AS15169)', 'peer0']] },
    edge: { note: 'Google edge (simulated). Anycast may pick a nearby entry point.', rows: [['service VIPs', 'internal fabric', 'fabric0']] }
  }
};

function rebuildRoutingSelect() {
  const sel = el('rt-select');
  sel.innerHTML = '';
  const defs = isWifi() ? ROUTING_TABLES.wifi : ROUTING_TABLES.mobile;
  const names = isWifi()
    ? { router: 'Home router', isp: 'ISP router', r1: 'R1', r2: 'R2 (AS64501)', r3: 'R3', r4: 'R4', edge: 'Google Edge' }
    : { cgnat: 'Carrier CGNAT', isp: 'Carrier edge', r1: 'R1', r2: 'R2', edge: 'Google Edge' };
  Object.keys(defs).forEach(k => {
    const o = document.createElement('option');
    o.value = k; o.textContent = names[k] || k;
    sel.appendChild(o);
  });
  renderRouting(sel.value);
}

function renderRouting(key) {
  const defs = isWifi() ? ROUTING_TABLES.wifi : ROUTING_TABLES.mobile;
  const def = defs[key] || Object.values(defs)[0];
  el('rt-note').textContent = def.note;
  const tb = el('rt-rows');
  tb.innerHTML = '';
  def.rows.forEach(r => {
    const tr = document.createElement('tr');
    r.forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
    tb.appendChild(tr);
  });
}

/* ----- Packet inspector ----- */

function setKv(containerSel, pairs) {
  const dl = el(containerSel).querySelector('.kv');
  dl.innerHTML = '';
  pairs.forEach(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  });
}

const LIFECYCLE = ['CREATED', 'ENCAPSULATED', 'SENT', 'ROUTED', 'NAT TRANSLATED', 'FORWARDED', 'RECEIVED', 'DECAPSULATED'];

function showPacket(pkt, dirLabel, lifecycleAt) {
  el('insp-empty').hidden = true;
  el('insp-body').hidden = false;
  el('insp-dir-label').textContent = dirLabel;
  setKv('insp-l7', pkt.l7 || [['—', 'no application data on this step']]);
  setKv('insp-l4', pkt.l4 || [['—', 'n/a']]);
  setKv('insp-l3', pkt.l3 || [['—', 'n/a']]);
  setKv('insp-l2', pkt.l2 || [['—', 'n/a']]);
  const ol = el('insp-lifecycle');
  ol.innerHTML = '';
  LIFECYCLE.forEach((s, i) => {
    const li = document.createElement('li');
    li.textContent = s;
    li.className = i < lifecycleAt ? 'done' : (i === lifecycleAt ? 'now' : '');
    ol.appendChild(li);
  });
}

function hidePacket(msg) {
  el('insp-empty').hidden = false;
  el('insp-empty').textContent = msg || 'No packet on this step (local processing stage).';
  el('insp-body').hidden = true;
}

/* ----- Encapsulation panel ----- */

function renderEncap(direction) {
  const box = el('encap-box');
  box.innerHTML = '';
  const wrap = [
    { key: 'app', title: 'APPLICATION DATA', body: `HTTPS request  ████████████████████  (encrypted)` },
    { key: 'transport', title: 'TCP SEGMENT', body: `TCP  src port ${clientPort()} → dst port 443` },
    { key: 'internet', title: 'IP PACKET', body: `IPv4  ${clientIp()} → ${GOOGLE_IP} (simulated)` },
    { key: 'link', title: isWifi() ? 'WI-FI / ETHERNET FRAME' : 'CELLULAR LINK FRAME', body: isWifi() ? `MAC  ${client().mac} → ${NET.router.lanMac}` : 'cellular link layer — no MAC/ARP on this hop' }
  ];
  const layers = direction === 'res' ? [...wrap].reverse() : wrap;
  el('encap-cap').textContent = direction === 'res'
    ? 'Receiving side: the frame is UNWRAPPED — link → IP → TCP → application.'
    : 'Sending side: data is WRAPPED — application → TCP → IP → link. Click a layer to inspect it.';
  layers.forEach((l, i) => {
    const d = document.createElement('div');
    d.className = 'encap-layer';
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    const t = document.createElement('span'); t.className = 'encap-title'; t.textContent = l.title;
    const b = document.createElement('span'); b.textContent = l.body;
    d.appendChild(t); d.appendChild(b);
    const open = () => { activateLayer(l.key); switchTab('inspector'); };
    d.addEventListener('click', open);
    d.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    box.appendChild(d);
    if (i < layers.length - 1) {
      const ar = document.createElement('div');
      ar.className = 'encap-arrow';
      ar.textContent = '▼';
      box.appendChild(ar);
    }
  });
}

function activateLayer(key) {
  document.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === key));
  const map = { app: 'insp-l7', transport: 'insp-l4', internet: 'insp-l3', link: 'insp-l2' };
  Object.values(map).forEach(id => el(id).classList.remove('flash'));
  const target = el(map[key]);
  void target.offsetWidth; // restart CSS transition
  target.classList.add('flash');
}

/* ===========================
   7. DEVICE MODALS
   =========================== */

function kvHtml(pairs) {
  return '<dl class="kv">' + pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
}

function openNodeModal(id) {
  const m = el('modal');
  const title = el('modal-title');
  const body = el('modal-body');
  let html = '';

  if (isWifi() && id.startsWith('pc')) {
    const p = PCS.find(x => x.id === id);
    title.textContent = '💻 ' + p.name;
    html = kvHtml([
      ['Hostname', p.name],
      ['IPv4', p.ip + '  (private — RFC 1918)'],
      ['Subnet', p.subnet],
      ['MAC', p.mac],
      ['Gateway', p.gateway + '  (assigned via DHCP)'],
      ['DNS', p.dns + '  (router acts as DNS proxy)'],
      ['Connection', p.connection],
      ['Status', p.id === 'pc' + sim.clientNum ? '⭐ selected — initiates the request' : 'online — shares the same router'],
      ['Current connections', p.id === 'pc' + sim.clientNum && sim.nat.length ? `${p.ip}:${clientPort()} → ${GOOGLE_IP}:443 (TLS)` : '—']
    ]);
    html += '<p class="table-note">Private addresses like 192.168.x.x are not routed on the public Internet — that is why NAT exists.</p>';
  } else if (id === 'router' && isWifi()) {
    title.textContent = '📡 Wi-Fi Router';
    html = kvHtml([
      ['LAN interface', NET.router.lanIp + ' · MAC ' + NET.router.lanMac],
      ['WAN interface', NET.router.wanIp + ' (simulated public IP) · MAC ' + NET.router.wanMac],
      ['Default route', NET.router.ispGateway + ' (ISP)'],
      ['NAT', 'enabled — maps private sockets to public ports'],
      ['Also runs', 'DHCP server, DNS proxy']
    ]);
    html += '<h3>Routing table</h3>' + routingTableHtml('router');
  } else if (id === 'isp') {
    title.textContent = '🏢 ISP (simulated AS64500)';
    html = kvHtml([
      ['Role', 'Connects your home to the wider Internet'],
      ['Internal structure', 'Access router → Aggregation router → Core router'],
      ['BGP', 'Exchanges reachability with other autonomous systems']
    ]);
    html += '<p class="table-note">Your home router does NOT connect directly to Google. The ISP carries traffic from access, through aggregation, to its core and out to other networks.</p>';
    html += '<h3>Routing table</h3>' + routingTableHtml('isp');
  } else if (id.startsWith('r') && id.length === 2) {
    const n = nodeById(id);
    title.textContent = '🛣 ' + n.name + ' — Internet router (simulated)';
    html = kvHtml([
      ['Router ID', n.name.toUpperCase()],
      ['AS', n.ip],
      ['Destination of interest', GOOGLE_IP_LABEL],
      ['Next hop', nextHopOf(id)]
    ]);
    html += '<p class="table-note">Part of the SIMULATED INTERNET PATH. Real routes are learned dynamically (BGP) and change over time.</p>';
    html += '<h3>Routing table</h3>' + routingTableHtml(id);
  } else if (id === 'edge') {
    title.textContent = '🏢 Google Edge (simulated)';
    html = kvHtml([
      ['Destination', 'Google service entry point'],
      ['Anycast', 'Possible — the same IP can be announced from many locations; routing steers you to a nearby one'],
      ['Location', 'Simulated edge location'],
      ['AS', 'AS15169 (shown for teaching — the displayed path is not real)']
    ]);
    html += '<p class="table-note">The simulator has NOT identified your real Google server. Large services run globally distributed infrastructure.</p>';
  } else if (id === 'server') {
    title.textContent = '🖥 Google Server (simulated)';
    html = kvHtml([
      ['Status', '🟢 online'],
      ['Listening port', '443'],
      ['Protocol', 'HTTPS (TLS 1.3 shown; real services may also use HTTP/3 over QUIC/UDP)'],
      ['Address', GOOGLE_IP_LABEL],
      ['Role', 'Terminates TLS, serves the application response']
    ]);
  } else if (id === 'client') {
    title.textContent = '📱 Mobile client';
    html = kvHtml([
      ['Device IP', NET.mobile.deviceIp + '  (private — from the carrier)'],
      ['Public IPv4', 'The device normally does NOT get one'],
      ['Gateway', 'Mobile core (GGSN/PGW)'],
      ['Link', 'Cellular radio — no Ethernet MAC, no ARP on this hop']
    ]);
    html += '<p class="table-note">Mobile networks commonly place subscribers behind carrier-grade NAT (CGNAT).</p>';
  } else if (id === 'tower') {
    title.textContent = '📡 Cell Tower';
    html = kvHtml([['Role', 'Radio access between your device and the operator network'], ['Note', 'Radio hops are encrypted separately from TLS — two different layers.']]);
  } else if (id === 'core') {
    title.textContent = '🏢 Mobile Core';
    html = kvHtml([['Role', 'Operator core network: authentication, mobility, session management'], ['Hands traffic to', 'CGNAT, then the public Internet']]);
  } else if (id === 'cgnat') {
    title.textContent = '🔀 Carrier-Grade NAT (CGNAT)';
    html = kvHtml([
      ['Subscriber side', '10.0.0.0/8 private space (simulated)'],
      ['Shared space', '100.64.0.0/10 (RFC 6598)'],
      ['Public pool', NET.mobile.publicIp + ' … (simulated)'],
      ['Why', 'IPv4 exhaustion — many subscribers share few public addresses']
    ]);
    html += '<h3>Translation table</h3>' + routingTableHtml('cgnat');
  } else {
    title.textContent = id;
    html = '<p>Simulated node.</p>';
  }

  body.innerHTML = html;
  m.hidden = false;
  el('modal-close').focus();
}

function routingTableHtml(key) {
  const defs = isWifi() ? ROUTING_TABLES.wifi : ROUTING_TABLES.mobile;
  const def = defs[key];
  if (!def) return '<p class="table-note">(no table modeled for this node)</p>';
  return '<table class="data-table"><thead><tr><th>Destination</th><th>Next hop</th><th>Interface</th></tr></thead><tbody>' +
    def.rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') +
    '</tbody></table><p class="table-note">' + def.note + '</p>';
}

function nextHopOf(id) {
  const order = isWifi() ? ['r1', 'r2', 'r3', 'r4', 'edge', 'server'] : ['r1', 'r2', 'edge', 'server'];
  const i = order.indexOf(id);
  const nxt = order[i + 1];
  if (!nxt) return '—';
  const names = { r1: 'R1', r2: 'R2', r3: 'R3', r4: 'R4', edge: 'Google Edge', server: 'Google Server' };
  return names[nxt] || nxt;
}

/* ===========================
   8. STAGE DEFINITIONS (data-driven)
   =========================== */

const OUT_PATH_WIFI = () => [client().id, 'router', 'isp', 'r1', 'r2', 'r3', 'r4', 'edge', 'server'];
const IN_PATH_WIFI_TO_ROUTER = () => ['server', 'edge', 'r4', 'r3', 'r2', 'r1', 'isp', 'router'];
const OUT_PATH_MOBILE = () => ['client', 'tower', 'core', 'cgnat', 'isp', 'r1', 'r2', 'edge', 'server'];
const IN_PATH_MOBILE_TO_CGNAT = () => ['server', 'edge', 'r2', 'r1', 'isp', 'cgnat'];

const outPath = () => isWifi() ? OUT_PATH_WIFI() : OUT_PATH_MOBILE();
const inPathToNat = () => isWifi() ? IN_PATH_WIFI_TO_ROUTER() : IN_PATH_MOBILE_TO_CGNAT();

// Packet templates ------------------------------------------------

function dnsQueryPacket() {
  return {
    l7: [['Protocol', 'DNS query'], ['Name', sim.domain], ['Type', 'A (IPv4 address)'], ['Recursion', 'desired']],
    l4: [['Protocol', 'UDP'], ['Source port', '53210'], ['Destination port', '53']],
    l3: [['Source IP', clientIp()], ['Destination IP', isWifi() ? NET.gateway : 'carrier resolver (simulated)'], ['TTL', '64']],
    l2: isWifi() ? [['Source MAC', client().mac], ['Destination MAC', NET.router.lanMac]] : [['Link', 'cellular — no MAC/ARP']]
  };
}
function dnsResponsePacket() {
  return {
    l7: [['Protocol', 'DNS response'], ['Answer', sim.domain + ' → ' + GOOGLE_IP + ' (SIMULATED)'], ['TTL', '300s']],
    l4: [['Protocol', 'UDP'], ['Source port', '53'], ['Destination port', '53210']],
    l3: [['Source IP', isWifi() ? NET.gateway : 'carrier resolver'], ['Destination IP', clientIp()], ['TTL', '64']],
    l2: isWifi() ? [['Source MAC', NET.router.lanMac], ['Destination MAC', client().mac]] : [['Link', 'cellular']]
  };
}
function tcpPacket(kind) {
  const out = kind === 'SYN' || kind === 'ACK' || kind === 'DATA-REQ';
  const flags = { SYN: 'SYN seq=1000', 'SYN-ACK': 'SYN+ACK seq=5000 ack=1001', ACK: 'ACK ack=5001', 'DATA-REQ': 'PSH+ACK (carrying TLS)' }[kind] || 'ACK';
  return {
    l7: [['Application', 'TLS / HTTPS goes here (not established yet)']],
    l4: [['Protocol', 'TCP'], [out ? 'Source port' : 'Source port', String(out ? clientPort() : 443)], ['Destination port', String(out ? 443 : publicPort() + ' → ' + clientPort())], ['Flags', flags]],
    l3: out
      ? [['Source IP', clientIp() + ' → NAT → ' + publicIp()], ['Destination IP', GOOGLE_IP + ' (simulated)'], ['TTL', '64, decremented each router hop']]
      : [['Source IP', GOOGLE_IP + ' (simulated)'], ['Destination IP', publicIp() + ' → NAT → ' + clientIp()], ['TTL', '≈55 on arrival (simulated)']],
    l2: isWifi()
      ? [['First hop MACs', out ? client().mac + ' → ' + NET.router.lanMac : NET.router.lanMac + ' → ' + client().mac], ['Note', 'MACs are rewritten at every routed hop']]
      : [['Link', 'cellular (first hop), then Ethernet-like links at each routed hop']]
  };
}
function tlsPacket(phase) {
  const base = tcpPacket('DATA-REQ');
  if (phase === 'clienthello') {
    base.l7 = [['TLS record', 'ClientHello'], ['Version offered', 'TLS 1.3'], ['SNI', sim.domain + ' (visible — hostname is not encrypted in classic TLS)'], ['Key share', 'simulated x25519 public value']];
  } else if (phase === 'serverhello') {
    base.l7 = [['TLS record', 'ServerHello + Certificate'], ['Chosen cipher', 'TLS_AES_256_GCM_SHA384 (TLS 1.3)'], ['Certificate', 'CN=' + sim.domain + ' (simulated)'], ['Key share', 'simulated server public value']];
  } else {
    base.l7 = [['TLS record', 'Handshake finished'], ['Result', 'Symmetric session keys derived — channel encrypted'], ['Keys', 'never shown — simulated values only']];
  }
  return base;
}
function httpsReqPacket() {
  return {
    l7: [['SIMULATED HTTPS REQUEST', 'GET /  Host: ' + sim.domain], ['On the wire', '████████████████████ (encrypted application data)'], ['Visible to observers', 'IPs, ports, timing, sizes — NOT the content']],
    l4: [['Protocol', 'TCP'], ['Source port', String(clientPort())], ['Destination port', '443']],
    l3: [['Source IP', clientIp() + ' → NAT → ' + publicIp()], ['Destination IP', GOOGLE_IP + ' (simulated)'], ['TTL', '64 at source']],
    l2: isWifi() ? [['Source MAC', client().mac], ['Destination MAC', NET.router.lanMac]] : [['Link', 'cellular first hop']]
  };
}
function httpsRespPacket() {
  return {
    l7: [['SIMULATED HTTPS RESPONSE', 'HTTP 200 OK'], ['Content', 'HTML + CSS + JavaScript + images (encrypted on the wire)'], ['Length', '≈18 KB simulated']],
    l4: [['Protocol', 'TCP'], ['Source port', '443'], ['Destination port', publicPort() + ' — rewritten by NAT to ' + clientPort()]],
    l3: [['Source IP', GOOGLE_IP + ' (simulated)'], ['Destination IP', publicIp() + ' → NAT → ' + clientIp()], ['TTL', '≈55 on arrival (simulated)']],
    l2: isWifi() ? [['Final hop MACs', NET.router.lanMac + ' → ' + client().mac]] : [['Final hop', 'CGNAT → mobile core → tower → your device']]
  };
}

// NAT translation label change at the NAT node when animating
const natNodeId = () => isWifi() ? 'router' : 'cgnat';
const natOutChange = () => ({ [natNodeId()]: `→ ${publicIp()}:${publicPort()}` });
const natInChange = () => ({ [natNodeId()]: `→ ${clientIp()}:${clientPort()}` });

// Hop-by-hop teaching logs on the FIRST full outbound traversal
function firstOutHopLogs() {
  const m = {};
  m[natNodeId()] = `NAT: ${clientIp()}:${clientPort()} rewritten to ${publicIp()}:${publicPort()} (simulated translation)`;
  m.isp = 'ISP: access network → aggregation → ISP core (packet leaves your neighborhood)';
  m[isWifi() ? 'r1' : 'r1'] = 'R1 (transit, simulated): forwarding toward 142.250.x.x — TTL decremented';
  if (isWifi()) m.r2 = 'R2: forwarding — next hop R3';
  m.r3 = 'R3: forwarding — next hop R4';
  m.r4 = 'R4: handing traffic to Google edge via a BGP-learned route (simulated)';
  if (!isWifi()) m.r2 = 'R2: handing traffic to Google edge via a BGP-learned route (simulated)';
  m.edge = 'Google Edge (AS15169, simulated): anycast-style entry point accepts the connection';
  if (isWifi()) { m.tower = undefined; }
  return m;
}

/* ----- Stage list ----- */

function buildStages() {
  const S = [];
  const dirBadge = { req: '➜ REQUEST · client → server', res: '⬅ RESPONSE · server → client', local: 'LOCAL · no packet on the wire' };

  // --- setup ---
  S.push({
    id: 'setup',
    title: isWifi() ? 'Network setup — DHCP gave your PC an address' : 'Network attach — the carrier gave your device an address',
    proto: isWifi() ? 'DHCP (UDP 67/68)' : 'Mobile attach',
    dir: 'local',
    explain: {
      beginner: isWifi()
        ? `Before anything else, ${clientLabel()} asked the router for network settings (DHCP) and received its IP address, gateway and DNS server.`
        : 'Your phone attached to the mobile network and received an IP address from the carrier — usually a private address, not a public one.',
      intermediate: isWifi()
        ? `${clientLabel()} completed DHCP Discover/Offer/Request/Ack with ${NET.gateway} and now holds ${clientIp()} in ${NET.lan}, gateway ${NET.gateway}, DNS ${NET.gateway}.`
        : `The attach procedure established a data session; the device received ${NET.mobile.deviceIp} (private). Carriers commonly sit subscribers behind CGNAT.`,
      technical: isWifi()
        ? `DHCP lease (simulated): yiaddr ${clientIp()}/24, router ${NET.gateway}, DNS ${NET.gateway}. The address space 192.168.0.0/16 is RFC 1918 private and is dropped by public routers.`
        : `Session established via the packet core (GGSN/PGW or 5G UPF analogue). Subscriber address ${NET.mobile.deviceIp} is RFC 1918; NAT44 at the carrier edge (CGNAT) provides public reachability.`
    },
    learn: {
      what: isWifi() ? `${clientLabel()} got IP ${clientIp()}, gateway and DNS from the router.` : `The device got ${NET.mobile.deviceIp} from the carrier.`,
      why: 'A device needs an address, a default gateway and a resolver before it can use IP at all.',
      proto: isWifi() ? 'DHCP over UDP (ports 67/68)' : 'Mobile network attach / session setup',
      visible: isWifi() ? 'Broadcast DHCP traffic on the local Wi-Fi only.' : 'Signaling between device, tower and mobile core.',
      changes: 'The client becomes addressable on its local network.'
    },
    onEnter() {
      hidePacket();
      renderEncap('req');
      log(isWifi() ? `DHCP: ${clientLabel()} leased ${clientIp()} (gateway ${NET.gateway}, DNS ${NET.gateway})` : `Mobile: device attached, assigned ${NET.mobile.deviceIp} (private, carrier NAT)`);
      highlightNodes([isWifi() ? client().id : 'client', isWifi() ? 'router' : 'core']);
    }
  });

  // --- URL ---
  S.push({
    id: 'url',
    title: 'You type ' + sim.domain,
    proto: 'Browser',
    dir: 'local',
    explain: {
      beginner: `You typed "${sim.domain}" and pressed GO. The browser understands names — but the network only understands IP addresses.`,
      intermediate: `The browser parses the URL: scheme=https, host=${sim.domain}, port=443 (default for HTTPS). It now needs an IP address for ${sim.domain}.`,
      technical: `URL parse: https://${sim.domain}/ → host "${sim.domain}", implicit port 443. The stub resolver will be queried because hosts file / caches are checked first (next step).`
    },
    learn: {
      what: `The browser received a domain name: ${sim.domain}.`,
      why: 'Humans use names; IP packets only carry numeric addresses.',
      proto: '(browser URL parsing — no network traffic yet)',
      visible: 'Nothing on the wire yet.',
      changes: `The browser knows it must connect to ${sim.domain}:443 over HTTPS.`
    },
    onEnter() {
      hidePacket();
      el('browser-url').textContent = 'https://' + sim.domain;
      log(`Browser: ${sim.domain} entered`);
      highlightNodes([isWifi() ? client().id : 'client']);
    }
  });

  // --- DNS cache ---
  S.push({
    id: 'dns-cache',
    title: 'Check local DNS cache first',
    proto: 'DNS cache',
    dir: 'local',
    explain: {
      beginner: 'The browser asks: have I looked this up recently? If a cached answer is still valid (TTL), no network traffic is needed at all.',
      intermediate: 'The browser/OS check their resolver caches. On a cold start the entry is missing (or expired), so a real DNS query is required.',
      technical: 'Stub resolver checks browser cache → OS cache → hosts file. Miss → build a recursive query for an A record toward the configured resolver.'
    },
    learn: {
      what: 'Cache checked — no valid entry for ' + sim.domain + '.',
      why: 'Caching avoids repeating lookups; TTL controls how long an answer may be reused.',
      proto: 'DNS (cache lookup — local only)',
      visible: 'Nothing on the wire.',
      changes: 'Decision: send a DNS query.'
    },
    onEnter() {
      hidePacket();
      log('DNS: cache miss for ' + sim.domain + ' — query required');
      renderDns();
      highlightNodes([isWifi() ? client().id : 'client']);
    }
  });

  // --- DNS query ---
  S.push({
    id: 'dns-query',
    title: 'DNS query goes out',
    proto: 'DNS · UDP · port 53',
    dir: 'req',
    packet: dnsQueryPacket,
    lifecycle: 2,
    animate: () => ({
      path: isWifi() ? [client().id, 'router'] : ['client', 'tower', 'core'],
      label: `DNS? ${sim.domain}`, dir: 'req', perHop: 420
    }),
    explain: {
      beginner: `${clientLabel()} asks the DNS resolver: "what is the IP address of ${sim.domain}?"`,
      intermediate: `A DNS query (type A) for ${sim.domain} is sent over UDP to the resolver at ${isWifi() ? NET.gateway + ' — your router proxies it to the ISP resolver' : 'the carrier resolver'} on port 53. The resolver does the recursive work.`,
      technical: `Query ${sim.domain} IN A + RD flag via UDP/53 (encrypted DNS transports such as DoH/DoT also exist but are not modeled). The recursive resolver would walk root → .com TLD → authoritative servers on a miss; the simulation collapses this recursion into one reply.`
    },
    learn: {
      what: `${clientLabel()} sent a DNS query for ${sim.domain}.`,
      why: 'The browser needs an IP address before any connection can be opened.',
      proto: 'DNS', 
      visible: 'The query name is visible on the wire in classic DNS (unless DoH/DoT is used).',
      changes: 'Resolver starts resolving.'
    },
    onEnter() {
      log('DNS: query created — ' + sim.domain + ' (type A, UDP, dst port 53)');
      highlightNodes(isWifi() ? [client().id, 'router'] : ['client', 'tower', 'core']);
    }
  });

  // --- DNS response ---
  S.push({
    id: 'dns-response',
    title: 'DNS response — ' + GOOGLE_IP_LABEL,
    proto: 'DNS · UDP · port 53',
    dir: 'res',
    packet: dnsResponsePacket,
    lifecycle: 7,
    animate: () => ({
      path: isWifi() ? ['router', client().id] : ['core', 'tower', 'client'],
      label: `DNS → ${GOOGLE_IP}`, dir: 'res', perHop: 420
    }),
    explain: {
      beginner: `The resolver answers: ${sim.domain} is at ${GOOGLE_IP}. This address is SIMULATED — real answers change all the time and there are usually several.`,
      intermediate: `Response: ${sim.domain} A ${GOOGLE_IP} (SIMULATED), TTL 300s. The client caches it. Real resolvers return multiple rotating addresses.`,
      technical: 'Answer section carries the A record(s) with TTL. Stub caches until expiry. Real-world: anycasted/rotated pools, geo-aware answers — none of that is modeled here; 142.250.x.x is illustrative.'
    },
    learn: {
      what: `Received ${GOOGLE_IP} (simulated).`,
      why: 'DNS translates domain names into IP addresses.',
      proto: 'DNS',
      visible: 'Answer visible in classic DNS; TTL tells the client how long it may cache it.',
      changes: 'DNS cache populated; the browser can now open a connection.'
    },
    onEnter() {
      sim.dns[sim.domain] = { type: 'A', value: GOOGLE_IP, ttl: 300 };
      renderDns();
      log(`DNS: response received — ${sim.domain} → ${GOOGLE_IP} (simulated, TTL 300s)`, 'ok');
      highlightNodes([isWifi() ? client().id : 'client']);
    }
  });

  // --- ARP (Wi-Fi only) ---
  if (isWifi()) {
    S.push({
      id: 'arp-req',
      title: 'ARP — who has the gateway?',
      proto: 'ARP (link-local)',
      dir: 'req',
      lifecycle: 2,
      animate: () => ({
        path: [client().id, 'router'],
        label: `ARP: who has ${NET.gateway}?`, dir: 'req', perHop: 520,
        dropAt: null
      }),
      explain: {
        beginner: `To hand the packet to the router, ${clientLabel()} needs the router's MAC address. It shouts on the local Wi-Fi: "Who has ${NET.gateway}?"`,
        intermediate: `${clientLabel()} broadcasts an ARP request for ${NET.gateway}. Every device on the LAN hears it; only the owner replies. ARP exists ONLY on the local link — it never crosses the Internet.`,
        technical: 'ARP request is an L2 broadcast (ff:ff:ff:ff:ff:ff) asking for the MAC of the gateway IPv4. Target Protocol Address = 192.168.1.1. Responses may be unicast.'
      },
      learn: {
        what: 'ARP request broadcast for ' + NET.gateway + '.',
        why: 'IP gets the packet to the local network; the link layer needs a MAC address to deliver the frame.',
        proto: 'ARP',
        visible: 'Broadcast — all five PCs see it.',
        changes: 'None yet — waiting for a reply.'
      },
      onEnter() {
        log(`ARP: ${clientLabel()} asks "who has ${NET.gateway}?" (broadcast)`);
        highlightNodes([client().id, 'router']);
      }
    });
    S.push({
      id: 'arp-resp',
      title: 'ARP reply — gateway MAC learned',
      proto: 'ARP (link-local)',
      dir: 'res',
      lifecycle: 7,
      animate: () => ({
        path: ['router', client().id],
        label: `ARP: ${NET.gateway} is ${NET.router.lanMac}`, dir: 'res', perHop: 520
      }),
      explain: {
        beginner: `The router answers: "${NET.gateway} is at ${NET.router.lanMac}". ${clientLabel()} stores this in its ARP cache.`,
        intermediate: `Router replies (usually unicast): ${NET.gateway} → ${NET.router.lanMac}. The entry is cached so ARP is not repeated for every packet.`,
        technical: 'ARP reply populates the neighbor cache entry (IP→MAC), typically with a timeout. Gratuitous ARP and cache poisoning exist — that is why ARP spoofing is a classic LAN attack.'
      },
      learn: {
        what: 'Learned gateway MAC ' + NET.router.lanMac + '.',
        why: 'Frames to the gateway can now be addressed at layer 2.',
        proto: 'ARP',
        visible: 'Reply on the local link only.',
        changes: 'ARP cache populated: ' + NET.gateway + ' → ' + NET.router.lanMac + '.'
      },
      onEnter() {
        sim.arp[NET.gateway] = NET.router.lanMac;
        renderArp();
        log(`ARP: gateway MAC resolved — ${NET.gateway} is ${NET.router.lanMac}`, 'ok');
        highlightNodes([client().id]);
      }
    });
  }

  // --- BGP / routing overview ---
  S.push({
    id: 'bgp',
    title: 'How the Internet finds Google — routing & BGP',
    proto: 'IP routing + BGP',
    dir: 'local',
    explain: {
      beginner: 'Between you and Google sit many networks. Each router only knows the NEXT hop, agreed via routing protocols. The chain shown here is SIMULATED — real paths are dynamic.',
      intermediate: 'Routers forward hop-by-hop using longest-prefix match on the destination IP. Between organisations, BGP advertises which IP ranges each Autonomous System (AS) can reach. Shown: AS64500 (ISP) → AS64501 (transit) → AS15169 (Google) — simulated teaching path.',
      technical: 'BGP exchanges reachability (prefixes + AS_PATH) between ASes; it does not pin individual packets to a route. Within each AS, an IGP + forwarding tables pick next hops. The displayed AS numbers/routers are illustrative, not live BGP data.'
    },
    learn: {
      what: 'Forwarding plan: longest-prefix match hop-by-hop; BGP glues the ASes together.',
      why: 'No single device knows the whole Internet — reachability is distributed knowledge.',
      proto: 'BGP between ASes; longest-prefix routing inside routers',
      visible: 'Packets do not carry their route. Each router decides locally.',
      changes: 'Nothing on the wire — this is the map the next packets will ride on.'
    },
    onEnter() {
      hidePacket('Routing overview stage — no packet moving.');
      log('BGP (overview): AS path 64500 → 64501 → 15169 (SIMULATED — not a live route)');
      highlightNodes(isWifi() ? ['isp', 'r2', 'edge'] : ['isp', 'r1', 'edge']);
      switchTabSilentlyHint();
    }
  });

  // --- TCP handshake ---
  S.push({
    id: 'tcp-syn',
    title: 'TCP handshake 1/3 — SYN',
    proto: 'TCP · port 443',
    dir: 'req',
    packet: () => tcpPacket('SYN'),
    lifecycle: 4,
    animate: () => ({
      path: outPath(), label: 'SYN ' + clientPort() + '→443', dir: 'req', perHop: 420,
      changes: natOutChange(), hopLogs: firstOutHopLogs()
    }),
    explain: {
      beginner: `${clientLabel()} says hello: "I want to talk (SYN), on port 443 — the HTTPS port." On the way out, your ${natDeviceName()} rewrites the source address (NAT).`,
      intermediate: `SYN with source port ${clientPort()} (ephemeral) → destination 443. At the ${natDeviceName()}, ${clientIp()}:${clientPort()} becomes ${publicIp()}:${publicPort()} and the mapping is stored. TTL decrements at every router.`,
      technical: `TCP SYN (seq 1000, simulated), ephemeral/${clientPort()} → https/443. NAT44 translates the tuple and records (${clientIp()}:${clientPort()} ↔ ${publicIp()}:${publicPort()}, dst ${GOOGLE_IP}:443). MAC headers are rebuilt per hop; IP addresses are end-to-end (until NAT).`
    },
    learn: {
      what: 'SYN sent; NAT entry created.',
      why: 'TCP needs a three-way handshake before data can flow. NAT lets many devices share one public IPv4.',
      proto: 'TCP handshake + NAT44',
      visible: 'IPs/ports visible in clear; private addresses never leave your network.',
      changes: `NAT table gains ${clientIp()}:${clientPort()} → ${publicIp()}:${publicPort()}.`
    },
    onEnter() {
      // Simulated NAT translation. This is not a real network connection.
      sim.nat = [];
      if (sim.multi && isWifi()) {
        PCS.forEach((p, i) => {
          sim.nat.push({ internalIp: p.ip, internalPort: 50001 + i, publicIp: publicIp(), publicPort: 40001 + i, dest: GOOGLE_IP + ':443', current: i === sim.clientNum - 1 });
        });
        log('NAT: 5 PCs share one public IP — router tells them apart by public port (40001–40005)');
      } else {
        sim.nat.push({ internalIp: clientIp(), internalPort: clientPort(), publicIp: publicIp(), publicPort: publicPort(), dest: GOOGLE_IP + ':443', current: true });
      }
      renderNat();
      el('cmp-nat').hidden = true;
      log(`TCP: SYN sent from ${clientLabel()} (${clientIp()}:${clientPort()})`);
    }
  });

  S.push({
    id: 'tcp-synack',
    title: 'TCP handshake 2/3 — SYN-ACK comes back',
    proto: 'TCP · port 443',
    dir: 'res',
    packet: () => tcpPacket('SYN-ACK'),
    lifecycle: 6,
    animate: () => ({
      path: [...outPath()].reverse(), label: 'SYN-ACK 443→' + publicPort(), dir: 'res', perHop: 200,
      changes: natInChange()
    }),
    explain: {
      beginner: `The server answers: "OK, I hear you (SYN-ACK)!" Watch the direction flip — this is the RESPONSE travelling home.`,
      intermediate: `The reply is addressed to ${publicIp()}:${publicPort()}. When it reaches the ${natDeviceName()}, the NAT mapping converts it back to ${clientIp()}:${clientPort()} — that is how it reaches ${clientLabel()} and not a neighbor.`,
      technical: 'SYN-ACK dst = the NAT public tuple. Stateful NAT reverse-translates via the stored mapping and forwards to the internal socket. This demultiplexing by port is the core of the return path.'
    },
    learn: {
      what: 'SYN-ACK received after travelling the whole path back.',
      why: 'The server acknowledges your SYN and sends its own sequence number.',
      proto: 'TCP handshake',
      visible: 'Reverse NAT at the edge of your network rebuilt the destination as ' + clientIp() + ':' + clientPort() + '.',
      changes: 'Connection half-open on both sides.'
    },
    onEnter() { log('TCP: SYN-ACK received' + (isWifi() ? ' (NAT mapped it back to ' + clientLabel() + ')' : ' (CGNAT mapped it back to your device)'), 'ok'); highlightNodes([isWifi() ? client().id : 'client']); }
  });

  S.push({
    id: 'tcp-ack',
    title: 'TCP handshake 3/3 — ACK',
    proto: 'TCP · port 443',
    dir: 'req',
    packet: () => tcpPacket('ACK'),
    lifecycle: 4,
    animate: () => ({ path: outPath(), label: 'ACK', dir: 'req', perHop: 200, changes: natOutChange() }),
    explain: {
      beginner: `${clientLabel()} answers: "Got it (ACK)!" The TCP connection is now open.`,
      intermediate: 'The ACK completes the three-way handshake. Both sides now have synchronized sequence numbers and the connection is ESTABLISHED.',
      technical: 'ACK(ack=5001) — connection enters ESTABLISHED state. One round trip spent; no data yet. (TCP Fast Open / 0-RTT alternatives exist but are not modeled.)'
    },
    learn: {
      what: 'ACK sent — connection ESTABLISHED.',
      why: 'Both sides must confirm they can send and receive.',
      proto: 'TCP handshake',
      visible: 'Still just headers — no application data.',
      changes: 'Reliable byte stream ready for TLS.'
    },
    onEnter() { log('TCP: ACK sent — connection established', 'ok'); highlightNodes([isWifi() ? client().id : 'client', 'server']); }
  });

  // --- TLS ---
  S.push({
    id: 'tls-clienthello',
    title: 'TLS handshake — ClientHello',
    proto: 'TLS 1.3',
    dir: 'req',
    packet: () => tlsPacket('clienthello'),
    lifecycle: 4,
    animate: () => ({ path: outPath(), label: 'TLS ClientHello', dir: 'req', perHop: 200, changes: natOutChange() }),
    explain: {
      beginner: `${clientLabel()} proposes encryption settings: "I speak TLS 1.3; here are my options."`,
      intermediate: `ClientHello offers TLS 1.3 parameters, ciphers and a key share, and carries SNI=${sim.domain} — the hostname, which observers can still see.`,
      technical: 'TLS 1.3 ClientHello: supported_versions, cipher_suites, key_share (simulated x25519), SNI extension in cleartext unless ECH is deployed (not modeled). Session keys are NOT transmitted — they are derived later.'
    },
    learn: {
      what: 'ClientHello sent inside the TCP connection.',
      why: 'Both sides must agree on encryption before any web data flows.',
      proto: 'TLS 1.3 handshake',
      visible: 'SNI hostname and client parameters (visible); no keys yet.',
      changes: 'Server can now pick parameters and prove its identity.'
    },
    onEnter() { log('TLS: ClientHello sent (SNI=' + sim.domain + ')'); highlightNodes([isWifi() ? client().id : 'client', 'server']); }
  });

  S.push({
    id: 'tls-serverhello',
    title: 'TLS handshake — ServerHello + certificate',
    proto: 'TLS 1.3',
    dir: 'res',
    packet: () => tlsPacket('serverhello'),
    lifecycle: 6,
    animate: () => ({ path: [...outPath()].reverse(), label: 'TLS ServerHello + Cert', dir: 'res', perHop: 200, changes: natInChange() }),
    explain: {
      beginner: `The server replies: "Let's use these settings" and shows its certificate — its ID card proving it really is ${sim.domain}. The browser checks it.`,
      intermediate: `ServerHello picks TLS_AES_256_GCM_SHA384 and returns a certificate chain for ${sim.domain} (simulated). The browser validates signatures, hostname match and expiry against trusted CAs.`,
      technical: 'Server sends ServerHello, encrypted extensions, certificate + CertificateVerify (proof of the private key). Both sides derive shared secrets from the ephemeral key shares. Simulated values only — no real keys are generated.'
    },
    learn: {
      what: 'ServerHello + certificate received and validated.',
      why: 'Encryption without identity would be useless — the certificate binds the keys to ' + sim.domain + '.',
      proto: 'TLS 1.3 handshake + X.509 certificate validation',
      visible: 'The certificate itself (it is public information); key shares are public components, not secrets.',
      changes: 'Session keys derived — an encrypted channel exists.'
    },
    onEnter() { log('TLS: ServerHello + certificate received and validated (simulated)', 'ok'); highlightNodes([isWifi() ? client().id : 'client', 'server']); }
  });

  S.push({
    id: 'tls-established',
    title: 'Encrypted channel established 🔐',
    proto: 'TLS 1.3 · HTTPS ready',
    dir: 'local',
    packet: () => tlsPacket('established'),
    lifecycle: 7,
    explain: {
      beginner: 'From now on, everything inside the connection is encrypted. Observers can see WHO you talk to and roughly how much data — but not the content.',
      intermediate: 'Handshake finished messages confirm both sides derived identical session keys. The padlock in the address bar now reflects an authenticated, encrypted channel.',
      technical: 'AEAD (AES-256-GCM here, simulated) protects records with confidentiality + integrity. Metadata still leaks: destination IP, SNI (classically), traffic volume and timing.'
    },
    learn: {
      what: 'TLS setup finished — the channel is encrypted.',
      why: 'So nobody between you and the server can read or modify the page.',
      proto: 'TLS 1.3 record protection',
      visible: 'Encrypted records only. Metadata (IPs, sizes, timing) remains.',
      changes: 'The browser can finally send the actual web request.'
    },
    onEnter() {
      hidePacket('Local stage — keys derived on both ends.');
      el('browser-bar').classList.add('secure');
      log('TLS: handshake completed — encrypted channel up 🔐', 'ok');
      renderEncap('req');
      highlightNodes([isWifi() ? client().id : 'client', 'server']);
    }
  });

  // --- HTTPS request ---
  S.push({
    id: 'https-request',
    title: 'HTTPS request — GET / (encrypted)',
    proto: 'HTTPS over TLS',
    dir: 'req',
    packet: httpsReqPacket,
    lifecycle: 4,
    animate: () => ({ path: outPath(), label: 'GET / 🔒', dir: 'req', perHop: 200, changes: natOutChange() }),
    explain: {
      beginner: 'The browser finally asks for the page: "GET /". On the wire it is just encrypted noise — even routers that carry it cannot read it.',
      intermediate: 'Request line + headers (Host: ' + sim.domain + ') travel as TLS application data. Wasmé: routers forward the ciphertext; only the two endpoints hold the keys.',
      technical: 'SIMULATED HTTPS REQUEST: GET / HTTP/2-style, protected as TLS application_data records. Middleboxes see TCP/IP headers and record sizes only.'
    },
    learn: {
      what: 'Encrypted GET / request sent to the server.',
      why: 'This is the actual "give me the page" message.',
      proto: 'HTTPS (HTTP inside TLS inside TCP)',
      visible: 'Ciphertext + metadata. Not the URL path, not headers.',
      changes: 'The server can now build the response.'
    },
    onEnter() { log('HTTPS: GET / sent (encrypted, simulated request)'); highlightNodes([isWifi() ? client().id : 'client', 'server']); renderEncap('req'); }
  });

  // --- Server processing ---
  S.push({
    id: 'server-processing',
    title: 'Google builds the response',
    proto: 'Server side',
    dir: 'local',
    packet: httpsRespPacket,
    lifecycle: 0,
    explain: {
      beginner: 'The server decrypts your request, finds the page, and prepares the answer: 200 OK with HTML, CSS, JavaScript and images.',
      intermediate: 'The front end terminates TLS, the service generates the response (200 OK + content), and the whole thing is encrypted back toward your connection tuple.',
      technical: 'SIMULATED. Real Google serving involves负载 balancers, edge caches and many internal RPCs. Here: one server object replies 200 OK.'
    },
    learn: {
      what: 'Response generated: HTTP 200 OK.',
      why: 'The server processes the request and produces the page.',
      proto: 'HTTP semantics (inside TLS)',
      visible: 'To the network: encrypted response bytes addressed to ' + publicIp() + ':' + publicPort() + '.',
      changes: 'The RESPONSE JOURNEY begins — direction flips for good.'
    },
    onEnter() {
      log('Google: request decrypted, response generated — 200 OK (HTML/CSS/JS/images)', 'ok');
      highlightNodes(['server']);
      renderEncap('res');
    }
  });

  // --- Response journey ---
  S.push({
    id: 'response-journey',
    title: '⬅ RESPONSE travels back across the Internet',
    proto: 'TCP · carrying TLS',
    dir: 'res',
    packet: httpsRespPacket,
    lifecycle: 6,
    animate: () => ({ path: inPathToNat(), label: '200 OK 🔒 → ' + publicIp() + ':' + publicPort(), dir: 'res', perHop: 280,
      hopLogs: isWifi() ? { r4: 'Response: R4 → R3 (reverse path, still simulated)' } : {} }),
    explain: {
      beginner: '⬅ RESPONSE STARTS HERE. The answer is addressed to your PUBLIC address and port — the one NAT created. It hops back across the Internet toward your ' + natDeviceName() + '.',
      intermediate: `The response crosses backbone routers toward ${publicIp()}:${publicPort()}. Nothing in the packet names ${clientLabel()} — only the NAT mapping will reconnect it.`,
      technical: 'Forward and return paths can differ in reality (asymmetric routing); the simulator reuses one path for clarity. Destination tuple (public IP + port) is the only handle the network has.'
    },
    learn: {
      what: 'Encrypted response hops back through ISP/backbone routers.',
      why: 'Routers forward toward the destination IP — your public NAT address.',
      proto: 'IP routing (TTL decrementing again)',
      visible: 'Headers: ' + GOOGLE_IP + ':443 → ' + publicIp() + ':' + publicPort() + ' (ciphertext payload).',
      changes: 'Packet arrives at your ' + natDeviceName() + '.'
    },
    onEnter() {
      log('RESPONSE: travelling back server → internet → ' + (isWifi() ? 'home router' : 'CGNAT'));
      highlightNodes(isWifi() ? ['server', 'isp'] : ['server', 'cgnat']);
    }
  });

  // --- NAT response ---
  S.push({
    id: 'nat-response',
    title: '⬅ NAT lookup — which device gets this?',
    proto: 'Stateful NAT',
    dir: 'res',
    packet: httpsRespPacket,
    lifecycle: 7,
    explain: {
      beginner: `THE KEY MOMENT. The ${natDeviceName()} looks up ${publicIp()}:${publicPort()} in its table and finds: "that belongs to ${clientLabel()} at ${clientIp()}:${clientPort()}". That is why the page goes to the RIGHT computer — not ${isWifi() ? 'PC1, PC2, PC4 or PC5' : 'another subscriber'}.`,
      intermediate: `Stateful NAT match on destination port ${publicPort()} → rewrite destination to ${clientIp()}:${clientPort()} → forward to the LAN. Without the stored mapping, the router could not choose an internal device and would drop the packet.`,
      technical: `Connection-tracking tuple match (${publicIp()}:${publicPort()} ↔ ${clientIp()}:${clientPort()}). Port-based demultiplexing is precisely how one public IPv4 serves many devices — and unsolicited inbound traffic (no mapping) is dropped, which is also why NAT accidentally behaves like a firewall.`
    },
    learn: {
      what: `NAT table hit: :${publicPort()} belongs to ${clientLabel()}.`,
      why: 'The public packet has no idea which internal device asked — only stateful NAT knows.',
      proto: 'NAT44 reverse translation',
      visible: 'Destination rewritten: ' + publicIp() + ':' + publicPort() + ' → ' + clientIp() + ':' + clientPort() + '.',
      changes: 'The response is now addressed to the correct device.'
    },
    onEnter() {
      // Simulated NAT reverse lookup. This is not a real network connection.
      el('cmp-nat').hidden = false;
      el('cmp-nat').innerHTML = '';
      const strong = document.createElement('strong');
      strong.textContent = `Incoming ${publicIp()}:${publicPort()} → NAT table lookup → ${clientIp()}:${clientPort()} → ${clientLabel()}`;
      el('cmp-nat').appendChild(strong);
      renderNat();
      log(`NAT: response for ${publicIp()}:${publicPort()} mapped to ${clientLabel()} (${clientIp()}:${clientPort()})`, 'ok');
      highlightNodes([natNodeId()]);
      switchTab('tables');
    }
  });

  // --- Final delivery ---
  S.push({
    id: 'delivery',
    title: '⬅ Final delivery — to the CORRECT device only',
    proto: isWifi() ? 'Wi-Fi / Ethernet delivery' : 'Cellular delivery',
    dir: 'res',
    packet: httpsRespPacket,
    lifecycle: 7,
    animate: () => isWifi()
      ? { path: ['router', client().id], label: 'frame → ' + client().mac, dir: 'res', perHop: 520 }
      : { path: ['cgnat', 'core', 'tower', 'client'], label: '200 OK 🔒 → your device', dir: 'res', perHop: 380 },
    explain: {
      beginner: isWifi()
        ? `The router wraps the packet in a Wi-Fi frame addressed to ${clientLabel()}'s MAC (${client().mac}). It is NOT broadcast to all five PCs — only ${clientLabel()} unwraps it.`
        : 'The carrier delivers the data through the mobile core and cell tower straight to your device — the one that opened the connection.',
      intermediate: isWifi()
        ? `Layer-2 delivery: destination MAC ${client().mac}. Other stations see frame metadata but ignore frames not addressed to them. Connection state chose the IP; the MAC chose the device.`
        : 'The packet-core session (created at attach) ties the downlink traffic to your device specifically — analogous to NAT state on the home router.',
      technical: isWifi()
        ? '802.11 unicast frame to the station associated with the destination MAC; WPA encryption applies at the link layer, independently of TLS. Broadcast-to-everyone would be incorrect — modern APs/switches forward per-station/per-port.'
        : 'GTP-style tunneling from the core to the serving tower bears the user packet; the radio bearer identifies the subscriber session. Simplified here.'
    },
    learn: {
      what: `Response delivered to ${clientLabel()} — and only ${clientLabel()}.`,
      why: 'Connection state (NAT/session) picked the IP; link-layer addressing finished the job.',
      proto: isWifi() ? '802.11 link layer' : 'Mobile core + radio bearer',
      visible: isWifi() ? 'Frame on the local Wi-Fi addressed to one MAC.' : 'Encrypted tunnel to your device.',
      changes: clientLabel() + ' now holds the encrypted response.'
    },
    onEnter() {
      log(`Delivery: frame handed to ${clientLabel()}` + (isWifi() ? ` (dst MAC ${client().mac}; PC1/PC2/PC4/PC5 stay idle)` : ''), 'ok');
      if (isWifi()) dimOtherPCs(true);
      highlightNodes([isWifi() ? client().id : 'client']);
    }
  });

  // --- Render ---
  S.push({
    id: 'render',
    title: '🎉 Decrypt → parse → render',
    proto: 'Browser engine',
    dir: 'local',
    explain: {
      beginner: `${clientLabel()} decrypts the response with TLS, then the browser parses HTML, loads CSS, runs JavaScript — and draws the page. JOURNEY COMPLETE!`,
      intermediate: 'TLS removes record protection → HTTP/2 stream reassembly → HTML parser → DOM/CSSOM → render tree → paint. Real pages open many more connections for sub-resources (not simulated).',
      technical: 'Decapsulation: frame → IP → TCP reassembly → TLS record decrypt → HTTP semantics → rendering pipeline. One request/response shown; real page loads involve dozens of flows, QUIC, caching and CDN fetches.'
    },
    learn: {
      what: 'Page rendered in the browser.',
      why: 'Everything before this step existed to move these bytes reliably and privately.',
      proto: 'TLS decrypt + browser rendering pipeline',
      visible: 'Locally: full page. On the wire: still only ciphertext.',
      changes: sim.domain + ' is now on screen.'
    },
    onEnter() {
      hidePacket('Local stage — the browser is rendering.');
      el('browser-url').textContent = 'https://' + sim.domain;
      el('browser-bar').classList.add('secure');
      log('Browser: TLS decrypt → HTML parsed → CSS loaded → JS executed → page rendered 🎉', 'ok');
      highlightNodes([isWifi() ? client().id : 'client']);
      showSummary(false);
    }
  });

  return S;
}

let stages = [];

// Some stages reference the compare tab hint without stealing focus
function switchTabSilentlyHint() { /* intentionally a no-op; BGP stage only glows nodes */ }

/* ===========================
   9. FAILURE LAB
   =========================== */

const FAIL_INFO = {
  'none': '',
  'dns-fail': 'The resolver never answers. Without an IP address the browser cannot even start connecting: "' + 'google.com' + ' cannot be resolved."',
  'router-fail': isWifi => isWifi ? 'The gateway ' + NET.gateway + ' is offline. ARP questions echo unanswered — the LAN still works, but nothing can leave it.' : '(Mobile mode: this failure applies to Wi-Fi; pick another scenario.)',
  'nat-fail': 'The request leaves fine, but the NAT mapping is lost before the reply arrives. The response reaches the router — and is dropped, because nobody remembers which internal device asked.',
  'packet-loss': 'One SYN is dropped in the backbone. TCP notices the silence and RETRANSMITS. The journey survives — reliability in action.',
  'tcp-timeout': 'SYN goes out… and nothing ever comes back. TCP retries, then gives up: connection timed out.',
  'tls-fail': 'The certificate fails validation (expired / wrong name / unknown CA, simulated). The browser aborts instead of trusting the connection.'
};

function updateFailDesc() {
  el('fail-desc').textContent = FAIL_INFO[sim.failure]
    ? (typeof FAIL_INFO[sim.failure] === 'function' ? FAIL_INFO[sim.failure](isWifi()) : FAIL_INFO[sim.failure])
    : 'Healthy network — the full journey will complete.';
}

// Returns true when a fatal failure must interrupt at this stage.
async function checkFailure(stage) {
  const f = sim.failure;
  if (f === 'none') return false;

  const failStop = async (title, body) => {
    showFailBox(title, body);
    log('FAILURE: ' + title, 'err');
    sim.stopped = true;
    sim.playing = false;
    updateControls();
    await wait(700 / sim.speed);
    showSummary(true, title, body);
    return true;
  };

  if (f === 'dns-fail' && stage.id === 'dns-response') {
    log('DNS: query sent… no answer. Retrying… still no answer', 'err');
    return failStop('DNS unavailable', 'The resolver did not answer. The browser cannot translate ' + sim.domain + ' into an IP address, so no connection can even start. Fix: check the DNS server setting / resolver reachability.');
  }
  if (f === 'router-fail' && stage.id === 'arp-req') {
    log('ARP: "who has ' + NET.gateway + '?" … silence. Gateway offline', 'err');
    return failStop('Gateway offline', 'No ARP reply from ' + NET.gateway + '. The local network is fine — other PCs still answer — but the router is the only door to the Internet, and it is closed. Result: LAN available, Internet unavailable.');
  }
  if (f === 'packet-loss' && stage.id === 'tcp-syn') {
    stage._dropAt = isWifi() ? 'r2' : 'r1';   // consumed by runStage
    return false;                              // not fatal
  }
  if (f === 'tcp-timeout' && stage.id === 'tcp-synack') {
    log('TCP: SYN sent… waiting… no SYN-ACK. Retransmitting…', 'err');
    const p = stage.animate();                 // animate the lonely SYN-ack path out... actually retransmit out
    await animatePacket(outPath(), { label: 'SYN (retry)', dir: 'req', perHop: 260, changes: natOutChange() });
    sim.stats.retries++;
    return failStop('TCP timeout', 'SYN went out twice and no SYN-ACK ever returned. Possible causes: the server is down, a firewall drops SYN-ACKs, or routing is broken past your ISP. TCP gives up after several retries — the application sees "connection timed out".');
  }
  if (f === 'tls-fail' && stage.id === 'tls-serverhello') {
    return failStop('Certificate validation failed', 'The presented certificate did not pass validation (simulated): hostname mismatch / expired / untrusted CA. The browser ABORTS the TLS handshake — no encrypted channel, no request, no page. This protects you from impersonation (MITM).');
  }
  if (f === 'nat-fail' && stage.id === 'nat-response') {
    log('NAT: response arrived for :' + publicPort() + ' — but the mapping is gone. DROPPED', 'err');
    return failStop('NAT mapping lost', 'The outbound packet created state, but that state was lost (timeout/reboot, simulated). When the response reached ' + publicIp() + ':' + publicPort() + ', the ' + natDeviceName() + ' had no idea which internal device owned it and dropped it. The client will retransmit until TCP times out.');
  }
  return false;
}

function showFailBox(title, body) {
  const fb = el('fail-box');
  fb.hidden = false;
  fb.innerHTML = '';
  const s = document.createElement('strong'); s.textContent = '✕ ' + title;
  const p = document.createElement('p'); p.textContent = body; p.style.margin = '.3rem 0 0';
  fb.appendChild(s); fb.appendChild(p);
}

/* ===========================
   10. STAGE RUNNER + CONTROLS
   =========================== */

function explainFor(stage) {
  return stage.explain[sim.level] || stage.explain.beginner;
}

function renderStageUI(stage, idx) {
  el('stage-title').textContent = stage.title;
  el('stage-proto').textContent = stage.proto;
  const dir = el('stage-dir');
  dir.textContent = { req: '➜ REQUEST · client → server', res: '⬅ RESPONSE · server → client', local: 'LOCAL STAGE' }[stage.dir];
  dir.className = 'badge badge-dir dir-' + stage.dir;
  el('stage-explain').textContent = explainFor(stage);
  el('learn-what').textContent = stage.learn.what;
  el('learn-why').textContent = stage.learn.why;
  el('learn-proto').textContent = stage.learn.proto;
  el('learn-visible').textContent = stage.learn.visible;
  el('learn-changes').textContent = stage.learn.changes;

  const total = stages.length;
  el('step-counter').textContent = `Step ${idx + 1} / ${total}`;
  el('progress-fill').style.width = ((idx + 1) / total * 100) + '%';
  el('progress-stage').textContent = stage.title.length > 22 ? stage.title.slice(0, 22) + '…' : stage.title;
  document.title = `Step ${idx + 1}/${total} · Internet Journey Simulator`;
}

async function runStage(idx) {
  if (idx < 0 || idx >= stages.length) return;
  sim.step = idx;
  sim.animating = true;
  updateControls();

  const stage = stages[idx];
  renderStageUI(stage, idx);

  // Packet inspector for this stage
  if (stage.packet) {
    showPacket(stage.packet(),
      stage.dir === 'req' ? '➜ Outbound packet (client → server)' : '⬅ Inbound packet (server → client)',
      stage.lifecycle != null ? stage.lifecycle : 3);
  }

  if (stage.onEnter) stage.onEnter();

  // Failure interception (may stop the journey)
  const fatal = await checkFailure(stage);
  if (fatal) { sim.animating = false; updateControls(); return; }

  // Packet-loss special case: first traversal drops mid-backbone, then retransmits.
  if (stage._dropAt) {
    const a = stage.animate();
    log('Link interference: packet dropped at ' + stage._dropAt.toUpperCase() + ' — TCP will retransmit', 'err');
    const path = a.path;
    const cut = path.slice(0, path.indexOf(stage._dropAt) + 1);
    await animatePacket(cut, { label: a.label, dir: 'req', perHop: a.perHop, changes: a.changes, dropAt: stage._dropAt });
    sim.stats.retries++;
    await wait(700 / sim.speed);
    log('TCP: retransmission timer fired — sending again', 'sys');
    await animatePacket(path, { label: a.label + ' (retry)', dir: 'req', perHop: a.perHop, changes: a.changes, hopLogs: a.hopLogs });
    log('TCP: retransmitted packet made it through ✔', 'ok');
    stage._dropAt = null;
  } else if (stage.animate) {
    const a = stage.animate();
    await animatePacket(a.path, a);
  }

  el('net').querySelectorAll('.link').forEach(l => l.classList.remove('active'));
  sim.animating = false;
  updateControls();

  // Auto-advance
  if (sim.playing && !sim.stopped) {
    await wait(900 / sim.speed);
    if (sim.playing && !sim.stopped && sim.step < stages.length - 1) runStage(sim.step + 1);
    else { sim.playing = false; updateControls(); }
  }
}

function updateControls() {
  const done = sim.step >= stages.length - 1 || sim.stopped;
  el('btn-start').textContent = sim.playing ? '▶ Running…' : (sim.step >= 0 && !done ? '▶ Resume' : '▶ Start Simulation');
  el('btn-start').disabled = sim.playing || done || sim.animating;
  el('btn-next').disabled = sim.playing || done || sim.animating;
  el('btn-pause').disabled = !sim.playing;
}

function start() {
  if (sim.step >= sim.length) return;
  if (sim.step < 0 || sim.stopped) { reset(false); }
  sim.playing = true;
  updateControls();
  runStage(sim.step + 1);
}

function pause() {
  sim.playing = false;
  updateControls();
  log('Simulation paused');
}

function next() {
  if (sim.step < stages.length - 1 && !sim.stopped && !sim.animating) runStage(sim.step + 1);
}

function reset(clearFailureToo = true) {
  // Clean up timers, animations, sprites
  sim.playing = false;
  clearTimers();
  clearPackets();

  Object.assign(sim, {
    step: -1, stopped: false, animating: false,
    nat: [], dns: {}, arp: {},
    stats: { packets: 0, retries: 0, roundTrips: 4 }
  });

  if (clearFailureToo === true) { /* keep chosen failure unless caller resets it */ }

  stages = buildStages();
  renderTopology();
  renderNat(); renderDns(); renderArp();
  renderEncap('req');
  dimOtherPCs(false);
  el('fail-box').hidden = true;
  el('cmp-nat').hidden = true;
  el('browser-url').textContent = 'about:blank';
  el('browser-bar').classList.remove('secure');
  el('step-counter').textContent = 'Step 0 / ' + stages.length;
  el('progress-fill').style.width = '0%';
  el('progress-stage').textContent = 'Ready';
  el('stage-title').textContent = 'Ready';
  el('stage-proto').textContent = '—';
  el('stage-dir').textContent = '—';
  el('stage-explain').textContent = 'Press ▶ Start Simulation (or GO in the address bar) to watch the full journey, or ⏭ Next Step to walk through one stage at a time.';
  ['learn-what', 'learn-why', 'learn-proto', 'learn-visible', 'learn-changes'].forEach(id => el(id).textContent = '—');
  hidePacket('No packet yet. Start the simulation, then watch this inspector update at every stage.');
  document.title = 'Internet Journey Simulator';
  el('summary').hidden = true;
  updateControls();
  log('Simulation reset — ' + (isWifi() ? 'Wi-Fi mode, client ' + client().name : 'Mobile data mode') + (sim.failure !== 'none' ? ' · failure armed: ' + el('fail-select').selectedOptions[0].textContent : ''));
}

/* ===========================
   11. SUMMARY OVERLAY
   =========================== */

function showSummary(isErr, errTitle, errBody) {
  const s = el('summary');
  const card = s.querySelector('.summary-card');
  card.classList.toggle('err', !!isErr);
  el('summary-title').textContent = isErr ? '✕ Journey interrupted' : '🎉 JOURNEY COMPLETE';
  const b = el('summary-body');
  b.innerHTML = '';

  if (isErr) {
    const t = document.createElement('h3'); t.textContent = errTitle; t.style.color = 'var(--red)'; t.style.textTransform = 'none';
    const p = document.createElement('p'); p.textContent = errBody;
    b.appendChild(t); b.appendChild(p);
  } else {
    b.innerHTML = '<dl class="kv">' + [
      ['You typed', sim.domain],
      ['Connection', isWifi() ? 'Wi-Fi' : 'Mobile data'],
      ['Client', clientLabel() + ' (' + clientIp() + ')'],
      ['DNS', 'resolved → ' + GOOGLE_IP + ' (simulated)'],
      ['NAT', 'translated at the ' + natDeviceName()],
      ['TCP', 'established (SYN / SYN-ACK / ACK)'],
      ['TLS', 'established (TLS 1.3, certificate validated)'],
      ['HTTPS', 'request sent, response received'],
      ['Delivered to', clientLabel() + ' — the correct device ✔'],
      ['Browser', 'page rendered'],
      ['Simulated steps', String(stages.length)],
      ['Packets animated', String(sim.stats.packets)],
      ['Retransmissions', String(sim.stats.retries)],
      ['Round trips (DNS+TCP+TLS+HTTPS)', String(sim.stats.roundTrips)]
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
  }
  s.hidden = false;
}

/* ===========================
   12. UI BINDINGS
   =========================== */

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}

function populateClients() {
  const sel = el('client-select');
  sel.innerHTML = '';
  for (let i = 1; i <= 5; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = 'PC ' + i;
    sel.appendChild(o);
  }
  sel.value = String(sim.clientNum);
}

function applyMode() {
  el('client-select-wrap').style.display = isWifi() ? '' : 'none';
  el('multi-pc-wrap').style.display = isWifi() ? '' : 'none';
  el('arp-wrap').style.display = isWifi() ? '' : 'none';
  const ro = el('fail-opt-router');
  ro.disabled = !isWifi();
  if (!isWifi() && sim.failure === 'router-fail') { sim.failure = 'none'; el('fail-select').value = 'none'; }
  updateFailDesc();
}

function validDomain(d) {
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63}(?<!-))+$/.test(d) && /\.[a-z]{2,}$/.test(d);
}

function init() {
  populateClients();
  stages = buildStages();

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // Controls
  el('btn-start').addEventListener('click', start);
  el('btn-next').addEventListener('click', next);
  el('btn-pause').addEventListener('click', pause);
  el('btn-reset').addEventListener('click', () => { sim.failure = el('fail-select').value; reset(); log('Reset by user'); });

  el('conn-select').addEventListener('change', e => {
    sim.mode = e.target.value;
    applyMode();
    reset();
  });
  el('client-select').addEventListener('change', e => {
    sim.clientNum = parseInt(e.target.value, 10);
    reset();
    log('Selected device: ' + client().name + ' (' + client().ip + ')');
  });
  el('level-select').addEventListener('change', e => {
    sim.level = e.target.value;
    if (sim.step >= 0 && stages[sim.step]) renderStageUI(stages[sim.step], sim.step);
  });
  el('speed').addEventListener('input', e => {
    sim.speed = parseFloat(e.target.value);
    el('speed-val').textContent = sim.speed + 'x';
  });
  el('multi-pc').addEventListener('change', e => {
    sim.multi = e.target.checked;
    log('Multi-PC NAT demo ' + (sim.multi ? 'enabled — watch the NAT table at the TCP handshake' : 'disabled'));
  });
  el('learning-mode').addEventListener('change', e => {
    el('learn-box').style.display = e.target.checked ? '' : 'none';
  });
  el('fail-select').addEventListener('change', e => {
    sim.failure = e.target.value;
    updateFailDesc();
    reset();
  });

  // Layer picker
  document.querySelectorAll('.layer-btn').forEach(b => b.addEventListener('click', () => activateLayer(b.dataset.layer)));

  // Routing device select
  el('rt-select').addEventListener('change', e => renderRouting(e.target.value));

  // Log
  el('btn-clear-log').addEventListener('click', () => { el('event-log').innerHTML = ''; });

  // Browser GO
  el('go-form').addEventListener('submit', e => {
    e.preventDefault();
    const d = el('domain-input').value.trim().toLowerCase();
    if (!validDomain(d)) {
      el('domain-input').classList.add('invalid');
      log('Browser: "' + d + '" is not a valid domain name', 'err');
      return;
    }
    el('domain-input').classList.remove('invalid');
    sim.domain = d;
    reset();
    sim.step = -1;
    start();
  });
  el('domain-input').addEventListener('input', () => el('domain-input').classList.remove('invalid'));

  // Compare actions
  el('cmp-wifi').addEventListener('click', () => { el('conn-select').value = 'wifi'; el('conn-select').dispatchEvent(new Event('change')); });
  el('cmp-mobile').addEventListener('click', () => { el('conn-select').value = 'mobile'; el('conn-select').dispatchEvent(new Event('change')); });

  // Modal
  el('modal-close').addEventListener('click', () => { el('modal').hidden = true; });
  el('modal').addEventListener('click', e => { if (e.target === el('modal')) el('modal').hidden = true; });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { el('modal').hidden = true; el('summary').hidden = true; }
  });

  // Summary actions
  el('summary').addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    el('summary').hidden = true;
    if (act.dataset.act === 'replay') { reset(); start(); }
    else if (act.dataset.act === 'compare') switchTab('compare');
    else if (act.dataset.act === 'lab') switchTab('lab');
    else if (act.dataset.act === 'explore') switchTab('inspector');
  });

  // Keyboard shortcuts (skip when typing in fields)
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (!el('modal').hidden || !el('summary').hidden) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === ' ') { e.preventDefault(); sim.playing ? pause() : start(); }
    else if (e.key.toLowerCase() === 'r') { reset(); }
  });

  applyMode();
  reset();
  log('Internet Journey Simulator ready — all addresses and routes are simulated');
}

document.addEventListener('DOMContentLoaded', init);
