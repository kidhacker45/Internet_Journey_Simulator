# Internet Journey Simulator

Interactive visualization of what happens when you type `google.com` —
from the browser, through DNS, ARP, your router, NAT, your ISP, the
Internet, TCP and TLS, to a Google server — and **all the way back** to
the exact computer that asked.

Built for cybersecurity / networking students. 100% static: no backend,
no database, no build step, no libraries.

## Features

- Wi-Fi simulation with a shared router
- 5-client LAN (selectable, inspectable clients)
- Mobile data simulation (cell tower, mobile core, CGNAT)
- DNS (cache, query, simulated recursive resolver)
- ARP
- DHCP (explained)
- NAT (translation table, multi-client demo, response mapping)
- Routing (home router, ISP, simulated Internet routers)
- BGP concepts (AS-to-AS reachability, simulated)
- TCP three-way handshake
- TLS 1.3 handshake
- HTTPS encrypted request / response
- Response path with NAT reverse lookup to the correct PC
- Packet inspector (L2 / L3 / L4 / L7 + lifecycle)
- Event log
- Failure laboratory (DNS / gateway / NAT / loss / TCP timeout / TLS)
- Learning mode + Beginner / Intermediate / Technical explanations
- Wi-Fi vs Mobile comparison
- Step-by-step mode, auto-play, speed control (0.5x–4x)
- Keyboard accessible, reduced-motion support, responsive

## Run locally

Open `index.html` directly in a browser, or:

```bash
python3 -m http.server 8000
```

Then visit:

```
http://localhost:8000
```

## GitHub Pages

1. Push this repository to GitHub
2. Open **Settings**
3. Go to **Pages**
4. Select the `main` branch (root)
5. Save

The site will be live at:

```
https://USERNAME.github.io/internet-journey-simulator/
```

## Project structure

```
internet-journey-simulator/
├── index.html          markup, panels, SVG host
├── style.css           dark lab theme, responsive, a11y
├── app.js              model (devices/packets/NAT/DNS/ARP) + renderer
├── README.md
└── assets/
    └── icons/
        └── icon.svg
```

## Educational purpose

This project is a conceptual networking simulator.

This simulator models common Internet networking concepts. Real network
paths, DNS responses, routing decisions, NAT behavior, transport
protocols, and cloud infrastructure can vary. Network addresses and
routes displayed in this simulation are illustrative only.
