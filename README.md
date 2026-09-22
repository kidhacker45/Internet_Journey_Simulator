# Internet Journey Simulator

An interactive, static, single-page simulator that walks students through
everything that happens between typing a web address and seeing the page —
DNS, ARP, NAT, routing, the ISP, a simplified Internet backbone and BGP/AS
path, TCP, TLS 1.3, HTTPS, and the full response journey back to the
correct computer.

Built for **VAC-II — Introduction to Cyber Security**, for students with
little or no networking background. It is pure HTML/CSS/vanilla JavaScript
and SVG — there is no backend, no database, no authentication, and no real
network traffic of any kind. Everything shown (IP addresses, AS numbers,
routers, timings) is a clearly labelled simulation for teaching purposes.

## Features

- **Two connection modes.** Wi-Fi (five computers, PC1–PC5, behind one home
  router — pick which one initiates the request) and Mobile data (phone →
  cell tower → mobile core → CGNAT → ISP), so students can compare them
  directly.
- **A full, data-driven journey** (24–34 steps depending on mode): URL entry,
  DNS query/response with a resolver cache, ARP request/reply and a switch
  MAC table (Wi-Fi only), packet construction (encapsulation), a router's
  routing-table decision, NAT translation with an inspectable NAT table,
  three ISP hops, a "SIMULATED INTERNET PATH" backbone (R1–R4, explicitly
  labelled as not a real traceroute), a simplified BGP/AS-path diagram, the
  destination's anycast edge, the TCP three-way handshake, the TLS 1.3
  handshake, an encrypted HTTPS request/response, and a clearly marked
  **"RESPONSE STARTS HERE"** reversal that retraces every hop back —
  including the NAT lookup that proves the reply returns to the *one*
  computer that asked, not any of the others.
- **Step-by-step or automatic playback**, with a 0.5×/1×/2×/4× speed
  control, a progress bar, and a phase strip.
- **Packet inspector**: pick any packet and see its Ethernet, IPv4,
  TCP/UDP and application-layer fields recalculated for the current hop,
  with changed fields marked ✱ (MAC addresses change every routed hop;
  IP/port only change where NAT rewrites them).
- **Device info panel, NAT table, DNS cache, ARP cache, routing tables and
  a BGP/AS diagram** — all clickable/inspectable, all driven by the same
  internal network model (not hand-scripted per step).
- **Five-computer NAT demonstration**: turn on other PCs to see multiple
  simultaneous NAT sessions and confirm a reply only reaches the PC that
  opened the connection.
- **Failure Lab** ("Lab: break the Internet"): DNS failure, router/gateway
  failure, NAT mapping failure, packet loss + retransmission, TCP timeout,
  and TLS certificate failure — each interrupts the journey and explains
  what broke and why.
- **Learning Mode** adds a "what happened / why / protocol / transport /
  port / what's visible / what changes" breakdown to every step.
- **Beginner / Intermediate / Technical** explanation levels for the same
  underlying simulation.
- **Wi-Fi vs Mobile comparison table**, and a running "real networking
  concept vs. simplified simulation" note on every step plus a summary
  reference list.
- **Encapsulation view**: step or animate through Application data → TCP
  segment → IP packet → Ethernet/Wi-Fi frame, in both directions.
- Dark/light theme, responsive down to small phones, keyboard-navigable,
  ARIA live regions for step changes, and `prefers-reduced-motion` support.

## Running it locally

No build step and no dependencies. Either:

1. Open `index.html` directly in a browser, **or**
2. Serve the folder so relative paths behave exactly as they will on the
   web:
   ```bash
   cd internet-journey-simulator
   python3 -m http.server 8000
   ```
   then visit `http://localhost:8000`.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository (the three files — `index.html`,
   `style.css`, `app.js` — and the `assets/` folder should sit at the repo
   root, or in the folder you choose as the Pages source).
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a
   branch", pick the branch (e.g. `main`) and the folder (`/root` or
   `/internet-journey-simulator` if you kept it nested), then **Save**.
4. GitHub will publish the site at
   `https://<your-username>.github.io/<repo-name>/` within a minute or two.

## Educational purpose & scope

This is a teaching aid, not a network diagnostic tool. Every IP address, MAC
address, AS number, router name, timing figure and certificate shown is
illustrative. Real DNS resolution, routing, NAT behaviour and transport/TLS
negotiation vary by network, provider and moment — the simulator's job is to
make the *shape* of that journey visible and inspectable, not to reproduce
any specific real connection. The footer of the app repeats this note, and
every step explicitly separates the real networking concept it teaches from
the simplification the simulator makes to show it.
