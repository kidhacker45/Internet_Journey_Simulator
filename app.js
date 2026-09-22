/* ============================================================================
 * Internet Journey Simulator
 * ----------------------------------------------------------------------------
 * EVERYTHING in this file is a SIMULATION. No packet is ever sent anywhere:
 * no DNS lookups, no sockets, no fetch(). The visuals are driven by an internal
 * model of devices, IP/MAC addresses, ports, packets, routing tables, a NAT
 * table, a DNS cache, ARP caches and TCP/TLS connection state.
 *
 *   1. Network model      devices, links, routing tables
 *   2. Engines            NAT, DNS, ARP, packet construction / inspection views
 *   3. Animator           requestAnimationFrame packet movement
 *   4. Stage data         the journey as data (one entry per step)
 *   5. Failure lab        fault injection that rewrites the plan
 *   6. Renderers          SVG topology, inspector, tables, panels
 *   7. Controller         step engine, playback, wiring, init
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
   * 0. Small helpers
   * ---------------------------------------------------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const hex2 = (n) => pad((n & 255).toString(16).toUpperCase(), 2);

  function appendKids(node, kids) {
    if (kids === undefined || kids === null || kids === false) return;
    (Array.isArray(kids) ? kids : [kids]).forEach((k) => {
      if (k === undefined || k === null || k === false) return;
      if (Array.isArray(k)) appendKids(node, k);
      else node.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
    });
  }
  function applyAttrs(node, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    });
  }
  /** Create an HTML element. Text is always inserted as text nodes (never as HTML). */
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    applyAttrs(n, attrs);
    appendKids(n, kids);
    return n;
  }
  /** Create an SVG element. */
  function svg(tag, attrs, kids) {
    const n = document.createElementNS(SVG_NS, tag);
    applyAttrs(n, attrs);
    appendKids(n, kids);
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function setText(node, text) { if (node && node.textContent !== text) node.textContent = text; }

  /** Deterministic pseudo-random bytes so "simulated keys" look identical every run. */
  function fakeHex(seed, bytes) {
    let x = (seed * 2654435761) >>> 0;
    const out = [];
    for (let i = 0; i < bytes; i++) { x = (x * 1664525 + 1013904223) >>> 0; out.push(hex2(x >>> 24).toLowerCase()); }
    return out.join(' ');
  }
  function fmtClock(ms) {
    const d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3);
  }

  /** Tracked timers: every timeout is registered so Reset can clean up. */
  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
    return id;
  }
  function clearTimers() { timers.forEach((id) => clearTimeout(id)); timers.clear(); }

  const reducedMQ = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')) || { matches: false };
  const prefersReducedMotion = () => !!reducedMQ.matches;

  /* ------------------------------------------------------------------------
   * 1. Network model
   * ---------------------------------------------------------------------- */
  const PUBLIC_IP = { wifi: '203.0.113.10', mobile: '203.0.113.77' };   // documentation range (RFC 5737)
  const SPEEDS = [0.5, 1, 2, 4];

  class NetNode {
    constructor(o) {
      Object.assign(this, {
        id: '', name: '', sub: '', type: 'node', icon: '❓', ip: null, mac: null, macs: null,
        interfaces: [], routingTable: [], as: null, l3: false, transparent: false,
        status: 'online', role: '', notes: ''
      }, o);
    }
  }
  class Computer extends NetNode {
    constructor(o) { super(Object.assign({ type: 'computer', icon: '💻' }, o)); this.hostname = this.hostname || this.name; }
  }
  class Router extends NetNode {
    constructor(o) { super(Object.assign({ type: 'router', icon: '📡', l3: true }, o)); }
  }
  /** Layer-2 device: forwards frames by destination MAC and never rewrites them. */
  class Switch extends NetNode {
    constructor(o) { super(Object.assign({ type: 'switch', icon: '📶', transparent: true }, o)); }
  }
  class ISPRouter extends NetNode {
    constructor(o) { super(Object.assign({ type: 'isp', icon: '🏢', l3: true }, o)); }
  }
  class InternetRouter extends NetNode {
    constructor(o) { super(Object.assign({ type: 'internet', icon: '🛣', l3: true }, o)); }
  }
  class GoogleEdge extends NetNode {
    constructor(o) { super(Object.assign({ type: 'edge', icon: '🌐', l3: true }, o)); }
  }
  class GoogleServer extends NetNode {
    constructor(o) { super(Object.assign({ type: 'server', icon: '🖥' }, o)); }
  }

  const fm = (n) => '00:1B:44:' + hex2(n * 17) + ':' + hex2(n * 29) + ':' + hex2(n * 43);   // filler MACs
  const route = (dest, next, iface, as) => ({ dest, next, iface, as: as || '—' });

  /** The destination network. Anything that is not google.com uses a clearly-labelled illustrative range. */
  function destFor(domain) {
    if (/^(www\.)?google\.com$/.test(domain)) {
      return { name: 'Google', ip: '142.250.x.x', prefix: '142.250.0.0/16', as: 15169, asName: 'Google', real: true };
    }
    return { name: domain, ip: '198.18.x.x', prefix: '198.18.0.0/15', as: 64511, asName: 'Destination network', real: false };
  }

  /**
   * Build the simulated network for a connection type.
   * The "spine" is the ordered list of nodes a packet crosses from the client to the server.
   * Roles (client, l2, gw, nat, ispA..ispC, r1..r4, edge, server) let the stage data stay
   * identical for Wi-Fi and mobile: each mode maps the roles onto different devices.
   */
  function buildNetwork(mode, clientId, dest) {
    const net = {
      mode, nodes: {}, layout: {}, spine: [], roles: {}, groups: [], bands: [], links: [], linkKinds: {},
      width: 1240, height: 560, midY: 280, natBoundaryAfter: null
    };
    const put = (node, x, y) => { net.nodes[node.id] = node; net.layout[node.id] = { x, y }; return node; };
    const link = (a, b, kind) => { net.links.push({ a, b, kind }); net.linkKinds[[a, b].sort().join('|')] = kind; };
    const brand = dest.name;
    const asChain = '64500 → 64501 → ' + dest.as;

    // ---- Wi-Fi: five computers behind one home router --------------------------------------------
    if (mode === 'wifi') {
      const ys = [80, 180, 280, 380, 480];
      for (let i = 1; i <= 5; i++) {
        put(new Computer({
          id: 'pc' + i, name: 'PC' + i, sub: '192.168.1.' + (19 + i), ip: '192.168.1.' + (19 + i),
          mac: '02:42:AC:11:00:' + (19 + i), subnet: '192.168.1.0/24', gateway: '192.168.1.1', dns: '192.168.1.1',
          connection: 'Wi-Fi', lease: '24 h from DHCP server 192.168.1.1'
        }), 70, ys[i - 1]);
      }
      put(new Switch({
        id: 'ap', name: 'Wi-Fi AP', sub: 'L2 switch', mac: 'AA:BB:CC:DD:EE:0A',
        role: 'Wireless access point and Ethernet switch built into the home router. It forwards frames by destination MAC address and never rewrites them.'
      }), 215, 280);
      put(new Router({
        id: 'router', name: 'Home Router', sub: '192.168.1.1', ip: '192.168.1.1', wanIp: PUBLIC_IP.wifi,
        mac: 'AA:BB:CC:DD:EE:01', macs: { lan: 'AA:BB:CC:DD:EE:01', wan: 'AA:BB:CC:DD:EE:02' },
        interfaces: [
          { name: 'LAN (eth0)', ip: '192.168.1.1/24', mac: 'AA:BB:CC:DD:EE:01' },
          { name: 'WAN (eth1)', ip: PUBLIC_IP.wifi, mac: 'AA:BB:CC:DD:EE:02' }
        ],
        routingTable: [
          route('192.168.1.0/24', 'LAN (directly connected)', 'eth0'),
          route('0.0.0.0/0', 'ISP access router (198.51.100.1)', 'eth1')
        ],
        role: 'Default gateway, DHCP server, DNS forwarder and NAT device for the home network.'
      }), 325, 280);
      put(new ISPRouter({
        id: 'isp-acc', name: 'ISP Access', sub: 'AS64500', ip: '198.51.100.1', mac: fm(1), as: 64500,
        interfaces: [{ name: 'to customer', ip: '198.51.100.1', mac: fm(1) }],
        routingTable: [route('203.0.113.0/24', 'Home router (customer)', 'cust0', '—'), route('0.0.0.0/0', 'ISP aggregation (198.51.100.2)', 'up0', '—')],
        role: 'Access router: terminates the customer connection.'
      }), 445, 280);
      put(new ISPRouter({
        id: 'isp-agg', name: 'ISP Aggregation', sub: 'AS64500', ip: '198.51.100.2', mac: fm(2), as: 64500,
        routingTable: [route('203.0.113.0/24', 'ISP access (198.51.100.1)', 'down0', '—'), route('0.0.0.0/0', 'ISP core (198.51.100.3)', 'up0', '—')],
        role: 'Aggregation router: combines many access routers.'
      }), 535, 280);
      put(new ISPRouter({
        id: 'isp-core', name: 'ISP Core', sub: 'AS64500', ip: '198.51.100.3', mac: fm(3), as: 64500,
        routingTable: [route('203.0.113.0/24', 'ISP aggregation (198.51.100.2)', 'down0', '—'), route(dest.prefix, 'R1 (192.0.2.1)', 'peer0', '64501 ' + dest.as)],
        role: 'Core router: fast forwarding towards other networks. Also hosts the ISP recursive DNS resolver (198.51.100.53) in this simulation.'
      }), 625, 280);
      net.spine = [clientId, 'ap', 'router', 'isp-acc', 'isp-agg', 'isp-core'];
      Object.assign(net.roles, { client: clientId, l2: 'ap', gw: 'router', nat: 'router', ispA: 'isp-acc', ispB: 'isp-agg', ispC: 'isp-core' });
      link(clientId, 'ap', 'wifi');
      ['pc1', 'pc2', 'pc3', 'pc4', 'pc5'].forEach((id) => link(id, 'ap', 'wifi'));
      link('ap', 'router', 'ethernet'); link('router', 'isp-acc', 'ethernet'); link('isp-acc', 'isp-agg', 'ethernet'); link('isp-agg', 'isp-core', 'ethernet');
      net.groups.push({ label: 'Home router (all-in-one)', ids: ['ap', 'router'], cls: 'home' });
      net.groups.push({ label: 'ISP · AS64500', ids: ['isp-acc', 'isp-agg', 'isp-core'], cls: 'isp' });
      net.natBoundaryAfter = 'router';
      net.xs = { r1: 730, r2: 815, r3: 900, r4: 985, edge: 1085, server: 1170 };
      net.lastIspId = 'isp-core';
      net.bands.push({ label: 'AS64500 · ISP', from: 'isp-acc', to: 'r1', key: 'isp' });
    } else {
      // ---- Mobile data: phone → tower → mobile core → CGNAT → ISP ---------------------------------
      put(new Computer({
        id: 'phone', name: 'Phone', sub: '100.72.14.9', ip: '100.72.14.9', mac: null, icon: '📱', subnet: '—', gateway: null,
        dns: '100.64.0.53', connection: 'Mobile data (4G/5G)', lease: 'Assigned by the mobile core when the data session started'
      }), 80, 280);
      put(new Switch({
        id: 'tower', type: 'tower', icon: '🗼', name: 'Cell Tower', sub: 'radio access', mac: null,
        role: 'Radio base station. It carries the phone’s IP packets to the mobile core inside a GTP-U tunnel; there is no Ethernet or ARP on the radio link.'
      }), 220, 280);
      put(new Router({
        id: 'mcore', type: 'core', icon: '🏢', name: 'Mobile Core', sub: 'gateway (UPF)', ip: '100.72.0.1', mac: fm(21),
        interfaces: [{ name: 'radio side (N3/GTP-U)', ip: '100.72.0.1', mac: '—' }, { name: 'Internet side', ip: '10.255.0.1', mac: fm(21) }],
        routingTable: [route('100.72.0.0/16', 'subscriber sessions (GTP tunnels)', 'n3', '—'), route('0.0.0.0/0', 'CGNAT (10.255.0.2)', 'sgi0', '—')],
        role: 'Packet core: assigns IP addresses, tunnels subscriber traffic and acts as the phone’s gateway.'
      }), 335, 280);
      put(new Router({
        id: 'cgnat', type: 'cgnat', icon: '🔁', name: 'CGNAT', sub: 'carrier NAT', ip: '10.255.0.2', wanIp: PUBLIC_IP.mobile, mac: fm(22),
        interfaces: [{ name: 'inside', ip: '10.255.0.2', mac: fm(22) }, { name: 'outside', ip: PUBLIC_IP.mobile, mac: fm(23) }],
        routingTable: [route('100.72.0.0/16', 'Mobile core (10.255.0.1)', 'in0', '—'), route('0.0.0.0/0', 'ISP / transit (198.51.100.1)', 'out0', '—')],
        role: 'Carrier-grade NAT: many subscribers share a small pool of public IPv4 addresses.'
      }), 450, 280);
      put(new ISPRouter({
        id: 'isp', name: 'ISP / Transit', sub: 'AS64500', ip: '198.51.100.1', mac: fm(24), as: 64500,
        routingTable: [route('203.0.113.0/24', 'CGNAT (customer pool)', 'cust0', '—'), route(dest.prefix, 'R1 (192.0.2.1)', 'peer0', '64501 ' + dest.as)],
        role: 'The carrier’s Internet-facing network. Also hosts the recursive DNS resolver in this simulation.'
      }), 575, 280);
      net.spine = [clientId, 'tower', 'mcore', 'cgnat', 'isp'];
      Object.assign(net.roles, { client: clientId, l2: 'tower', gw: 'mcore', nat: 'cgnat', ispA: 'isp', ispB: 'isp', ispC: 'isp' });
      link(clientId, 'tower', 'radio'); link('tower', 'mcore', 'radio'); link('mcore', 'cgnat', 'ethernet'); link('cgnat', 'isp', 'ethernet');
      net.groups.push({ label: 'Mobile network (carrier)', ids: ['tower', 'mcore', 'cgnat'], cls: 'home' });
      net.groups.push({ label: 'ISP · AS64500', ids: ['isp'], cls: 'isp' });
      net.natBoundaryAfter = 'cgnat';
      net.xs = { r1: 685, r2: 775, r3: 865, r4: 955, edge: 1070, server: 1165 };
      net.lastIspId = 'isp';
      net.bands.push({ label: 'AS64500 · ISP', from: 'isp', to: 'r1', key: 'isp' });
    }

    // ---- Shared Internet side: R1..R4 → edge → server ---------------------------------------------
    const rs = ['r1', 'r2', 'r3', 'r4'];
    const asOf = { r1: 64500, r2: 64501, r3: 64501, r4: 64501 };
    const prevOf = { r1: net.lastIspId, r2: 'r1', r3: 'r2', r4: 'r3' };
    const nextOf = { r1: 'r2', r2: 'r3', r3: 'r4', r4: 'edge' };
    const ips = { r1: '192.0.2.1', r2: '192.0.2.2', r3: '192.0.2.3', r4: '192.0.2.4' };
    const asPathSeen = { r1: '64501 ' + dest.as, r2: String(dest.as), r3: String(dest.as), r4: String(dest.as) };
    rs.forEach((id, i) => {
      const nextName = nextOf[id] === 'edge' ? brand + ' Edge' : nextOf[id].toUpperCase();
      const prevName = net.nodes[prevOf[id]] ? net.nodes[prevOf[id]].name : prevOf[id].toUpperCase();
      put(new InternetRouter({
        id, name: 'R' + (i + 1), sub: 'AS' + asOf[id], ip: ips[id], mac: fm(30 + i), as: asOf[id],
        interfaces: [{ name: 'eth0 (towards client)', ip: ips[id], mac: fm(30 + i) }, { name: 'eth1 (towards server)', ip: '192.0.2.' + (10 + i), mac: fm(40 + i) }],
        routingTable: [
          route(dest.prefix, nextName + ' (' + (nextOf[id] === 'edge' ? 'edge' : ips[nextOf[id]]) + ')', 'eth1', asPathSeen[id]),
          route('203.0.113.0/24', prevName, 'eth0', '64500 (customer)')
        ],
        asPath: asChain,
        role: 'Simulated Internet router. Not a real hop on any real route.'
      }), net.xs[id], 280);
    });
    put(new GoogleEdge({
      id: 'edge', name: brand + ' Edge', sub: 'anycast', ip: dest.ip, mac: fm(50), as: dest.as,
      routingTable: [route(dest.prefix, 'internal network → ' + brand + ' Server', 'int0', String(dest.as))],
      role: 'Edge location. Large services announce the same address from many places (anycast) and terminate connections close to users.'
    }), net.xs.edge, 280);
    put(new GoogleServer({
      id: 'server', name: brand + ' Server', sub: 'HTTPS :443', ip: dest.ip, mac: fm(51), as: dest.as,
      role: 'Simulated web server that answers HTTPS requests on port 443.'
    }), net.xs.server, 280);
    net.spine = net.spine.concat(['r1', 'r2', 'r3', 'r4', 'edge', 'server']);
    Object.assign(net.roles, { r1: 'r1', r2: 'r2', r3: 'r3', r4: 'r4', edge: 'edge', server: 'server' });
    link(net.lastIspId, 'r1', 'ethernet'); link('r1', 'r2', 'ethernet'); link('r2', 'r3', 'ethernet'); link('r3', 'r4', 'ethernet');
    link('r4', 'edge', 'ethernet'); link('edge', 'server', 'ethernet');
    net.groups.push({ label: 'SIMULATED INTERNET PATH · not a real traceroute', ids: rs, cls: 'internet' });
    net.groups.push({ label: brand + ' network (simulated)', ids: ['edge', 'server'], cls: 'dest' });
    net.bands.push({ label: 'AS64501 · Transit', from: 'r2', to: 'r4', key: 'transit' });
    net.bands.push({ label: 'AS' + dest.as + ' · ' + (dest.real ? 'Google' : 'Destination (simulated)'), from: 'edge', to: 'server', key: 'dest' });
    net.spineIndex = {};
    net.spine.forEach((id, i) => { net.spineIndex[id] = i; });

    /** Ordered node ids between two node ids (either direction). */
    net.between = (a, b) => {
      const i = net.spine.indexOf(a), j = net.spine.indexOf(b);
      if (i < 0 || j < 0) return [a, b];
      return i <= j ? net.spine.slice(i, j + 1) : net.spine.slice(j, i + 1).reverse();
    };
    net.linkKind = (a, b) => net.linkKinds[[a, b].sort().join('|')] || 'ethernet';
    return net;
  }

  /* --- Simplified longest-prefix-match so the router's decision is computed, not scripted ---------- */
  function ipToNum(ip) {
    const p = ip.split('.').map((x) => (x === 'x' ? 0 : parseInt(x, 10)));
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  }
  function inCidr(ip, cidr) {
    const parts = cidr.split('/');
    if (parts.length !== 2) return false;
    const bits = +parts[1];
    if (bits === 0) return true;
    const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
    return ((ipToNum(ip) & mask) >>> 0) === ((ipToNum(parts[0]) & mask) >>> 0);
  }
  function lookupRoute(table, ip) {
    let best = null, bestBits = -1;
    table.forEach((r) => {
      if (inCidr(ip, r.dest)) { const b = +r.dest.split('/')[1]; if (b > bestBits) { best = r; bestBits = b; } }
    });
    return best;
  }

  /* ------------------------------------------------------------------------
   * 2. Engines — NAT, DNS, ARP, packet model
   * ---------------------------------------------------------------------- */
  let PKT_SEQ = 1;

  function macFor(nodeId, towardId, net) {
    const n = net.nodes[nodeId];
    if (!n) return '—';
    if (n.macs) {
      // Router-like device: pick LAN-side mac if the next node is on the LAN side, else WAN-side.
      const boundaryIdx = net.spineIndex[net.natBoundaryAfter];
      const towardIdx = net.spineIndex[towardId];
      const selfIdx = net.spineIndex[nodeId];
      if (towardIdx !== undefined && towardIdx < selfIdx) return n.macs.lan || n.mac;
      return boundaryIdx !== undefined && selfIdx <= boundaryIdx ? (n.macs.wan || n.mac) : (n.macs.lan || n.mac);
    }
    return n.mac || '—';
  }

  function isBeforeNat(nodeId, net) {
    const b = net.spineIndex[net.natBoundaryAfter];
    const i = net.spineIndex[nodeId];
    if (b === undefined || i === undefined) return true;
    return i < b;
  }

  /** NAT engine: a shared translation table for however many "computers" are active at once. */
  function makeNatEngine() {
    let nextPort = 40000;
    const table = [];
    return {
      table,
      allocate(pcId, pcName, internalIp, remoteIp, remotePort, proto) {
        let entry = table.find((e) => e.pcId === pcId && e.remoteIp === remoteIp && e.remotePort === remotePort && e.proto === proto && e.state !== 'closed');
        if (entry) return entry;
        entry = {
          pcId, pcName, internalIp, internalPort: 51820 + (table.length % 500), publicPort: nextPort++,
          remoteIp, remotePort, proto, state: 'ESTABLISHING', created: Date.now()
        };
        table.push(entry);
        return entry;
      },
      lookupByPublicPort(port) { return table.find((e) => e.publicPort === port); },
      setState(entry, s) { if (entry) entry.state = s; },
      remove(pcId) { for (let i = table.length - 1; i >= 0; i--) if (table[i].pcId === pcId) table.splice(i, 1); },
      clear() { table.length = 0; nextPort = 40000; }
    };
  }

  /** DNS engine: a small resolver cache, keyed by "name|type". */
  function makeDnsEngine() {
    const cache = new Map();
    return {
      cache,
      lookup(name, type) { return cache.get(name + '|' + type) || null; },
      store(name, type, value, ttl) { cache.set(name + '|' + type, { name, type, value, ttl, stored: Date.now() }); },
      flush() { cache.clear(); },
      rows() { return Array.from(cache.values()); }
    };
  }

  /** ARP engine: one cache per LAN segment (Wi-Fi only — mobile has no ARP). */
  function makeArpEngine() {
    const cache = new Map();          // ip -> mac
    const switchTable = new Map();    // mac -> port/node id
    return {
      cache, switchTable,
      resolve(ip) { return cache.get(ip) || null; },
      store(ip, mac) { cache.set(ip, mac); },
      learn(mac, port) { switchTable.set(mac, port); },
      flush() { cache.clear(); },
      flushSwitch() { switchTable.clear(); }
    };
  }

  /**
   * A simulated packet. `srcIp`/`dstIp`/`srcPort`/`dstPort` are the *end to end* (application-level)
   * addresses; per-hop Ethernet/IP/port values are computed on demand (see fieldsAtHop) so that NAT
   * translation and per-hop MAC changes are calculated, not hand-scripted.
   */
  function mkPacket(state, o) {
    const p = Object.assign({
      id: 'pkt-' + (PKT_SEQ++), dir: 'request', kind: 'data', proto: 'IP', transport: 'TCP',
      srcPort: null, dstPort: null, ttlStart: 64, payload: '', natEntry: null, path: [], stageId: null,
      dropped: false
    }, o);
    state.packets.push(p);
    return p;
  }

  function fieldsAtHop(state, pkt, aId, bId) {
    const net = state.net;
    const idxA = net.spineIndex[aId], idxB = net.spineIndex[bId];
    const forward = idxA <= idxB;
    const fromId = forward ? aId : bId, toId = forward ? bId : aId;
    const srcMac = macFor(fromId, toId, net);
    const dstMac = macFor(toId, fromId, net);
    let srcIp = pkt.srcIp, dstIp = pkt.dstIp, srcPort = pkt.srcPort, dstPort = pkt.dstPort;
    const ne = pkt.natEntry;
    if (ne) {
      if (pkt.dir === 'request') {
        if (!isBeforeNat(fromId, net)) { srcIp = ne.publicIp; srcPort = ne.publicPort; }
      } else {
        if (!isBeforeNat(toId, net)) { dstIp = ne.publicIp; dstPort = ne.publicPort; }
      }
    }
    const hopsFromClient = Math.abs(net.spineIndex[aId] - net.spineIndex[net.roles.client]);
    const ttl = Math.max(1, pkt.ttlStart - hopsFromClient);
    return { srcMac, dstMac, srcIp, dstIp, srcPort, dstPort, ttl, forward };
  }

  function localMac(state, id) { return macFor(id, id, state.net); }

  /* ------------------------------------------------------------------------
   * 3. Animator — moves a packet dot along the topology SVG
   * ---------------------------------------------------------------------- */
  function pathPoints(net, ids) { return ids.map((id) => net.layout[id]); }

  function animateAlong(state, ids, dir, totalMs, onDone) {
    const svg = $('#topo-svg');
    let dot = $('#pkt-dot', svg);
    if (!dot) {
      dot = svgEl('circle', { id: 'pkt-dot', r: 7, class: 'pkt-dot ' + dir });
      svg.appendChild(dot);
    } else {
      dot.setAttribute('class', 'pkt-dot ' + dir);
    }
    dot.removeAttribute('hidden');
    const pts = pathPoints(state.net, ids);
    if (pts.length < 2 || prefersReducedMotion()) {
      const last = pts[pts.length - 1] || { x: 0, y: 0 };
      dot.setAttribute('cx', last.x); dot.setAttribute('cy', last.y);
      later(onDone, prefersReducedMotion() ? 60 : totalMs);
      return;
    }
    const segCount = pts.length - 1;
    const start = performance.now();
    function seg(pt) { return pt; }
    function frame(now) {
      const t = clamp((now - start) / totalMs, 0, 1);
      const segT = t * segCount;
      const i = clamp(Math.floor(segT), 0, segCount - 1);
      const localT = clamp(segT - i, 0, 1);
      const a = seg(pts[i]), b = seg(pts[i + 1]);
      dot.setAttribute('cx', a.x + (b.x - a.x) * localT);
      dot.setAttribute('cy', a.y + (b.y - a.y) * localT);
      if (t < 1 && state.animToken === animateAlong._token) requestAnimationFrame(frame);
      else onDone();
    }
    animateAlong._token = (animateAlong._token || 0) + 1;
    state.animToken = animateAlong._token;
    requestAnimationFrame(frame);
  }
  function svgEl(tag, attrs) { return svg(tag, attrs); }

  /* ------------------------------------------------------------------------
   * 4. Stage data — the journey as data. One function builds every stage for
   *    the current mode/client/destination, so Wi-Fi and Mobile reuse the
   *    exact same engine and only the underlying `net` differs.
   * ---------------------------------------------------------------------- */
  function buildStages(state) {
    const net = state.net, dest = state.dest, mode = state.mode;
    const r = net.roles;
    const client = net.nodes[r.client];
    const isWifi = mode === 'wifi';
    const L2NAME = isWifi ? 'Wi-Fi access point' : 'cell tower';
    const GWNAME = net.nodes[r.gw].name;
    const NATNAME = net.nodes[r.nat].name;
    const S = [];
    const push = (o) => S.push(o);

    push({
      id: 'start', phase: 'Browser', dir: 'local', proto: '—', kind: 'url',
      title: 'You type a web address',
      real: 'A browser only knows a hostname (e.g. ' + dest.name + '). It has no idea yet which computer that name belongs to.',
      simp: 'Autocomplete, search suggestions and typo-correction are switched off here.',
      learn: { what: 'You entered "' + client.hostname + ' → ' + dest.name + '" and pressed GO.', why: 'Every web request starts as a human-readable name, not a number.', proto: 'HTTP(S) URL', transport: '—', port: '—', visible: 'Nothing has left the computer yet.', changes: 'The browser now needs an IP address for "' + dest.name + '".' },
      levels: {
        beginner: 'You typed "' + dest.name + '" and pressed GO. Computers do not understand names directly — the browser first has to translate that name into a numeric address.',
        intermediate: '"' + dest.name + '" is a hostname, not an address. Before ' + client.hostname + ' can open a connection, it must resolve the name to an IP address via DNS.',
        technical: 'The browser parses the URL, checks its own cache for a cached A/AAAA record, and — finding none — prepares a DNS query for "' + dest.name + '".'
      }, path: null
    });

    push({
      id: 'dns-q', phase: 'DNS', dir: 'req', proto: 'DNS · UDP/53', kind: 'dns-query',
      title: 'DNS query leaves the computer',
      real: 'DNS (Domain Name System) turns names into IP addresses. Your computer normally asks the resolver configured by DHCP.',
      simp: 'Recursive resolution across root/TLD/authoritative servers is simplified to one "ISP resolver" step.',
      learn: { what: client.hostname + ' sends a DNS query for "' + dest.name + '" (type A) to its resolver ' + client.dns + '.', why: 'Applications and the OS network stack work with IP addresses, not names.', proto: 'DNS', transport: 'UDP', port: '53', visible: 'The domain name being looked up, in the clear.', changes: 'A DNS query packet now exists and is being routed towards the resolver.' },
      levels: {
        beginner: 'The computer asks a "phone book for the Internet" (DNS) what number belongs to "' + dest.name + '".',
        intermediate: client.hostname + ' sends a DNS query to its configured resolver (' + client.dns + ') asking for the A record of "' + dest.name + '".',
        technical: 'A UDP/53 DNS query (QTYPE=A, QNAME=' + dest.name + ') is generated with a random transaction ID and forwarded to the configured resolver.'
      },
      path: isWifi ? [r.client, r.l2, r.gw] : [r.client, r.l2, r.gw],
      action: (st) => {
        st.dnsQuery = { name: dest.name, type: 'A', id: 0x4d2 };
      }
    });

    push({
      id: 'dns-recurse', phase: 'DNS', dir: 'req', proto: 'DNS · UDP/53', kind: 'dns-recurse',
      title: 'The resolver looks the name up',
      real: 'A real recursive resolver walks root → TLD (.com) → authoritative name servers if it has no cached answer.',
      simp: 'That multi-step walk is shown as a single "ISP recursive resolver" lookup here.',
      learn: { what: 'The ISP\u2019s recursive resolver checks its cache, then (in real life) queries root, .com and authoritative servers.', why: 'No single server holds every domain on Earth — the lookup is delegated in stages.', proto: 'DNS', transport: 'UDP', port: '53', visible: 'Still just the domain name.', changes: 'The resolver now has an answer ready to send back.' },
      levels: {
        beginner: 'The ISP\u2019s "directory service" figures out the correct address for ' + dest.name + '.',
        intermediate: 'The recursive resolver (hosted at the ISP core in this simulation) resolves the name, consulting root → .com → authoritative servers if needed.',
        technical: 'Recursive resolution: root hint → .com TLD referral → authoritative NS for ' + dest.name + ' → A record returned, cached with its TTL.'
      }, path: null
    });

    push({
      id: 'dns-r', phase: 'DNS', dir: 'resp', proto: 'DNS · UDP/53', kind: 'dns-response',
      title: 'DNS response comes back',
      real: 'The resolver returns an A record and a TTL (time-to-live) telling the browser how long it may cache the answer.',
      simp: 'One simulated address is returned; real Google responses often include several addresses for load-balancing.',
      learn: { what: 'The resolver answers: ' + dest.name + ' = ' + dest.ip + ' (TTL 300s).', why: 'The browser now has a numeric destination it can route packets to.', proto: 'DNS', transport: 'UDP', port: '53', visible: 'The resolved IP address and TTL.', changes: 'The IP address is cached locally so future lookups can skip this whole step.' },
      levels: {
        beginner: 'The answer comes back: "' + dest.name + ' is at ' + dest.ip + '." The browser saves this for a little while.',
        intermediate: 'A DNS response arrives with an A record (' + dest.ip + ') and TTL, which the OS stub resolver caches.',
        technical: 'DNS response (matching transaction ID) delivers RR: ' + dest.name + ' A ' + dest.ip + ' TTL=300. Cached client-side until expiry.'
      },
      path: [r.gw, r.l2, r.client],
      action: (st) => { st.dns.store(dest.name, 'A', dest.ip, 300); }
    });

    if (isWifi) {
      push({
        id: 'arp-r', phase: 'ARP', dir: 'req', proto: 'ARP', kind: 'arp-request',
        title: 'ARP: "who has the router\u2019s MAC address?"',
        real: 'On a LAN, IP addresses are not enough to deliver a frame — the sender needs the destination\u2019s MAC (hardware) address.',
        simp: 'ARP is shown only for the client ↔ router hop; every real device also does this.',
        learn: { what: client.hostname + ' broadcasts "Who has ' + client.gateway + '? Tell ' + client.ip + '."', why: 'Ethernet/Wi-Fi frames are addressed by MAC, not IP.', proto: 'ARP', transport: '—', port: '—', visible: 'The broadcast is seen by every device on the Wi-Fi segment.', changes: 'The router will reply with its MAC address.' },
        levels: {
          beginner: 'Before sending data, the computer shouts on the local network: "Who has address ' + client.gateway + '?" — it needs a hardware address, not just an IP.',
          intermediate: client.hostname + ' has no ARP entry for the gateway ' + client.gateway + ', so it broadcasts an ARP request on the Wi-Fi segment.',
          technical: 'ARP request broadcast (dst FF:FF:FF:FF:FF:FF): "Who has ' + client.gateway + '? Tell ' + client.ip + ' (' + client.mac + ')."'
        }, path: [r.client, r.l2]
      });
      push({
        id: 'arp-y', phase: 'ARP', dir: 'resp', proto: 'ARP', kind: 'arp-reply',
        title: 'ARP reply: the router answers',
        real: 'Only the router recognises its own IP and replies directly (unicast) with its MAC address.',
        simp: '—',
        learn: { what: 'The router replies: "' + client.gateway + ' is at ' + net.nodes[r.gw].macs.lan + '."', why: 'Now the computer can address Ethernet/Wi-Fi frames directly to the router.', proto: 'ARP', transport: '—', port: '—', visible: 'The router\u2019s MAC address.', changes: 'Both devices cache this mapping (ARP cache) for a while.' },
        levels: {
          beginner: 'The router answers back privately: "That\u2019s me — here is my hardware address."',
          intermediate: 'The router unicasts an ARP reply with its LAN MAC (' + net.nodes[r.gw].macs.lan + '); ' + client.hostname + ' caches the mapping.',
          technical: 'ARP reply: ' + client.gateway + ' is-at ' + net.nodes[r.gw].macs.lan + '. Both ends insert the pair into their ARP cache (typically ~60s–4h TTL).'
        }, path: [r.l2, r.client],
        action: (st) => { st.arp.store(client.gateway, net.nodes[r.gw].macs.lan); st.arp.learn(client.mac, r.client); st.arp.learn(net.nodes[r.gw].macs.lan, r.gw); }
      });
    }

    push({
      id: 'construct', phase: 'Packet', dir: 'local', proto: 'Ethernet + IPv4 + TCP', kind: 'construct',
      title: 'The request packet is built (encapsulation)',
      real: 'Each layer wraps the one above it: application data → TCP segment → IP packet → Ethernet/Wi-Fi frame.',
      simp: 'A single simplified packet stands in for what is really several TLS/TCP segments.',
      learn: { what: 'The OS wraps the outgoing data in TCP, then IP, then a link-layer frame.', why: 'Every layer adds the addressing/control info the next network device needs.', proto: 'Ethernet/IPv4/TCP', transport: 'TCP', port: '443', visible: 'Headers only at this point — no data sent yet.', changes: 'A fully-formed packet is ready to leave the computer.' },
      levels: {
        beginner: 'The computer wraps your request in layers, like putting a letter in an envelope, then that envelope in a shipping box.',
        intermediate: 'The OS builds a TCP segment (dest port 443), wraps it in an IP packet (src ' + client.ip + ', dst ' + dest.ip + '), then in a Wi-Fi/Ethernet frame.',
        technical: 'Encapsulation: L4 TCP header (SYN, seq=x) → L3 IPv4 header (TTL 64, proto=6) → L2 frame (src ' + client.mac + ').'
      }, path: null,
      action: (st) => { st.tcpPort = 50000 + Math.floor(Math.random() * 1000); st.serverPort = 443; }
    });

    push({
      id: 'to-router', phase: 'Local delivery', dir: 'req', proto: 'Ethernet/Wi-Fi', kind: 'packet',
      title: 'Frame crosses the ' + (isWifi ? 'Wi-Fi network' : 'radio link') + ' to ' + GWNAME,
      real: (isWifi ? 'The ' + L2NAME + ' forwards the frame by MAC address; it does not look at or change the IP addresses.' : 'The phone\u2019s IP traffic is carried inside a GTP-U tunnel to the mobile core — there is no MAC addressing on the radio link.'),
      simp: 'Signal strength, retransmissions and Wi-Fi contention are not modelled.',
      learn: { what: 'The frame travels from ' + client.hostname + ' to ' + GWNAME + '.', why: 'This is the first hop towards the wider Internet.', proto: isWifi ? 'Wi-Fi (802.11)' : 'Cellular radio', transport: 'TCP', port: String(443), visible: 'Source/destination MAC (Wi-Fi) or tunnel ID (mobile); IP/TCP headers if inspected.', changes: isWifi ? 'The switch/AP learns which port the client\u2019s MAC is on.' : 'The mobile core assigns/maintains the session.' },
      levels: {
        beginner: 'Your device sends the packet over ' + (isWifi ? 'Wi-Fi' : 'the mobile signal') + ' to the ' + GWNAME + '.',
        intermediate: 'The frame leaves ' + client.hostname + ' and arrives at ' + GWNAME + ' via the ' + L2NAME + '.',
        technical: isWifi ? 'L2 frame forwarded across the WLAN; the AP switch learns ' + client.mac + ' on its client-facing port.' : 'IP packet tunnelled over the radio bearer (GTP-U) from the phone to the ' + L2NAME + ', then to the mobile core.'
      },
      path: [r.client, r.l2, r.gw],
      kindPacket: true
    });

    push({
      id: 'route', phase: 'Routing', dir: 'req', proto: 'IPv4', kind: 'route',
      title: GWNAME + ' makes a routing decision',
      real: 'A router consults its routing table and forwards based on the longest matching prefix for the destination IP.',
      simp: 'Real home routers usually just have a default route; this simulator shows the lookup explicitly for teaching.',
      learn: { what: GWNAME + ' looks up ' + dest.ip + ' in its routing table and matches the default route towards the ISP.', why: 'Routing tables decide which direction (interface) each packet should leave on.', proto: 'IPv4', transport: '—', port: '—', visible: 'The routing table entries.', changes: 'The packet is queued to leave on the WAN/uplink interface — and will be NAT-translated.' },
      levels: {
        beginner: 'The ' + GWNAME + ' checks its "map of the Internet" and decides which direction to send your packet.',
        intermediate: GWNAME + ' performs a longest-prefix-match lookup for ' + dest.ip + ' against its routing table and selects the default/uplink route.',
        technical: 'Routing table lookup: no more-specific match than 0.0.0.0/0, so the packet egresses via the WAN interface toward ' + (isWifi ? 'the ISP access router' : 'CGNAT') + '.'
      }, path: null
    });

    push({
      id: 'nat', phase: 'NAT', dir: 'req', proto: 'NAT', kind: 'nat',
      title: NATNAME + ' translates the address (NAT)',
      real: 'Network Address Translation rewrites the private source IP (and port) to a public one so the packet can travel the Internet, and remembers the mapping.',
      simp: 'Real routers manage thousands of simultaneous NAT sessions; here you can inspect the table directly.',
      learn: { what: client.ip + ':(an ephemeral port)' + ' is translated to ' + net.nodes[r.nat].wanIp + ':(a public port).', why: 'Private (RFC1918/CGNAT) addresses are not routable on the public Internet.', proto: 'NAT', transport: 'TCP/UDP', port: 'varies', visible: 'The NAT translation table.', changes: 'A new row appears in the NAT table; it is this row that lets the reply find its way back.' },
      levels: {
        beginner: 'Your computer\u2019s private address is swapped for the household\u2019s single public address — like a company mailroom stamping a return address on outgoing mail.',
        intermediate: NATNAME + ' rewrites ' + client.ip + ':(ephemeral port) → ' + net.nodes[r.nat].wanIp + ':(public port) and stores the mapping so replies can be routed back correctly.',
        technical: 'Source NAT (masquerade): (' + client.ip + ', ephemeral) ⇄ (' + net.nodes[r.nat].wanIp + ', public) keyed by (proto, dstIP, dstPort); entry added to the connection-tracking table.'
      }, path: null,
      action: (st) => {
        const e = st.nat.allocate(st.clientId, client.hostname, client.ip, dest.ip, 443, 'TCP');
        st.currentNat = e;
      }
    });

    // ---- ISP hops ----
    const ispChain = isWifi ? [[r.gw, r.ispA, 'ISP access router'], [r.ispA, r.ispB, 'ISP aggregation router'], [r.ispB, r.ispC, 'ISP core router']]
                              : [[r.nat, r.ispA, 'ISP / transit router']];
    ispChain.forEach(([from, to, label], i) => {
      push({
        id: 'isp-' + i, phase: 'ISP', dir: 'req', proto: 'IPv4', kind: 'packet',
        title: 'Packet reaches the ' + label,
        real: 'Your ISP carries the packet across its own network towards its peering/transit points.',
        simp: 'Real ISP topologies have many more routers; three representative hops stand in for the whole network.',
        learn: { what: 'The packet is forwarded from ' + net.nodes[from].name + ' to ' + net.nodes[to].name + '.', why: 'Getting from your home network to the wider Internet takes several router hops inside the ISP.', proto: 'IPv4', transport: 'TCP', port: '443', visible: 'TTL decrements by one at every routed hop.', changes: 'Nothing changes about the addressing here — this is a plain forwarded hop.' },
        levels: {
          beginner: 'The packet moves deeper into your Internet provider\u2019s network, one hop closer to ' + dest.name + '.',
          intermediate: 'The ISP forwards the packet from ' + net.nodes[from].name + ' towards ' + net.nodes[to].name + ' based on its own internal routing.',
          technical: 'Hop-by-hop IPv4 forwarding inside AS64500; TTL decremented, next-hop chosen from ' + net.nodes[from].name + '\u2019s routing table.'
        }, path: [from, to]
      });
    });

    push({
      id: 'backbone', phase: 'Internet backbone', dir: 'req', proto: 'IPv4 · BGP-routed', kind: 'packet',
      title: 'SIMULATED INTERNET PATH — crossing the backbone (R1 → R4)',
      real: 'Traffic between large networks crosses Internet exchange points and backbone/transit routers; the exact path depends on live BGP routing at that moment.',
      simp: 'R1–R4 are four illustrative routers, not a real traceroute. A genuine path could be 5, 10 or 20+ hops and change between requests.',
      learn: { what: 'The packet crosses four simulated backbone routers (R1–R4) between your ISP and ' + dest.name + '.', why: 'The Internet is a "network of networks" — no single operator owns the whole path.', proto: 'IPv4', transport: 'TCP', port: '443', visible: 'TTL keeps decrementing; each router only knows the next hop, not the whole path.', changes: 'The packet is now leaving AS64500 and entering transit/backbone networks.' },
      levels: {
        beginner: 'The packet now travels across "the Internet" itself — several unrelated networks operated by different companies, each just passing it one step closer.',
        intermediate: 'The packet is forwarded across four illustrative backbone routers (R1–R4) representing transit networks between your ISP and ' + dest.name + '. This is not a real traceroute.',
        technical: 'Simulated inter-domain path R1(AS64500)→R2→R3→R4(AS64501), each performing a routing-table lookup toward ' + dest.prefix + '. A real path is determined by live BGP policy and can differ every time.'
      }, path: [r.ispA === r.ispC ? r.ispA : r.ispC, 'r1', 'r2', 'r3', 'r4']
    });

    push({
      id: 'bgp', phase: 'BGP', dir: 'local', proto: 'BGP (simplified)', kind: 'bgp',
      title: 'How networks agree on a path (BGP, simplified)',
      real: 'BGP (Border Gateway Protocol) is how Autonomous Systems (AS) exchange reachability information and agree on inter-network routes.',
      simp: 'This is a static, illustrative AS diagram — not a live BGP table, and BGP operates between networks, not per packet.',
      learn: { what: 'AS64500 (your ISP) → AS64501 (transit) → AS' + dest.as + ' (' + dest.asName + ') is the simulated AS path.', why: 'BGP is how the Internet\u2019s independent networks discover routes to each other.', proto: 'BGP', transport: 'TCP/179 (between routers)', port: '—', visible: 'An AS path, not individual packets.', changes: '—' },
      levels: {
        beginner: 'Big networks (like your ISP and ' + dest.name + ') agree ahead of time on which of them will carry traffic for which addresses.',
        intermediate: 'Each Autonomous System advertises the address ranges it can reach; ' + dest.name + '\u2019s route to you travels AS64500 → AS64501 → AS' + dest.as + '.',
        technical: 'Simplified AS-path: 64500 64501 ' + dest.as + '. Real BGP updates carry NEXT_HOP, AS_PATH and policy attributes and are exchanged continuously between routers, not per packet.'
      }, path: null
    });

    push({
      id: 'edge', phase: dest.name + ' network', dir: 'req', proto: 'IPv4 · Anycast', kind: 'packet',
      title: 'Packet reaches the ' + dest.name + ' edge',
      real: 'Large services announce the same IP address from many locations worldwide (anycast) so users connect to a nearby one automatically.',
      simp: 'Only one edge/server pair is modelled; a real provider has many edge locations and internal load-balancing.',
      learn: { what: 'The packet arrives at a ' + dest.name + ' edge location for ' + dest.ip + '.', why: 'Anycast routes the same address to whichever announcing location is topologically closest.', proto: 'IPv4', transport: 'TCP', port: '443', visible: 'The destination address, still ' + dest.ip + '.', changes: 'From here the request is handed to a nearby server.' },
      levels: {
        beginner: 'The packet arrives at a ' + dest.name + ' location near you — big services have many entry points around the world.',
        intermediate: 'Because ' + dest.ip + ' is announced from multiple locations (anycast), your packet naturally lands at a nearby ' + dest.name + ' edge.',
        technical: 'Anycast routing directs the packet to the topologically nearest edge announcing ' + dest.prefix + '. TLS/HTTP termination happens close to the user to reduce latency.'
      }, path: ['r4', 'edge']
    });

    push({
      id: 'tcp-syn', phase: 'TCP handshake', dir: 'req', proto: 'TCP', kind: 'tcp',
      title: 'TCP handshake — SYN',
      real: 'TCP is connection-oriented: both sides agree on sequence numbers before any data is sent, using a three-way handshake.',
      simp: '—',
      learn: { what: client.hostname + ' sends SYN (seq=x) to ' + dest.name + ':443.', why: 'TCP needs a reliable, ordered connection before HTTPS can begin.', proto: 'TCP', transport: 'TCP', port: '443', visible: 'SYN flag set; no application data yet.', changes: 'The server will reply with SYN-ACK if it accepts.' },
      levels: {
        beginner: 'Your computer says "Hello, can we talk?" to ' + dest.name + '\u2019s server.',
        intermediate: 'A TCP SYN segment opens the three-way handshake toward ' + dest.name + ':443.',
        technical: 'TCP SYN, seq=x, MSS/window-scale/SACK options negotiated.'
      }, path: ['edge', 'server']
    });
    push({
      id: 'tcp-synack', phase: 'TCP handshake', dir: 'resp', proto: 'TCP', kind: 'tcp',
      title: 'TCP handshake — SYN-ACK',
      real: 'The server acknowledges the client\u2019s SYN and sends its own sequence number.',
      simp: '—',
      learn: { what: 'Server replies SYN-ACK (seq=y, ack=x+1).', why: 'Both directions of the connection are now being set up.', proto: 'TCP', transport: 'TCP', port: '443', visible: 'SYN+ACK flags.', changes: 'The client will send the final ACK.' },
      levels: {
        beginner: 'The server answers: "Yes, hello — and I hear you."',
        intermediate: 'The server responds with SYN-ACK, acknowledging the client\u2019s sequence number and proposing its own.',
        technical: 'TCP SYN,ACK seq=y ack=x+1.'
      }, path: ['server', 'edge']
    });
    push({
      id: 'tcp-ack', phase: 'TCP handshake', dir: 'req', proto: 'TCP', kind: 'tcp',
      title: 'TCP handshake — ACK (connection established)',
      real: 'The three-way handshake completes; a reliable, ordered TCP connection now exists.',
      simp: '—',
      learn: { what: client.hostname + ' sends the final ACK (seq=x+1, ack=y+1).', why: 'This confirms both sides are ready to exchange data.', proto: 'TCP', transport: 'TCP', port: '443', visible: 'ACK flag.', changes: 'TLS negotiation can now begin on top of this TCP connection.' },
      levels: {
        beginner: 'Your computer confirms: "Got it — let\u2019s talk." The connection is now open.',
        intermediate: 'The client sends the final ACK; the TCP connection is ESTABLISHED.',
        technical: 'TCP ACK seq=x+1 ack=y+1 — connection state moves to ESTABLISHED.'
      }, path: ['edge', 'server'],
      action: (st) => { if (st.currentNat) st.nat.setState(st.currentNat, 'ESTABLISHED'); }
    });

    push({
      id: 'tls-hello', phase: 'TLS handshake', dir: 'req', proto: 'TLS 1.3', kind: 'tls',
      title: 'TLS handshake — ClientHello',
      real: 'TLS negotiates an encrypted channel: supported versions, cipher suites and a client key share.',
      simp: 'Key values shown are simulated-looking hex, not real cryptographic material.',
      learn: { what: 'Client sends ClientHello (TLS 1.3, cipher suites, key share, SNI=' + dest.name + ').', why: 'HTTPS requires an encrypted, authenticated channel before any request is sent.', proto: 'TLS 1.3', transport: 'TCP', port: '443', visible: 'The SNI hostname is visible in plaintext even in TLS 1.3; everything after this is encrypted.', changes: 'The server will choose parameters and present a certificate.' },
      levels: {
        beginner: 'Your browser and the server start agreeing on a secret code (encryption) so no one else can read your data.',
        intermediate: 'The browser sends a TLS 1.3 ClientHello proposing cipher suites and a key share, including SNI=' + dest.name + '.',
        technical: 'ClientHello: TLS 1.3, key_share=' + fakeHex(11, 8) + '…, supported_versions, SNI=' + dest.name + ' (plaintext).'
      }, path: ['edge', 'server']
    });
    push({
      id: 'tls-server', phase: 'TLS handshake', dir: 'resp', proto: 'TLS 1.3', kind: 'tls',
      title: 'TLS handshake — ServerHello + Certificate',
      real: 'The server replies with its chosen parameters, a key share, and a certificate proving its identity.',
      simp: 'The certificate shown is a simulated placeholder, not a real X.509 chain.',
      learn: { what: 'Server sends ServerHello, its certificate for ' + dest.name + ', and Finished.', why: 'The certificate lets the browser verify it is really talking to ' + dest.name + '.', proto: 'TLS 1.3', transport: 'TCP', port: '443', visible: 'Certificate is visible; the rest is encrypted from here on.', changes: 'Both sides derive shared session keys.' },
      levels: {
        beginner: 'The server proves who it is (like showing an ID card) and finishes setting up the secret code.',
        intermediate: 'The server answers with ServerHello, its certificate for ' + dest.name + ', and derives session keys.',
        technical: 'ServerHello + EncryptedExtensions + Certificate(CN=' + dest.name + ') + CertificateVerify + Finished; key_share=' + fakeHex(22, 8) + '…'
      }, path: ['server', 'edge']
    });
    push({
      id: 'tls-done', phase: 'TLS handshake', dir: 'local', proto: 'TLS 1.3', kind: 'tls',
      title: 'Encrypted channel established',
      real: 'From this point, all HTTP traffic on this connection is encrypted end-to-end between browser and server.',
      simp: '—',
      learn: { what: 'A symmetric session key is derived on both ends; the TLS handshake completes.', why: 'This keeps the request (including cookies and page content) private from anyone in between.', proto: 'TLS 1.3', transport: 'TCP', port: '443', visible: 'Nothing — traffic content is now opaque to observers.', changes: 'The browser can now send the encrypted HTTPS request.' },
      levels: {
        beginner: 'A private, locked tunnel now exists between your browser and the server.',
        intermediate: 'Both sides have derived matching session keys; the TCP connection is now a secure TLS 1.3 tunnel.',
        technical: 'Application traffic keys derived (HKDF); all subsequent records are AEAD-encrypted.'
      }, path: null
    });

    push({
      id: 'http-req', phase: 'HTTPS request', dir: 'req', proto: 'HTTP/1.1 (simulated) over TLS', kind: 'http',
      title: 'Encrypted HTTPS request sent — SIMULATED',
      real: 'The browser sends an HTTP request (method, path, headers) inside the encrypted TLS channel.',
      simp: 'Modern browsers often use HTTP/2 or HTTP/3 (QUIC over UDP) instead of plain HTTP/1.1 — simplified here to one illustrative request/response.',
      learn: { what: 'GET / HTTP/1.1, Host: ' + dest.name + ' — sent as encrypted bytes.', why: 'This is the actual request for the web page.', proto: 'HTTP', transport: 'TCP (TLS-encrypted)', port: '443', visible: 'Only opaque encrypted bytes to any observer on the path.', changes: 'The server will process the request and prepare a response.' },
      levels: {
        beginner: 'Your browser asks the server for the ' + dest.name + ' home page — but the request itself is scrambled so only the server can read it.',
        intermediate: 'An HTTP GET request for "/" is sent inside the encrypted TLS channel to ' + dest.name + '.',
        technical: 'Encrypted TLS record carrying: GET / HTTP/1.1\\r\\nHost: ' + dest.name + '\\r\\n… (SIMULATED — HTTP/2/3 in real deployments).'
      }, path: ['edge', 'server']
    });
    push({
      id: 'server-proc', phase: dest.name + ' server', dir: 'local', proto: 'HTTP', kind: 'server',
      title: dest.name + '\u2019s server processes the request',
      real: 'A web server reads the request, runs any application logic, and builds a response with a status code.',
      simp: 'A single simulated server stands in for load balancers, application servers and databases.',
      learn: { what: 'The server on port 443 builds an HTTP 200 OK response with the page content.', why: 'This is where the actual page you asked for gets assembled.', proto: 'HTTP', transport: 'TCP (TLS)', port: '443', visible: 'Server-side only — not visible on the network.', changes: 'A response is now ready to send back the way the request came.' },
      levels: {
        beginner: dest.name + '\u2019s computer puts together the web page you asked for.',
        intermediate: 'The server processes the GET request and prepares an HTTP 200 OK response containing the page.',
        technical: 'Server-side handler executes, response assembled: HTTP/1.1 200 OK, Content-Type: text/html.'
      }, path: null
    });

    push({
      id: 'resp-start', phase: 'Response', dir: 'resp', proto: '—', kind: 'resp-banner',
      title: 'RESPONSE STARTS HERE',
      real: 'From here, every hop is retraced in reverse — the response must arrive back at the exact computer that asked, not any other.',
      simp: '—',
      learn: { what: 'The server\u2019s answer begins its journey back across the same network path.', why: 'TCP/IP is connection-based — the reply is routed back using the addresses recorded when the request went out.', proto: '—', transport: '—', port: '—', visible: '—', changes: 'Direction reverses for every remaining step.' },
      levels: {
        beginner: 'Now the answer has to travel all the way back to your computer.',
        intermediate: 'The HTTP response now retraces the request\u2019s path in reverse, hop by hop.',
        technical: 'Reverse path: server → edge → backbone → ISP → NAT → gateway → ' + (isWifi ? 'Wi-Fi' : 'radio') + ' → client, using the state recorded by NAT/ARP/routing along the way.'
      }, path: null
    });

    push({
      id: 'http-resp', phase: 'Response', dir: 'resp', proto: 'HTTP over TLS', kind: 'http',
      title: 'Encrypted HTTPS response — SIMULATED',
      real: 'The response (HTML/CSS/JS/images) travels back inside the same encrypted TLS channel.',
      simp: 'Real pages involve many additional requests for images, scripts and stylesheets — simplified to one response.',
      learn: { what: 'HTTP/1.1 200 OK with page content, encrypted, sent from server to edge.', why: 'This is the data your browser will render.', proto: 'HTTP', transport: 'TCP (TLS)', port: '443', visible: 'Opaque encrypted bytes only.', changes: 'The response now heads back across the Internet toward your ISP.' },
      levels: {
        beginner: dest.name + ' sends the web page back, still scrambled for privacy.',
        intermediate: 'The 200 OK response is sent from the server back through the edge, encrypted end-to-end.',
        technical: 'Encrypted TLS records carrying HTTP/1.1 200 OK + body begin the return trip.'
      }, path: ['server', 'edge']
    });
    push({
      id: 'resp-backbone', phase: 'Response', dir: 'resp', proto: 'IPv4', kind: 'packet',
      title: 'Response crosses the backbone (R4 → R1)',
      real: 'The reverse path is not necessarily identical to the forward path in the real Internet — routing can be asymmetric.',
      simp: 'This simulation retraces the same simulated routers for clarity.',
      learn: { what: 'The response packet is forwarded backward across R4 → R1.', why: 'Each backbone router forwards based on its own table, just like on the way out.', proto: 'IPv4', transport: 'TCP', port: String(443), visible: 'TTL, source/destination IP.', changes: '—' },
      levels: {
        beginner: 'The reply travels back across the Internet, the same way the request went out.',
        intermediate: 'The response is forwarded back across the simulated backbone routers toward your ISP.',
        technical: 'Reverse-direction forwarding across r4→r3→r2→r1 (real-world return paths can differ from the outbound path — asymmetric routing).'
      }, path: ['edge', 'r4', 'r3', 'r2', 'r1']
    });
    ispChain.slice().reverse().forEach(([from, to, label], i) => {
      push({
        id: 'resp-isp-' + i, phase: 'Response', dir: 'resp', proto: 'IPv4', kind: 'packet',
        title: 'Response reaches the ' + label,
        real: 'The ISP forwards the reply toward the customer connection it came from.',
        simp: '—',
        learn: { what: 'Forwarded from ' + net.nodes[to].name + ' back to ' + net.nodes[from].name + '.', why: 'Getting back to your home network also takes several hops.', proto: 'IPv4', transport: 'TCP', port: '443', visible: 'TTL, addressing.', changes: '—' },
        levels: {
          beginner: 'The reply moves back through your Internet provider\u2019s network.',
          intermediate: 'The ISP forwards the response from ' + net.nodes[to].name + ' to ' + net.nodes[from].name + '.',
          technical: 'Reverse hop-by-hop forwarding inside AS64500 toward the customer edge.'
        }, path: [to, from]
      });
    });

    push({
      id: 'nat-resp', phase: 'NAT', dir: 'resp', proto: 'NAT', kind: 'nat-resp',
      title: NATNAME + ' looks up the NAT table',
      real: 'The router checks its NAT table by (protocol, public port) to find out which internal computer originally made this connection.',
      simp: 'This is exactly why the earlier NAT table row matters — without it, the router would not know which of the five PCs should get the reply.',
      learn: { what: NATNAME + ' matches the incoming reply\u2019s destination port against its NAT table and finds ' + client.hostname + '.', why: 'This is the single most important reason NAT works: only the PC that opened the connection gets the reply.', proto: 'NAT', transport: 'TCP', port: 'public port → private port', visible: 'The NAT table row used for this lookup.', changes: 'The destination address is rewritten from the public IP back to ' + client.ip + '.' },
      levels: {
        beginner: 'The router checks its notebook: "Which computer asked for this?" — and finds ' + client.hostname + ', not any of the other computers.',
        intermediate: NATNAME + ' looks up its NAT table by the destination public port, finds the mapping to ' + client.ip + ', and rewrites the destination address.',
        technical: 'Reverse NAT lookup keyed on (dstPort=public port, proto=TCP) → internal (' + client.ip + ', ephemeral port); destination rewritten accordingly.'
      }, path: null,
      action: (st) => { if (st.currentNat) st.currentNat.state = 'ESTABLISHED'; }
    });

    push({
      id: 'to-client', phase: 'Local delivery', dir: 'resp', proto: isWifi ? 'Wi-Fi' : 'Radio', kind: 'delivery',
      title: 'Response delivered to ' + client.hostname + (isWifi ? ' — other computers stay dark' : ''),
      real: isWifi ? 'The switch/AP forwards the frame only to the port/MAC address of ' + client.hostname + '; the other four computers never see this traffic.' : 'The mobile core delivers the packet through the specific tunnel belonging to this phone\u2019s session.',
      simp: '—',
      learn: { what: 'The frame is delivered to ' + client.mac + ' (' + client.hostname + ') specifically.', why: isWifi ? 'Switches (and Wi-Fi APs) forward by destination MAC, so only the addressed device receives the frame.' : 'Each subscriber has its own tunnel, so traffic cannot cross between phones.', proto: isWifi ? 'Ethernet/Wi-Fi' : 'Cellular', transport: 'TCP', port: '443', visible: 'Destination MAC = ' + client.mac + '.', changes: 'Delivery to the correct device is complete.' },
      levels: {
        beginner: 'The reply arrives back at exactly your computer — none of the other computers on the network ever saw it.',
        intermediate: 'The ' + L2NAME + ' delivers the frame using the destination MAC/tunnel that belongs only to ' + client.hostname + '.',
        technical: isWifi ? 'Switch forwards to the port associated with dst MAC ' + client.mac + ' (learned earlier in the switch table) — no flooding needed.' : 'Delivery via the subscriber-specific GTP-U tunnel established for this session.'
      }, path: [r.gw, r.l2, r.client]
    });

    push({
      id: 'render', phase: 'Browser', dir: 'local', proto: 'HTML/CSS/JS', kind: 'render',
      title: 'Browser decrypts, parses and renders the page',
      real: 'The browser decrypts the TLS record, parses the HTTP response and HTML, then builds and paints the page.',
      simp: 'Real rendering involves additional requests for images/CSS/JS; simplified to one page load.',
      learn: { what: 'The TLS layer decrypts the bytes, HTTP parses headers/body, and the rendering engine builds the page.', why: 'This is the final step that turns network bytes into what you see on screen.', proto: 'HTML/CSS/JS', transport: '—', port: '—', visible: 'Nothing further leaves the network — this is entirely local.', changes: 'The requested page is now visible.' },
      levels: {
        beginner: 'Your browser unlocks, reads and displays the page for you.',
        intermediate: 'The browser decrypts the TLS session, parses the HTTP response, and renders the HTML/CSS/JS.',
        technical: 'TLS record decryption → HTTP response parsing → DOM construction → CSSOM → render tree → paint.'
      }, path: null
    });

    push({
      id: 'done', phase: 'Complete', dir: 'local', proto: '—', kind: 'done',
      title: '🎉 GOOGLE PAGE LOADED',
      real: 'This full journey — DNS, ' + (isWifi ? 'ARP, ' : '') + 'NAT, routing, TCP, TLS and HTTP — happens in a few hundred milliseconds on a real connection.',
      simp: 'This simulator strips out load-balancing, CDNs, HTTP/2+/QUIC, caching, retries and much more to keep the concepts visible.',
      learn: { what: 'The page finished loading.', why: 'You just walked through the entire path a real request takes.', proto: '—', transport: '—', port: '—', visible: '—', changes: '—' },
      levels: {
        beginner: 'All done! That is everything that happens, at a simplified level, between typing an address and seeing a page.',
        intermediate: 'The journey is complete — you have now traced a request through every major layer of the stack.',
        technical: 'End-to-end path traced: application → DNS → (ARP) → NAT → routing → BGP/AS path → TCP → TLS 1.3 → HTTP, and the mirrored return path.'
      }, path: null
    });

    return S;
  }

  /* ------------------------------------------------------------------------
   * 5. Failure lab — each scenario interrupts the normal journey at a named
   *    stage and replaces the rest of the plan with a single explanation step.
   * ---------------------------------------------------------------------- */
  function failureScenarios(state) {
    const dest = state.dest, net = state.net, client = net.nodes[net.roles.client];
    const lossSel = document.getElementById('lab-loss');
    const lossStage = lossSel && lossSel.value ? state.stages.find((s) => s.id === lossSel.value) : null;
    const lossLabel = lossStage ? lossStage.title : 'A packet on the path';
    return [
      {
        id: 'dns-fail', label: 'DNS failure', breakAt: 'dns-q',
        why: 'The resolver ' + client.dns + ' does not answer (or the domain does not exist).',
        explain: 'Without a DNS answer, the browser never learns an IP address for "' + dest.name + '" and cannot open any connection. This is why browsers show "DNS_PROBE_FINISHED_NXDOMAIN" or similar errors — everything downstream (ARP, NAT, TCP, TLS) never gets a chance to run.'
      },
      {
        id: 'gw-fail', label: 'Router / gateway failure', breakAt: 'route',
        why: net.nodes[net.roles.gw].name + ' is offline or unreachable.',
        explain: 'With the default gateway down, the computer has no way to leave the local network at all — it can still talk to other devices on the same Wi-Fi/LAN, but every packet addressed outside it is dropped locally. DNS, NAT, and everything beyond never happen.'
      },
      {
        id: 'nat-fail', label: 'NAT mapping failure', breakAt: 'nat-resp',
        why: 'The NAT table entry expired or was never created (e.g. a firewall blocked outbound TCP).',
        explain: 'If ' + net.nodes[net.roles.nat].name + ' has no matching NAT entry when the reply arrives, it has no way to know which internal computer should receive it — the reply is dropped. This is exactly why the NAT table matters: no entry means no delivery, even though the server answered correctly.'
      },
      {
        id: 'loss', label: 'Packet loss + retransmission', breakAt: 'tcp-syn',
        why: lossLabel + ' is silently dropped somewhere on the path.',
        explain: 'TCP does not know a packet was lost until an acknowledgement fails to arrive in time. After a retransmission timeout (RTO), the sender resends the same segment. A couple of lost packets just adds latency; sustained loss can stall or fail the connection.'
      },
      {
        id: 'tcp-timeout', label: 'TCP timeout', breakAt: 'tcp-synack',
        why: dest.name + '\u2019s server (or something on the path) never sends SYN-ACK.',
        explain: 'The client resends SYN a few times with increasing backoff, then gives up — the browser shows a "connection timed out" error. No TLS or HTTP ever happens because the transport layer connection was never established.'
      },
      {
        id: 'tls-fail', label: 'TLS certificate failure', breakAt: 'tls-server',
        why: 'The certificate presented does not match ' + dest.name + ' (expired, wrong domain, or untrusted issuer).',
        explain: 'The browser refuses to proceed and shows a certificate-warning page. This check exists specifically to stop attackers from impersonating a site — the TCP connection is open, but no data is exchanged over it because trust could not be established.'
      }
    ];
  }

  /* ------------------------------------------------------------------------
   * 6. Renderers — SVG topology + device info
   * ---------------------------------------------------------------------- */
  function renderClientOptions(state) {
    const sel = $('#sel-client');
    clear(sel);
    if (state.mode === 'wifi') {
      for (let i = 1; i <= 5; i++) {
        sel.appendChild(el('option', { value: 'pc' + i }, 'PC' + i + ' — 192.168.1.' + (19 + i)));
      }
      sel.value = state.clientId && state.clientId.indexOf('pc') === 0 ? state.clientId : 'pc3';
    } else {
      sel.appendChild(el('option', { value: 'phone' }, 'Phone — 100.72.14.9'));
      sel.value = 'phone';
    }
  }

  function nodeColor(n) {
    if (n.type === 'computer') return 'computer';
    if (n.type === 'switch' || n.type === 'tower') return 'switch';
    if (n.type === 'router' || n.type === 'core' || n.type === 'cgnat') return 'router';
    if (n.type === 'isp') return 'isp';
    if (n.type === 'internet') return 'internet';
    if (n.type === 'edge' || n.type === 'server') return 'dest';
    return 'node';
  }

  function renderTopology(state) {
    const net = state.net;
    const svgRoot = $('#topo-svg');
    clear(svgRoot);
    svgRoot.setAttribute('viewBox', '0 0 ' + net.width + ' ' + net.height);

    // Band backgrounds (AS regions)
    net.bands.forEach((b) => {
      const x1 = net.layout[b.from].x - 45, x2 = net.layout[b.to].x + 45;
      svgRoot.appendChild(svg('rect', { x: x1, y: 30, width: x2 - x1, height: net.height - 60, class: 'band band-' + b.key, rx: 14 }));
      svgRoot.appendChild(svg('text', { x: (x1 + x2) / 2, y: 22, class: 'band-label', 'text-anchor': 'middle' }, b.label));
    });
    // Group boxes (home router, ISP, internet path, dest)
    net.groups.forEach((g) => {
      const xs = g.ids.map((id) => net.layout[id].x);
      const x1 = Math.min(...xs) - 40, x2 = Math.max(...xs) + 40;
      svgRoot.appendChild(svg('rect', { x: x1, y: 60, width: x2 - x1, height: net.height - 120, class: 'group group-' + g.cls, rx: 12 }));
      svgRoot.appendChild(svg('text', { x: (x1 + x2) / 2, y: net.height - 40, class: 'group-label', 'text-anchor': 'middle' }, g.label));
    });
    // Links
    net.links.forEach((l) => {
      const a = net.layout[l.a], b = net.layout[l.b];
      if (!a || !b) return;
      svgRoot.appendChild(svg('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        class: 'link link-' + l.kind + (l.kind === 'wifi' || l.kind === 'radio' ? ' dashed' : '')
      }));
    });
    // Nodes
    Object.keys(net.nodes).forEach((id) => {
      const n = net.nodes[id]; const pos = net.layout[id];
      const isClient = id === net.roles.client;
      const isOtherPc = n.type === 'computer' && !isClient;
      const g = svg('g', { class: 'node node-' + nodeColor(n) + (isOtherPc ? ' dim' : '') + (n.status === 'offline' ? ' offline' : ''), tabindex: '0', role: 'button', 'aria-label': n.name + ' — ' + (n.sub || ''), 'data-id': id });
      g.appendChild(svg('circle', { cx: pos.x, cy: pos.y, r: n.type === 'computer' ? 22 : 26, class: 'node-circle' }));
      g.appendChild(svg('text', { x: pos.x, y: pos.y + 7, class: 'node-icon', 'text-anchor': 'middle' }, n.icon));
      g.appendChild(svg('text', { x: pos.x, y: pos.y + (n.type === 'computer' ? 40 : 46), class: 'node-name', 'text-anchor': 'middle' }, n.name));
      if (n.sub) g.appendChild(svg('text', { x: pos.x, y: pos.y + (n.type === 'computer' ? 53 : 59), class: 'node-sub mono', 'text-anchor': 'middle' }, n.sub));
      g.addEventListener('click', () => { selectNode(state, id); });
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(state, id); } });
      svgRoot.appendChild(g);
    });
  }

  function selectNode(state, id) {
    state.selectedNode = id;
    renderNodeInfo(state, id);
    renderRoutingTable(state, id);
    $$('.node', $('#topo-svg')).forEach((g) => g.classList.toggle('selected', g.getAttribute('data-id') === id));
  }

  function renderNodeInfo(state, id) {
    const box = $('#node-info');
    clear(box);
    const n = state.net.nodes[id];
    if (!n) { box.appendChild(el('p', { class: 'muted' }, 'Click any device on the map to inspect it.')); return; }
    const rows = [];
    rows.push(['Name', n.name]);
    if (n.hostname) rows.push(['Hostname', n.hostname]);
    if (n.ip) rows.push(['IPv4 address', n.ip]);
    if (n.wanIp) rows.push(['Public (WAN) IP', n.wanIp]);
    if (n.subnet) rows.push(['Subnet', n.subnet]);
    if (n.mac) rows.push(['MAC address', n.mac]);
    if (n.macs) { rows.push(['LAN MAC', n.macs.lan]); rows.push(['WAN MAC', n.macs.wan]); }
    if (n.gateway) rows.push(['Default gateway', n.gateway]);
    if (n.dns) rows.push(['DNS server', n.dns]);
    if (n.connection) rows.push(['Connection type', n.connection]);
    if (n.as) rows.push(['Autonomous System', 'AS' + n.as]);
    if (n.lease) rows.push(['Lease / session', n.lease]);
    const dl = el('dl', { class: 'kv mono' });
    rows.forEach(([k, v]) => { dl.appendChild(el('dt', {}, k)); dl.appendChild(el('dd', {}, String(v))); });
    box.appendChild(el('h3', {}, n.icon + ' ' + n.name));
    box.appendChild(dl);
    if (n.role) box.appendChild(el('p', { class: 'hint' }, n.role));
  }

  /* ---- Step / learning panel, progress, phases, log, browser -------------- */
  function renderStepPanel(state, stage) {
    setText($('#step-dir'), stage.dir === 'req' ? '▶ REQUEST' : stage.dir === 'resp' ? '◀ RESPONSE' : '◆ LOCAL / BACKGROUND');
    $('#step-dir').className = 'step-dir ' + stage.dir;
    setText($('#step-caption'), stage.title);
    setText($('#step-text'), stage.levels[state.level] || stage.levels.beginner);
    setText($('#step-real'), stage.real || '—');
    setText($('#step-simp'), stage.simp || '—');
    const learnBox = $('#learn-box');
    if (state.learning) {
      learnBox.hidden = false;
      setText($('#learn-what'), stage.learn.what);
      setText($('#learn-why'), stage.learn.why);
      setText($('#learn-proto'), stage.learn.proto);
      setText($('#learn-transport'), stage.learn.transport);
      setText($('#learn-port'), stage.learn.port);
      setText($('#learn-visible'), stage.learn.visible);
      setText($('#learn-changes'), stage.learn.changes);
    } else learnBox.hidden = true;
    setText($('#sr-status'), stage.title + '. ' + (stage.levels[state.level] || ''));

    $('#dir-req').classList.toggle('active', stage.dir === 'req');
    $('#dir-resp').classList.toggle('active', stage.dir === 'resp');
    $('#dir-local').classList.toggle('active', stage.dir === 'local');
    $('#banner-resp').hidden = stage.kind !== 'resp-banner';
  }

  function renderProgress(state) {
    const total = state.stages.length;
    const idx = state.stageIndex + 1;
    setText($('#step-count'), 'Step ' + Math.max(0, idx) + ' / ' + total);
    setText($('#step-title'), state.stageIndex >= 0 ? state.stages[state.stageIndex].title : 'Ready — press Start or Next Step');
    const pct = total ? Math.round((idx / total) * 100) : 0;
    $('#progress').setAttribute('aria-valuenow', String(pct));
    $('#bar-fill').style.width = pct + '%';
    const blocks = 20, filled = Math.round((pct / 100) * blocks);
    setText($('#blockbar'), '█'.repeat(filled) + '░'.repeat(blocks - filled));
  }

  function renderPhaseStrip(state) {
    const strip = $('#phase-strip');
    clear(strip);
    const phases = [];
    state.stages.forEach((s) => { if (!phases.length || phases[phases.length - 1].name !== s.phase) phases.push({ name: s.phase, firstIdx: state.stages.indexOf(s) }); });
    phases.forEach((p) => {
      const active = state.stageIndex >= p.firstIdx;
      const current = state.stageIndex >= 0 && state.stages[state.stageIndex].phase === p.name;
      strip.appendChild(el('li', { class: 'phase' + (active ? ' done' : '') + (current ? ' current' : '') }, p.name));
    });
  }

  function appendLog(state, text) {
    const log = $('#log');
    const row = el('div', { class: 'log-row' }, [
      el('span', { class: 'mono log-time' }, fmtClock(Date.now())),
      el('span', {}, text)
    ]);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function renderBrowser(state, stage) {
    const dest = state.dest;
    $('#b-tab').textContent = (stage && stage.id === 'start') || state.stageIndex < 0 ? 'New tab' : dest.name;
    $('#b-url').textContent = state.stageIndex < 0 ? 'Type a website below' : (state.stageIndex >= state.stages.findIndex((s) => s.id === 'tls-done') ? 'https://' + dest.name : dest.name + ' — connecting…');
    $('#b-lock').textContent = state.stageIndex >= state.stages.findIndex((s) => s.id === 'tls-done') ? '🔒' : '🔎';
    const view = $('#b-view');
    clear(view);
    const doneIdx = state.stages.findIndex((s) => s.id === 'render');
    if (state.stageIndex >= 0 && doneIdx >= 0 && state.stageIndex >= doneIdx) {
      view.appendChild(el('div', { class: 'rendered-page' }, [
        el('div', { class: 'rp-logo' }, dest.real ? '🔎 ' + dest.name : '🌍 ' + dest.name),
        el('div', { class: 'rp-bar' }),
        el('div', { class: 'rp-line' }), el('div', { class: 'rp-line short' })
      ]));
      $('#b-status').textContent = 'Done';
    } else if (state.stageIndex >= 0) {
      view.appendChild(el('p', { class: 'muted' }, 'Loading ' + dest.name + '…'));
      $('#b-status').textContent = stage ? stage.title : 'Connecting…';
    } else {
      $('#b-status').textContent = 'Ready';
    }
  }

  /* ---- NAT / DNS / ARP / routing table panels ------------------------------ */
  function renderNat(state) {
    const body = $('#nat-body');
    clear(body);
    state.nat.table.forEach((e) => {
      body.appendChild(el('tr', { class: e.pcId === state.clientId ? 'row-active' : '' }, [
        el('td', {}, e.internalIp + ':' + e.internalPort + ' (' + e.pcName + ')'),
        el('td', {}, state.net.nodes[state.net.roles.nat].wanIp + ':' + e.publicPort),
        el('td', {}, e.remoteIp + ':' + e.remotePort),
        el('td', {}, e.state)
      ]));
    });
    setText($('#nat-note'), state.nat.table.length
      ? 'Each row maps one internal (private) address+port to one public address+port. A reply is only delivered to the PC whose row matches.'
      : 'No NAT sessions yet — start the simulation to create one.');
  }

  function renderNatDemo(state) {
    const box = $('#nat-clients');
    clear(box);
    if (state.mode !== 'wifi') { box.appendChild(el('p', { class: 'muted' }, 'The five-PC demo applies to Wi-Fi mode.')); return; }
    for (let i = 1; i <= 5; i++) {
      const id = 'pc' + i;
      const checked = state.natDemo.has(id);
      const label = el('label', { class: 'check' }, [
        el('input', { type: 'checkbox', checked: checked, onchange: (e) => {
          if (e.target.checked) state.natDemo.add(id); else state.natDemo.delete(id);
          applyNatDemo(state);
        } }),
        el('span', {}, 'PC' + i + (id === state.clientId ? ' (selected)' : ''))
      ]);
      box.appendChild(label);
    }
  }

  function applyNatDemo(state) {
    const net = state.net;
    state.natDemo.forEach((id) => {
      const n = net.nodes[id];
      if (n) state.nat.allocate(id, n.name, n.ip, state.dest.ip, 443, 'TCP');
    });
    // remove entries for pcs turned off (except the active client's own session)
    for (let i = state.nat.table.length - 1; i >= 0; i--) {
      const e = state.nat.table[i];
      if (e.pcId !== state.clientId && !state.natDemo.has(e.pcId)) state.nat.table.splice(i, 1);
    }
    renderNat(state);
  }

  function renderDns(state) {
    setText($('#dns-query'), state.dnsQuery ? ('; QUESTION\n' + state.dnsQuery.name + '.  IN  ' + state.dnsQuery.type) : '—');
    const rec = state.dns.lookup(state.dest.name, 'A');
    setText($('#dns-response'), rec ? (state.dest.name + '.  ' + rec.ttl + '  IN  A  ' + rec.value) : '—');
    const chain = $('#dns-chain'); clear(chain);
    ['Browser / OS cache — checked first', 'Recursive resolver (' + (state.net.nodes[state.net.roles.client].dns) + ') — checked next', 'Root → .com → authoritative (simulated as one step)', 'Answer cached locally with its TTL'].forEach((t) => chain.appendChild(el('li', {}, t)));
    const cacheBody = $('#dns-cache'); clear(cacheBody);
    state.dns.rows().forEach((r) => cacheBody.appendChild(el('tr', {}, [el('td', {}, r.name), el('td', {}, r.type), el('td', {}, r.value), el('td', {}, String(r.ttl))])));
  }

  function renderArp(state) {
    const client = state.net.nodes[state.net.roles.client];
    if (state.mode !== 'wifi') {
      setText($('#arp-msg'), 'Mobile data has no ARP — the phone talks to the mobile core over a radio tunnel, not a shared Ethernet/Wi-Fi segment.');
    } else {
      const mac = state.arp.resolve(client.gateway);
      setText($('#arp-msg'), mac ? ('who-has ' + client.gateway + '?  ' + client.gateway + ' is-at ' + mac) : 'who-has ' + client.gateway + '?  (no reply yet)');
    }
    const cacheBody = $('#arp-cache'); clear(cacheBody);
    state.arp.cache.forEach((mac, ip) => cacheBody.appendChild(el('tr', {}, [el('td', {}, ip), el('td', {}, mac)])));
    const swBody = $('#sw-body'); clear(swBody);
    state.arp.switchTable.forEach((port, mac) => swBody.appendChild(el('tr', {}, [el('td', {}, mac), el('td', {}, String(port))])));
  }

  function renderRoutingTable(state, nodeId) {
    const n = state.net.nodes[nodeId || state.selectedNode];
    const body = $('#rt-body'); clear(body);
    if (!n || !n.routingTable || !n.routingTable.length) {
      setText($('#rt-title'), n ? n.name + ' has no routing table (not a router).' : 'Click a router on the map, or Next Step to follow the packet.');
      setText($('#rt-info'), '');
      return;
    }
    setText($('#rt-title'), n.name + (n.as ? ' · AS' + n.as : ''));
    n.routingTable.forEach((r) => body.appendChild(el('tr', {}, [el('td', {}, r.dest), el('td', {}, r.next), el('td', {}, r.iface), el('td', {}, r.as)])));
    setText($('#rt-info'), 'Longest matching prefix wins. A default route (0.0.0.0/0) only matches when nothing more specific does.');
  }

  /* ---- Packet inspector ------------------------------------------------- */
  const LAYERS = ['Link (L2)', 'Internet (L3)', 'Transport (L4)', 'Application (L7)'];

  function renderInspectorSelect(state) {
    const sel = $('#insp-select');
    clear(sel);
    if (!state.packets.length) { sel.appendChild(el('option', { value: '' }, 'No packets yet')); return; }
    state.packets.forEach((p) => {
      sel.appendChild(el('option', { value: p.id, selected: p.id === (state.currentPacket && state.currentPacket.id) }, p.kind + ' · ' + p.id));
    });
  }

  function renderLayerButtons(state) {
    const box = $('#layer-buttons'); clear(box);
    LAYERS.forEach((name, i) => {
      box.appendChild(el('button', {
        type: 'button', class: 'seg' + (state.layerFilter === i ? ' on' : ''), 'aria-pressed': state.layerFilter === i,
        onclick: () => { state.layerFilter = state.layerFilter === i ? -1 : i; renderInspector(state); }
      }, name));
    });
  }

  function renderInspector(state) {
    renderInspectorSelect(state);
    renderLayerButtons(state);
    const pkt = state.currentPacket;
    const lifeBox = $('#insp-life'); clear(lifeBox);
    const secBox = $('#insp-sections'); clear(secBox);
    const natBox = $('#insp-nat'); natBox.hidden = true; clear(natBox);
    if (!pkt) { setText($('#insp-title'), 'Click a packet on the map, or pick one above.'); setText($('#insp-hop'), '—'); return; }

    const life = ['CREATED', 'ENCAPSULATED', 'SENT', 'ROUTED', pkt.natEntry ? 'NAT TRANSLATED' : null, 'FORWARDED', 'RECEIVED', 'DECAPSULATED'].filter(Boolean);
    life.forEach((s) => lifeBox.appendChild(el('li', {}, s)));

    const path = pkt.path && pkt.path.length ? pkt.path : [state.net.roles.client];
    if (!pkt.hopIndex) pkt.hopIndex = 0;
    pkt.hopIndex = clamp(pkt.hopIndex, 0, Math.max(0, path.length - 2));
    const a = path[pkt.hopIndex], b = path[Math.min(pkt.hopIndex + 1, path.length - 1)];
    setText($('#insp-hop'), path.length > 1 ? (state.net.nodes[a].name + ' → ' + state.net.nodes[b].name) : state.net.nodes[a].name);
    setText($('#insp-title'), pkt.kind + ' · ' + pkt.dir.toUpperCase() + ' · id ' + pkt.id);

    const f = path.length > 1 ? fieldsAtHop(state, pkt, a, b) : { srcMac: localMac(state, a), dstMac: '—', srcIp: pkt.srcIp, dstIp: pkt.dstIp, srcPort: pkt.srcPort, dstPort: pkt.dstPort, ttl: pkt.ttlStart };

    function section(title, rows, layerIdx) {
      if (state.layerFilter >= 0 && state.layerFilter !== layerIdx) return;
      const box = el('div', { class: 'insp-section' }, [el('h4', {}, title)]);
      const dl = el('dl', { class: 'kv mono' });
      rows.forEach(([k, v, changed]) => { dl.appendChild(el('dt', {}, k)); dl.appendChild(el('dd', { class: changed ? 'changed' : '' }, String(v) + (changed ? ' ✱' : ''))); });
      box.appendChild(dl);
      secBox.appendChild(box);
    }
    section('Layer 2 — Ethernet/Wi-Fi', [['Source MAC', f.srcMac], ['Destination MAC', f.dstMac, true]], 0);
    section('Layer 3 — IPv4', [['Source IP', f.srcIp || '—'], ['Destination IP', f.dstIp || '—'], ['TTL', f.ttl]], 1);
    if (pkt.transport && pkt.transport !== 'ARP' && pkt.transport !== '—') {
      section('Layer 4 — ' + pkt.transport, [['Source port', f.srcPort || '—'], ['Destination port', f.dstPort || '—'], ['Protocol', pkt.proto]], 2);
    }
    if (pkt.payload) section('Layer 7 — Application', [['Content', pkt.payload]], 3);

    if (pkt.natEntry) {
      natBox.hidden = false;
      natBox.appendChild(el('p', { class: 'mono' }, 'NAT: ' + pkt.natEntry.internalIp + ':' + pkt.natEntry.internalPort + ' ⇄ ' + state.net.nodes[state.net.roles.nat].wanIp + ':' + pkt.natEntry.publicPort));
    }
  }

  /* ---- Encapsulation panel ------------------------------------------------ */
  const ENCAP_LAYERS = [
    { name: 'Application data', desc: 'The raw HTTP request/response content.' },
    { name: 'TCP segment', desc: 'Adds source/destination ports and sequence numbers.' },
    { name: 'IP packet', desc: 'Adds source/destination IP addresses and TTL.' },
    { name: 'Ethernet / Wi-Fi frame', desc: 'Adds source/destination MAC addresses for the current hop.' }
  ];
  function renderEncap(state) {
    const box = $('#encap-visual'); clear(box);
    const order = state.encapDir === 'send' ? ENCAP_LAYERS : ENCAP_LAYERS.slice().reverse();
    order.forEach((layer, i) => {
      const idx = ENCAP_LAYERS.indexOf(layer);
      box.appendChild(el('div', { class: 'encap-layer depth-' + i + (idx === state.encapIdx ? ' active' : '') }, layer.name));
    });
    const current = ENCAP_LAYERS[state.encapIdx];
    setText($('#encap-desc'), (state.encapDir === 'send' ? 'Sending (wrapping): ' : 'Receiving (unwrapping): ') + current.desc);
    $('#encap-send').classList.toggle('on', state.encapDir === 'send');
    $('#encap-send').setAttribute('aria-pressed', String(state.encapDir === 'send'));
    $('#encap-recv').classList.toggle('on', state.encapDir === 'recv');
    $('#encap-recv').setAttribute('aria-pressed', String(state.encapDir === 'recv'));
  }

  /* ---- BGP diagram, comparison table, failure lab list, realism notes, summary ---- */
  function renderBgp(state) {
    const dest = state.dest;
    const box = $('#bgp-diagram'); clear(box);
    const ases = [
      { id: 'AS64500', name: 'Your ISP' },
      { id: 'AS64501', name: 'Transit network' },
      { id: 'AS' + dest.as, name: dest.asName }
    ];
    const row = el('div', { class: 'bgp-row' });
    ases.forEach((a, i) => {
      row.appendChild(el('div', { class: 'bgp-as' }, [el('strong', {}, a.id), el('span', {}, a.name)]));
      if (i < ases.length - 1) row.appendChild(el('div', { class: 'bgp-arrow' }, '⇄'));
    });
    box.appendChild(row);
    setText($('#bgp-text'), 'Simulated AS path: 64500 → 64501 → ' + dest.as + '. This is a static illustration, not a live BGP routing table — real paths depend on peering agreements and policy that can change at any time.');
  }

  function renderCompare(state) {
    const table = $('#compare-table'); clear(table);
    const rows = [
      ['First hop', 'Wi-Fi access point', 'Cell tower (radio)'],
      ['Local addressing', 'ARP (IP → MAC) on a shared LAN', 'No ARP — per-subscriber GTP-U tunnel'],
      ['Gateway', 'Home router', 'Mobile core (packet gateway)'],
      ['NAT', 'One home router, few devices per public IP', 'Carrier-grade NAT (CGNAT), thousands of devices per public IP'],
      ['Typical latency', 'Lower, more stable', 'Higher, more variable'],
      ['IP address stability', 'Usually stable while connected', 'Can change between towers/cells']
    ];
    const thead = el('thead', {}, el('tr', {}, [
      el('th', { scope: 'col' }, 'Aspect'),
      el('th', { scope: 'col', tabindex: 0, role: 'button', class: state.mode === 'wifi' ? 'colsel' : '', onclick: () => setModeAndRebuild(state, 'wifi') }, '📶 Wi-Fi'),
      el('th', { scope: 'col', tabindex: 0, role: 'button', class: state.mode === 'mobile' ? 'colsel' : '', onclick: () => setModeAndRebuild(state, 'mobile') }, '📱 Mobile data')
    ]));
    table.appendChild(thead);
    const tbody = el('tbody');
    rows.forEach((r) => tbody.appendChild(el('tr', {}, r.map((c, i) => el(i === 0 ? 'th' : 'td', i === 0 ? { scope: 'row' } : {}, c)))));
    table.appendChild(tbody);
  }

  function renderLabList(state) {
    const lossSel = $('#lab-loss'); clear(lossSel);
    state.stages.forEach((s) => { if (s.dir !== 'local') lossSel.appendChild(el('option', { value: s.id }, s.title)); });
    const list = $('#lab-list'); clear(list);
    failureScenarios(state).forEach((f) => {
      list.appendChild(el('div', { class: 'lab-item' + (state.failure === f.id ? ' active' : '') }, [
        el('div', {}, [el('strong', {}, f.label), el('p', { class: 'hint' }, f.why)]),
        el('button', { class: 'btn small', type: 'button', onclick: () => runFailureLab(state, f.id) }, 'Run this scenario')
      ]));
    });
  }

  const REALISM_NOTES = [
    'Dynamic routing: real routers exchange live routing information (OSPF/IS-IS internally, BGP between networks); this simulator uses fixed, illustrative tables.',
    'HTTP/2, HTTP/3 and QUIC: modern browsers often skip plain HTTP/1.1 and use these — simplified to one request/response here.',
    'MAC addresses genuinely change at every routed (Layer-3) hop; IP addresses only change where NAT rewrites them.',
    'BGP operates between Autonomous Systems, not per packet — the AS-path diagram is a static illustration.',
    'All IP addresses, AS numbers, routers and the backbone path (R1–R4) are simulated and clearly labelled as such.',
    'A real page load triggers dozens of additional requests (images, scripts, fonts) and uses caching, retries and CDNs — this simulator follows a single representative request.'
  ];
  function renderRealism() {
    const box = $('#realism-list'); clear(box);
    REALISM_NOTES.forEach((t) => box.appendChild(el('li', {}, t)));
  }

  function renderSummary(state) {
    const body = $('#summary-body'); clear(body);
    const dest = state.dest;
    const reqCount = state.packets.filter((p) => p.dir === 'req').length;
    const respCount = state.packets.filter((p) => p.dir === 'resp').length;
    const dl = el('dl', { class: 'kv' });
    [['Destination', dest.name + ' (' + dest.ip + ')'], ['Connection type', state.mode === 'wifi' ? 'Wi-Fi' : 'Mobile data'],
     ['Steps completed', String(state.stages.length)], ['Simulated packets sent', String(reqCount)], ['Simulated packets returned', String(respCount)]]
      .forEach(([k, v]) => { dl.appendChild(el('dt', {}, k)); dl.appendChild(el('dd', {}, v)); });
    body.appendChild(dl);
    body.appendChild(el('p', {}, '🎉 The request for ' + dest.name + ' completed successfully and returned to ' + state.net.nodes[state.clientId].hostname + '.'));
  }

  /* ------------------------------------------------------------------------
   * 7. Controller — state, stage stepping, playback, event wiring, init
   * ---------------------------------------------------------------------- */
  function freshState(prev) {
    const keep = prev && $('#chk-keep').checked;
    return {
      mode: prev ? prev.mode : 'wifi',
      clientId: prev ? prev.clientId : 'pc3',
      domain: prev ? prev.domain : 'google.com',
      net: null, dest: null, stages: [], stageIndex: -1, packets: [], currentPacket: null,
      nat: keep ? prev.nat : makeNatEngine(),
      dns: keep ? prev.dns : makeDnsEngine(),
      arp: keep ? prev.arp : makeArpEngine(),
      natDemo: keep && prev.natDemo ? prev.natDemo : new Set(),
      currentNat: null, dnsQuery: null, tcpPort: null, serverPort: 443,
      learning: prev ? prev.learning : false,
      level: prev ? prev.level : 'beginner',
      speed: prev ? prev.speed : 1,
      playing: false, failure: prev ? prev.failure : null, failureExplained: false,
      selectedNode: null, layerFilter: -1, encapDir: 'send', encapIdx: 0,
      animToken: 0
    };
  }

  function rebuildNetwork(state) {
    state.dest = destFor(state.domain);
    state.net = buildNetwork(state.mode, state.clientId, state.dest);
    state.stages = buildStages(state);
    state.stageIndex = -1;
    state.packets = [];
    state.currentPacket = null;
    state.currentNat = null;
    state.dnsQuery = null;
    state.failureExplained = false;
    if (state.mode === 'wifi' && state.natDemo.size === 0) state.natDemo.add(state.clientId);
    renderAll(state);
  }

  function packetForStage(state, stage) {
    if (!stage.path || stage.path.length < 2) return null;
    const client = state.net.nodes[state.net.roles.client];
    const dest = state.dest;
    let o = { dir: stage.dir === 'resp' ? 'response' : 'request', kind: stage.kind, path: stage.path, stageId: stage.id, natEntry: state.currentNat };
    if (stage.kind === 'dns-query' || stage.kind === 'dns-response') {
      Object.assign(o, { srcIp: client.ip, dstIp: client.dns, srcPort: 53211, dstPort: 53, transport: 'UDP', proto: 'DNS', payload: 'DNS ' + (stage.kind === 'dns-query' ? 'query' : 'response') + ' for ' + dest.name, natEntry: null });
      if (stage.kind === 'dns-response') { o.srcIp = client.dns; o.dstIp = client.ip; }
    } else if (stage.kind === 'arp-request' || stage.kind === 'arp-reply') {
      Object.assign(o, { srcIp: client.ip, dstIp: client.gateway, srcPort: null, dstPort: null, transport: 'ARP', proto: 'ARP', payload: 'ARP ' + (stage.kind === 'arp-request' ? 'request' : 'reply'), natEntry: null });
    } else {
      Object.assign(o, {
        srcIp: client.ip, dstIp: dest.ip, srcPort: state.tcpPort || 50123, dstPort: state.serverPort || 443,
        transport: 'TCP', proto: stage.kind === 'tls' ? 'TLS 1.3' : stage.kind === 'http' ? 'HTTP (encrypted)' : 'TCP',
        payload: stage.kind === 'http' ? '(encrypted HTTP bytes — simulated)' : stage.kind === 'tls' ? '(TLS handshake record)' : ''
      });
    }
    return mkPacket(state, o);
  }

  function enterStage(state, index) {
    if (index < 0 || index >= state.stages.length) return;
    state.stageIndex = index;
    const stage = state.stages[index];
    if (stage.action) stage.action(state);
    const pkt = packetForStage(state, stage);
    if (pkt) { state.currentPacket = pkt; pkt.hopIndex = 0; }

    renderStepPanel(state, stage);
    renderProgress(state);
    renderPhaseStrip(state);
    renderBrowser(state, stage);
    renderNat(state); renderNatDemo(state); renderDns(state); renderArp(state);
    renderRoutingTable(state, state.selectedNode);
    renderInspector(state);
    renderRealism.done || (renderRealism(), renderRealism.done = true);
    renderBgp(state); renderCompare(state); renderLabList(state);
    appendLog(state, '[' + stage.phase + '] ' + stage.title);

    if (stage.path && stage.path.length >= 2) {
      animateAlong(state, stage.path, stage.dir === 'resp' ? 'resp' : stage.dir === 'req' ? 'req' : 'local', Math.max(250, 900 / state.speed), () => {});
    } else {
      const dot = $('#pkt-dot'); if (dot) dot.setAttribute('hidden', '');
    }
    // dim inactive PCs except during the local-delivery stage where they're relevant contrast
    $$('.node-computer', $('#topo-svg'));

    if (stage.id === 'done') {
      $('#summary-card').hidden = false;
      renderSummary(state);
      pause(state);
      $('#btn-next').disabled = true;
      $('#btn-start').disabled = true;
    } else {
      $('#summary-card').hidden = true;
    }

    if (state.failure && stage.id === failureBreakId(state) && !state.failureExplained) {
      state.failureExplained = true;
      showFailureExplanation(state);
    }
  }

  function failureBreakId(state) {
    const f = failureScenarios(state).find((x) => x.id === state.failure);
    return f ? f.breakAt : null;
  }
  function showFailureExplanation(state) {
    const f = failureScenarios(state).find((x) => x.id === state.failure);
    if (!f) return;
    pause(state);
    setText($('#step-caption'), '⚠ Failure: ' + f.label);
    setText($('#step-text'), f.explain);
    setText($('#step-real'), f.why);
    setText($('#step-simp'), 'This is an intentionally injected fault for teaching — clear it from the badge above to run normally.');
    appendLog(state, '⚠ FAILURE LAB: ' + f.label + ' — ' + f.why);
    $('#btn-next').disabled = true;
    $('#btn-start').disabled = true;
    const badge = $('#failure-badge'); badge.hidden = false;
    setText($('#failure-badge-text'), 'Lab: ' + f.label);
  }

  function nextStep(state) {
    if (state.stageIndex + 1 >= state.stages.length) return;
    enterStage(state, state.stageIndex + 1);
  }

  function play(state) {
    if (state.playing) return;
    if (state.stageIndex + 1 >= state.stages.length) return;
    state.playing = true;
    $('#btn-start').disabled = true; $('#btn-pause').disabled = false; $('#btn-next').disabled = true;
    const step = () => {
      if (!state.playing) return;
      if (state.stageIndex + 1 >= state.stages.length || $('#btn-next').disabled && state.failureExplained) { pause(state); return; }
      nextStep(state);
      if (state.failureExplained || state.stageIndex + 1 >= state.stages.length) { pause(state); return; }
      state.playTimer = later(step, Math.max(300, 1400 / state.speed));
    };
    step();
  }
  function pause(state) {
    state.playing = false;
    $('#btn-pause').disabled = true;
    if (!$('#btn-next').disabled === false) {} // no-op guard
    $('#btn-start').disabled = state.stageIndex + 1 >= state.stages.length;
    $('#btn-next').disabled = state.stageIndex + 1 >= state.stages.length || (state.failure && state.failureExplained);
  }
  function reset(state) {
    clearTimers();
    state.playing = false;
    const badge = $('#failure-badge'); badge.hidden = true;
    rebuildNetwork(state);
    $('#btn-start').disabled = false; $('#btn-pause').disabled = true; $('#btn-next').disabled = false;
    $('#summary-card').hidden = true;
    appendLog(state, '↻ Reset.');
  }
  function runFailureLab(state, id) {
    state.failure = id; state.failureExplained = false;
    reset(state);
    play(state);
  }

  function setModeAndRebuild(state, mode) {
    state.mode = mode;
    $('#sel-mode').value = mode;
    renderClientOptions(state);
    state.clientId = $('#sel-client').value;
    reset(state);
  }

  function renderAll(state) {
    renderClientOptions(state);
    renderTopology(state);
    renderNodeInfo(state, null);
    renderRoutingTable(state, null);
    renderStepPanel(state, { dir: 'local', title: 'Ready', levels: { beginner: '', intermediate: '', technical: '' }, real: '', simp: '', learn: { what: '', why: '', proto: '', transport: '', port: '', visible: '', changes: '' }, kind: '' });
    renderProgress(state); renderPhaseStrip(state);
    renderBrowser(state, null);
    renderNat(state); renderNatDemo(state); renderDns(state); renderArp(state);
    renderInspector(state);
    renderEncap(state);
    renderBgp(state); renderCompare(state); renderLabList(state);
    if (!renderRealism.done) { renderRealism(); renderRealism.done = true; }
    setText($('#tagline-domain'), state.domain);
    $('#log').textContent === '' && appendLog(state, 'Ready. Choose a connection type and computer, then press Start or Next Step.');
  }

  function wire(state) {
    $('#sel-mode').addEventListener('change', (e) => { state.mode = e.target.value; renderClientOptions(state); state.clientId = $('#sel-client').value; reset(state); });
    $('#sel-client').addEventListener('change', (e) => { state.clientId = e.target.value; reset(state); });
    $('#btn-start').addEventListener('click', () => play(state));
    $('#btn-next').addEventListener('click', () => nextStep(state));
    $('#btn-pause').addEventListener('click', () => pause(state));
    $('#btn-reset').addEventListener('click', () => reset(state));
    $('#rng-speed').addEventListener('input', (e) => { state.speed = SPEEDS[+e.target.value]; setText($('#out-speed'), state.speed + '×'); $('#rng-speed').setAttribute('aria-valuetext', state.speed + ' times speed'); });
    $('#chk-learning').addEventListener('change', (e) => { state.learning = e.target.checked; renderStepPanel(state, state.stages[state.stageIndex] || state.stages[0] || { dir: 'local', title: '', levels: { beginner: '' }, learn: {} }); });
    $$('input[name="level"]').forEach((r) => r.addEventListener('change', (e) => { if (e.target.checked) { state.level = e.target.value; if (state.stageIndex >= 0) renderStepPanel(state, state.stages[state.stageIndex]); } }));
    $('#btn-clear-failure').addEventListener('click', () => { state.failure = null; $('#failure-badge').hidden = true; reset(state); });
    $('#btn-theme').addEventListener('click', () => {
      const html = document.documentElement;
      const now = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', now);
      $('#btn-theme').setAttribute('aria-pressed', String(now === 'light'));
    });
    $('#url-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#url-input').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v)) {
        setText($('#url-error'), 'Please enter a realistic domain name, e.g. "google.com" or "example.org".');
        return;
      }
      setText($('#url-error'), '');
      state.domain = v;
      reset(state);
    });
    $('#btn-clear-log').addEventListener('click', () => { clear($('#log')); });
    $('#btn-flush-dns').addEventListener('click', () => { state.dns.flush(); renderDns(state); appendLog(state, 'DNS cache flushed.'); });
    $('#btn-flush-arp').addEventListener('click', () => { state.arp.flush(); state.arp.flushSwitch(); renderArp(state); appendLog(state, 'ARP cache flushed.'); });
    $('#btn-nat-all').addEventListener('click', () => { for (let i = 1; i <= 5; i++) state.natDemo.add('pc' + i); applyNatDemo(state); renderNatDemo(state); });
    $('#btn-nat-none').addEventListener('click', () => { state.natDemo = new Set([state.clientId]); applyNatDemo(state); renderNatDemo(state); });
    $('#insp-select').addEventListener('change', (e) => { const p = state.packets.find((x) => x.id === e.target.value); if (p) { state.currentPacket = p; renderInspector(state); } });
    $('#insp-prev').addEventListener('click', () => { if (state.currentPacket) { state.currentPacket.hopIndex = Math.max(0, (state.currentPacket.hopIndex || 0) - 1); renderInspector(state); } });
    $('#insp-next').addEventListener('click', () => { if (state.currentPacket) { const max = (state.currentPacket.path.length - 2); state.currentPacket.hopIndex = Math.min(max, (state.currentPacket.hopIndex || 0) + 1); renderInspector(state); } });
    $('#encap-send').addEventListener('click', () => { state.encapDir = 'send'; renderEncap(state); });
    $('#encap-recv').addEventListener('click', () => { state.encapDir = 'recv'; renderEncap(state); });
    $('#encap-prev').addEventListener('click', () => { state.encapIdx = clamp(state.encapIdx - 1, 0, ENCAP_LAYERS.length - 1); renderEncap(state); });
    $('#encap-next').addEventListener('click', () => { state.encapIdx = clamp(state.encapIdx + 1, 0, ENCAP_LAYERS.length - 1); renderEncap(state); });
    $('#encap-anim').addEventListener('click', () => {
      let i = 0; const dir = state.encapDir === 'send' ? 1 : -1; state.encapIdx = state.encapDir === 'send' ? 0 : ENCAP_LAYERS.length - 1;
      renderEncap(state);
      const step = () => { state.encapIdx = clamp(state.encapIdx + dir, 0, ENCAP_LAYERS.length - 1); renderEncap(state); i++; if (i < ENCAP_LAYERS.length - 1) later(step, prefersReducedMotion() ? 40 : 500); };
      later(step, prefersReducedMotion() ? 40 : 500);
    });
    $('#btn-follow').addEventListener('click', (e) => {
      const on = e.target.getAttribute('aria-pressed') !== 'true';
      e.target.setAttribute('aria-pressed', String(on));
      e.target.textContent = on ? 'Following packet' : 'Follow packet: off';
    });
    $('#lab-loss').addEventListener('change', () => {});
    $$('[data-act]').forEach((btn) => btn.addEventListener('click', (e) => {
      const act = e.currentTarget.getAttribute('data-act');
      if (act === 'replay') reset(state);
      else if (act === 'compare') $('#compare-card').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      else if (act === 'lab') $('#lab-card').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      else if (act === 'packets') $('#inspector-card').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }));
  }

  function init() {
    const state = freshState(null);
    wire(state);
    rebuildNetwork(state);
    $('#btn-pause').disabled = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
