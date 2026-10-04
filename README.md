# Tunnel File Wizard

**Send a file straight from one browser to another. No upload, no cloud storage, no waiting room.**

Tunnel File Wizard is a small, self-hostable web app for transferring files peer-to-peer using WebRTC. A sender picks a file, gets a 6-digit code (plus a QR code and a shareable link), and the moment a receiver enters that code, the two browsers open a direct connection and the file streams straight across it. The only thing Tunnel File Wizard's server ever touches is a handful of small text messages needed to introduce the two browsers to each other — it never sees, stores, or proxies the file itself.

This README covers what Tunnel File Wizard actually does under the hood, how WebRTC makes the peer-to-peer part possible, exactly what happens if a connection drops, and how to deploy it — with Docker, plain Node, behind Nginx Proxy Manager, and behind Cloudflare (both the orange-cloud proxy and Cloudflare Tunnel).

---

## Table of contents

- [What Tunnel File Wizard does](#what-tunnel-file-wizard-does)
- [How it works: the two-part architecture](#how-it-works-the-two-part-architecture)
- [How WebRTC actually makes this peer-to-peer](#how-webrtc-actually-makes-this-peer-to-peer)
- [The connection lifecycle, step by step](#the-connection-lifecycle-step-by-step)
- [How files are actually sent and received](#how-files-are-actually-sent-and-received)
- [What "nothing is stored" really means](#what-nothing-is-stored-really-means)
- [Maximum file size](#maximum-file-size)
- [If the connection drops or the sender leaves](#if-the-connection-drops-or-the-sender-leaves)
- [Features](#features)
- [Light/dark mode & theme animation](#lightdark-mode--theme-animation)
- [Share link scrambling](#share-link-scrambling)
- [Custom link names](#custom-link-names)
- [Sender name & message](#sender-name--message)
- [Setup](#setup)
  - [Quick start with Docker](#quick-start-with-docker)
  - [Docker Compose](#docker-compose)
  - [Running with plain Node / npm](#running-with-plain-node--npm)
  - [Putting it behind Nginx Proxy Manager (NPM)](#putting-it-behind-nginx-proxy-manager-npm)
  - [Exposing it with a Cloudflare Tunnel](#exposing-it-with-a-cloudflare-tunnel)
  - [Using Cloudflare's proxy (orange cloud) directly](#using-cloudflares-proxy-orange-cloud-directly)
  - [Optional: TURN relay for stricter networks](#optional-turn-relay-for-stricter-networks)
- [Environment variables](#environment-variables)
- [Known limitations](#known-limitations)

---

## What Tunnel File Wizard does

Most "send a big file" tools — WeTransfer, Google Drive, Dropbox links — work the same way: you upload the file to their servers first, the recipient downloads it from there second. That means:

- You wait through a full upload before the recipient can start downloading.
- Your file sits on a company's storage, even if only temporarily.
- The provider can (and often must, for legal/product reasons) read, scan, or retain what you send.

Tunnel File Wizard skips the middle step entirely. The sender's browser and the receiver's browser talk directly to each other over a WebRTC data channel. The file goes from one device to the other in one hop — there's no server in between holding a copy, because there's no server in the data path at all.

## How it works: the two-part architecture

Tunnel File Wizard is two very different pieces of code with two very different jobs:

**1. The signaling server (`server.js`)** — a small Node/Express app plus a WebSocket server. Its entire job is *introductions*: it hands out the 6-digit room code, checks the optional password, and relays a handful of small JSON messages (WebRTC's connection-setup handshake) between the two browsers. It renders the QR code too. That's it. It is never in the path the file itself travels.

**2. The browser client (`public/index.html`)** — one self-contained page that does everything else: the UI, the WebRTC connection setup, and the actual chunked file transfer once the connection is live.

```
   Sender's browser                                    Receiver's browser
  ┌───────────────────┐                               ┌───────────────────┐
  │                    │──1. create room──▶  Server   │                    │
  │                    │◀──2. room code────  (signal-  │                    │
  │                    │                      ing only)│                    │
  │                    │                      ▲    │   │                    │
  │                    │                      │    │   │──3. join room─────▶│
  │                    │                      │    └──▶│◀──4. joined───────│
  │                    │◀───────5. relay SDP/ICE (handshake only)──────────▶│
  │                    │                                                    │
  │                    │═══════6. direct RTCDataChannel — the file══════════│
  │                    │        travels ONLY on this line, browser-to-browser
  └───────────────────┘                                └───────────────────┘
```

Steps 1–5 are small text messages through the server. Step 6 — the actual file — never touches it.

## How WebRTC actually makes this peer-to-peer

WebRTC (Web Real-Time Communication) is a browser standard originally built for video calls, but at its core it's a general-purpose way for two browsers to open a direct, encrypted connection to each other. Tunnel File Wizard uses only the data-channel part of it (no audio/video), which behaves like a raw, ordered, encrypted pipe you can push bytes through.

Getting two browsers directly connected involves a few distinct pieces, each solving a different problem:

- **Signaling** — before two browsers can connect directly, they need to exchange some setup information: what kind of data they'll send, and how to reach each other on the network. WebRTC deliberately doesn't define *how* this exchange happens — that's left to the application. Tunnel File Wizard's signaling server does this over WebSocket: it relays an **SDP offer** (from the sender: "here's what I want to send and how) and an **SDP answer** (from the receiver: "got it, here's my side"), plus a stream of **ICE candidates** — each browser's guesses at network addresses ("I'm probably reachable at THIS address, or maybe THIS one") that the other side tries.

- **STUN** — most devices are behind a router doing NAT (Network Address Translation), so a browser doesn't actually know its own public-facing address. STUN is a dead-simple public service that a browser asks "what does my traffic look like from the outside?" — the answer becomes one of its ICE candidates. Tunnel File Wizard uses Google's and Cloudflare's public STUN servers by default (`stun.l.google.com` / `stun.cloudflare.com`) — free, and enough for the vast majority of home and office networks.

- **ICE** — this is the actual negotiation process: both browsers exchange their full list of candidate addresses (found via STUN, local network interfaces, etc.) through the signaling server, then try pairs of them until one pair actually connects. When that succeeds, you have a direct path between the two browsers — no server involved.

- **TURN (optional, off by default)** — some networks (symmetric NAT, some corporate/carrier-grade NAT, some mobile carriers) make direct connection impossible no matter what ICE tries. TURN is a relay server that both sides connect to instead, and it forwards traffic between them. It's the fallback of last resort — see [TURN relay](#optional-turn-relay-for-stricter-networks) below for the tradeoff involved in turning it on.

- **DTLS-SRTP encryption** — this part isn't optional and needs no configuration: WebRTC encrypts every data channel by default, browser to browser, using DTLS. Nobody sitting on the network path (your ISP, a public WiFi operator, a proxy in the middle) can read the file contents in transit, even without TURN.

Once ICE finds a working path and the encrypted channel opens, that's `RTCDataChannel.onopen` firing in Tunnel File Wizard's client code — and that's the exact moment the actual file transfer starts.

## The connection lifecycle, step by step

1. **Sender creates a transfer.** The client asks the signaling server for a room; the server generates a random 6-digit code — or, if the sender typed a [custom link name](#custom-link-names), claims that instead — hashes the optional password if one was set, and sends the room ID back. The sender now sees the code, a QR code, and a copy-able link.
2. **Sender waits.** The signaling WebSocket stays open, idle, waiting for someone to join. (A background ping every 25 seconds keeps this connection alive through reverse proxies that would otherwise time out an idle WebSocket — more on this in the [Cloudflare/NPM setup](#putting-it-behind-nginx-proxy-manager-npm) sections.)
3. **Receiver enters the code** (or opens the link, which fills it in automatically). The server checks the password if one is set, and if it matches, adds them to the room and notifies the sender.
4. **The actual WebRTC handshake happens.** The sender's browser creates an offer, the receiver answers, both sides trade ICE candidates — all relayed through the signaling server as small JSON messages. Both panels show a live status badge that goes from "waiting" (amber, pulsing) to "connected" (green) the moment this succeeds.
5. **The data channel opens**, and the sender immediately starts streaming the file in chunks (details in the next section). The receiver assembles them and triggers a normal browser download when the last chunk arrives.
6. **The signaling server's job is done** the moment step 4 finishes — from that point on, it's just watching an idle WebSocket in case something goes wrong (see below).

## How files are actually sent and received

Once the `RTCDataChannel` is open:

1. The sender sends one small JSON message first — the file's name, size, and MIME type.
2. The sender then reads the file in **64KB chunks** using the browser's `FileReader`, sending each chunk as raw binary over the data channel.
3. To avoid overwhelming the connection, the sender checks `dataChannel.bufferedAmount` before sending the next chunk — if more than 8MB is still queued up waiting to go out, it pauses briefly rather than piling on more data than the network can drain.
4. The receiver collects incoming chunks into memory as they arrive, updating a progress bar based on bytes received vs. the total size from step 1's metadata.
5. The sender sends one final JSON message — `done` — once every byte has gone out.
6. On receiving `done`, the receiver combines all the buffered chunks into a single `Blob` and triggers a normal file download through the browser — no server round-trip, no separate download link, just a save dialog for a file that was never anywhere but that browser's memory.

## What "nothing is stored" really means

To be precise about the actual guarantee here: **the signaling server (`server.js`) never has the file's bytes pass through it, ever, under any code path.** The only things that touch the server are:
- the room code — either the random 6-digit one, or a custom link name the sender chose
- the (hashed, never plaintext) password, if one is set
- the theme name the sender picked
- the sender's display name and/or message, if either was filled in — plain text, held only for the life of the room
- WebRTC's connection-setup metadata (SDP/ICE) — addresses and codec/format info, not file content
- small heartbeat pings to keep the connection alive

None of that is written to disk anywhere — it all lives in memory (a JavaScript `Map`) for as long as the room exists, and disappears the moment both people disconnect. There's no database, no log of past transfers, and no way to retrieve a file after the fact, because the server was never holding one.

The one nuance worth being honest about: **if you enable the optional TURN relay** (off by default — see [below](#optional-turn-relay-for-stricter-networks)), that relay server *does* pass the file's encrypted bytes through it, because that's what a relay is. It still can't read the contents (DTLS-SRTP encryption is between the two browsers, not terminated at the relay), but it is no longer strictly "never touches a server." That's a deliberate, clearly-labeled exception, not a default.

## Maximum file size

There's no size limit enforced by the server — it can't enforce one, because it never sees the file. The real constraint is on the **receiver's side**: right now, the receiving browser buffers the entire incoming file in memory (as an array of binary chunks) before assembling it into a downloadable `Blob`. That means the practical ceiling is however much memory that browser tab can hold before the tab itself becomes unstable.

Tunnel File Wizard ships with a **client-side cap of 20GB** (in `public/index.html`, the `MAX_FILE_SIZE_BYTES` constant) — trying to select a larger file shows an inline warning and disables the "Create transfer" button. This is a safety default, not a technical wall:

- **To change it:** just change `MAX_FILE_SIZE_BYTES` in `public/index.html`. Whether that's a good idea depends on the memory available on whatever device is *receiving* — a desktop with 32GB of RAM will handle a 20GB transfer; a phone browser tab will not.
- **To remove the ceiling properly** (rather than just raising the number): swap the in-memory buffer on the receiver side for the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) (`showSaveFilePicker` + a writable stream), so incoming chunks get written to disk as they arrive instead of held in RAM. That's the "real" fix for very large files and is a natural next contribution.

## If the connection drops or the sender leaves

**Short answer: there is no resume. If the connection breaks for any reason, the transfer has to start completely over from a new room/code.**

This is a deliberate simplicity tradeoff, not a bug, but it's worth understanding exactly what "the connection breaks" covers and how Tunnel File Wizard detects it:

- **The sender closes their tab, their laptop sleeps, or they lose network.** The `RTCDataChannel` closes (or the underlying `RTCPeerConnection` moves to `disconnected`/`failed`/`closed`). The receiver's connection badge turns red ("Sender disconnected"), and if a transfer was mid-flight, the status message explicitly says it was interrupted and needs to start over.
- **The receiver does the same** — symmetric behavior, sender sees "Receiver disconnected."
- **Either signaling WebSocket disconnects before the WebRTC handshake even finishes** — same outcome, surfaced immediately since the server notices the socket close and tells the other side (`peer-left`).
- **Either tab is closed mid-transfer on purpose** — a real `beforeunload` browser confirmation ("Leave site? Changes you made may not be saved") fires if a transfer is actively in progress, specifically to stop this from happening by accident.

Why no resume: resuming a broken transfer means someone (a server, or one of the two browsers) has to remember which byte ranges already arrived, across a connection that no longer exists. That's a meaningfully bigger feature — it needs either persistent state on a server (which conflicts with "the server never stores anything") or a more complex client-side protocol with byte-range tracking and re-negotiation. Tunnel File Wizard's current design trades that complexity for simplicity: **the sender and receiver's tabs must both stay open, on, and connected for the entire transfer.** Both panels show a persistent warning saying exactly this, and the live connection badges make it obvious the moment something's gone wrong rather than leaving you guessing why a progress bar stalled.

If you need resumable transfers for very large or very long-running files, that's the most impactful thing to build on top of this — it would mean the receiver acknowledging received chunk ranges, and the sender being able to reconnect to the same room and pick up from the last acknowledged point rather than restarting the whole `RTCDataChannel` handshake from scratch.

## Features

- **Direct peer-to-peer transfer** over an encrypted WebRTC data channel — no upload step, no cloud storage.
- **6-digit room codes**, an optional **custom link name**, a **QR code**, and a **shareable link** (code + optional password live in the URL fragment, which browsers never send to any server, so it can't leak into logs — see [Share link scrambling](#share-link-scrambling) below for how they're packed into the link).
- **Optional sender name and message**, shown to the receiver once they connect — see [Sender name & message](#sender-name--message) below.
- **Optional password protection** — hashed with `scrypt` server-side, checked before a receiver is allowed to join the room. This gates *access to the room*, on top of the code; it is not an additional encryption layer on the file (WebRTC's own DTLS-SRTP already handles that).
- **Themes** — the sender picks a palette; it's applied on the receiver's screen too, synced via the signaling server as plain metadata. Each theme has both a light and dark variant (see [Light/dark mode & theme animation](#lightdark-mode--theme-animation) below), and a soft animated background tinted to the current theme.
- **Live connection status** on both sides, driven by the real WebRTC connection state, not just "a WebSocket said someone's here."
- **Explicit stay-connected warnings** and a real "are you sure you want to leave" browser prompt during an active transfer.

## Light/dark mode & theme animation

The sun/moon button in the header toggles light and dark mode. The choice is saved in `localStorage` on that device (key `tunnel-file-wizard-mode`), so it persists across visits; the first time it loads with no saved preference, it follows the browser/OS's `prefers-color-scheme`.

Every theme (Amber, Midnight, Forest, Rosewood, Mono) defines a separate palette for light and dark mode — picking a theme sets the color, and picking a mode sets how light or dark that color's background is. They're independent, so any theme × either mode is a valid combination. Behind the panel, a couple of large, blurred, slowly drifting color blobs pick up the current theme's accent colors — that's the animated background; it re-tints automatically whenever the theme changes and dims down in light mode so it doesn't overpower a white background. Switching tabs or getting a room code also plays a small reveal animation. Anyone with `prefers-reduced-motion` turned on at the OS level gets all of this disabled automatically — the CSS respects that media query and drops straight to the end state with no animation.

None of this touches the signaling protocol — the receiver still only gets the theme *key* (e.g. `"midnight"`) from the sender, same as before; light/dark mode is a purely local, per-browser choice and is never synced between sender and receiver.

## Share link scrambling

The share link and the QR code both encode the same thing: the room code and, if one was set, the password. Earlier versions put those in the URL fragment as plain, readable text — `#code=123456&pw=hunter2`. That was already reasonably safe in one specific sense (browsers never send the fragment to *any* server, so it could never leak into this app's logs, a proxy's logs, or a link-preview bot's fetch), but it had an obvious downside: anyone who glanced at the address bar, a screenshot, a browser history list, or a clipboard manager could read the code and password directly off the link.

The link is now a single opaque token instead: `#t=eyJjIjoi...`. The code and password are packed into a small JSON object, XOR'd against a fixed keystream, and base64url-encoded. Scanning the QR code or opening the link decodes that token client-side and fills in the same fields it always did — nothing about how you use Tunnel File Wizard changes.

**Be clear-eyed about what this is and isn't:**

- **It is not encryption.** The "key" is a fixed string sitting in `index.html`, shipped to every visitor's browser. Anyone who opens the page's source can decode any token in seconds. This is obfuscation, not confidentiality.
- **What it actually buys you:** the code and password are no longer *legible at a glance*. A shoulder-surfer, a screenshot shared in a chat, a browser history entry, a clipboard-sync service, or a tool that scrapes visible URLs no longer sees `code=123456&pw=hunter2` sitting in plain text — they see a meaningless-looking blob. That closes off the "casual/accidental exposure" class of leak, which in practice is the more common one.
- **What it does not change:** the real security properties of a share link were, and still are, that (1) the fragment is never transmitted to any server, so it can't appear in server-side logs, and (2) the file itself is encrypted in transit by WebRTC's DTLS-SRTP regardless of any of this. Scrambling the token doesn't add protection against someone who has the link *and* is willing to open dev tools — for that, don't put a password in the link at all: leave the password field blank when creating a room and share the password itself through a separate channel (verbally, a different app), so knowing the link alone is never enough.
- **Old-style links still work.** `handleShareLink()` in `public/index.html` falls back to parsing `#code=...&pw=...` if no `t=` token is present, so bookmarked or previously-shared links from before this change don't break.

**Copying the code, link, or QR image:** all three buttons (Copy code, Copy link, Copy QR) try `navigator.clipboard` first, which only works in a *secure context* — HTTPS, or `http://localhost`. If Tunnel File Wizard is reached over plain HTTP (a bare LAN IP, or a reverse proxy without TLS), that API doesn't exist in the browser at all, and the old code had no fallback — the buttons just silently did nothing. They now fall back to the older `document.execCommand('copy')` technique for the code and link (works without a secure context), and to downloading the PNG for the QR image if the browser has no image-clipboard support. The real fix, if you're seeing this, is to put Tunnel File Wizard behind HTTPS (see the Nginx Proxy Manager / Cloudflare Tunnel sections below) — the fallback exists so the buttons work either way, not as a reason to skip TLS.

If you want a stronger property than obfuscation — e.g. a token an outside party genuinely can't unpack — that would mean the *server* holding a per-room secret and the link carrying only a random, meaningless-to-decode reference to it (the server looks up the code/password server-side instead of the browser decoding them). That's a bigger change to the "server never touches anything sensitive" design than this README's scope; flagging it here in case it's the next thing you want to build.

## Custom link names

By default a room is identified by a random 6-digit code, same as before. The "Custom link name" field on the send panel is optional — fill it in and that becomes the room's identifier instead (e.g. `team-standup`), used everywhere the code was: in the join field, the share link, and the QR code.

Rules, enforced identically on the client (`CUSTOM_CODE_RE` in `public/index.html`) and the server (`CUSTOM_CODE_RE` in `server.js`, which is the one that actually matters — never trust client-side validation alone): 3–32 characters, lowercase letters, numbers, and hyphens, no leading or trailing hyphen. Uppercase is silently lowercased before it's used, so `Team-Standup` and `team-standup` are the same room.

Two things worth knowing:
- **Names aren't reserved.** They're claimed the moment a room is created and freed the moment it's cleaned up (both peers gone), same lifecycle as a random code. If you want a stable, memorable, always-available link, you'd need to keep a room "warm" indefinitely — this app doesn't do that; it's built around one-shot transfers.
- **First come, first served.** If someone else's room is currently using the name you want, room creation fails with a "that link name is already taken" error and nothing is created — pick another. This is the same reason random codes retry against the room `Map` until they find a free one, just surfaced to the user instead of handled silently, since a custom name is a deliberate choice rather than an arbitrary one.

## Sender name & message

Two more optional fields on the send panel: your name, and a short message. Neither is required — leave both blank and nothing changes from before. Fill either in and the receiver sees it right after they connect (before the transfer starts), in a small card above the connection status: your name renders as "*Alex* wants to send you a file", and the message renders underneath it as plain text.

Like the theme, these travel through the signaling server as plain, unencrypted metadata (see [What "nothing is stored" really means](#what-nothing-is-stored-really-means)) — name capped at 60 characters, message at 300, both server-enforced regardless of what the client sends. They're held in memory only for the life of the room and are never written anywhere or shown to anyone but the one receiver who joins that room.

## Setup

### Quick start with Docker

```bash
docker build -t tunnel-file-wizard .
docker run -p 3000:3000 tunnel-file-wizard
```

Visit `http://localhost:3000`.

### Docker Compose

```bash
docker compose up --build
```

The included `docker-compose.yml` also has a commented-out `coturn` (TURN) service — see [TURN relay](#optional-turn-relay-for-stricter-networks) if you need it.

### Upgrading an existing install

```bash
./upgrade.sh
```

This backs up your `./data` directory first (users, invites, settings — an upgrade can never wipe your accounts), then rebuilds and restarts the container and waits until it's healthy. Your accounts and settings carry over untouched.

Upgrading from v1 (no accounts): nothing breaks. The server keeps working exactly as before, and the first time you open the page you'll get the one-time admin setup — see [Accounts, invites, and SMTP](#accounts-invites-and-smtp).

### Running with plain Node / npm

```bash
npm install
npm start
# visit http://localhost:3000
```

Requires Node 18+ (built and tested on Node 20).

### Putting it behind Nginx Proxy Manager (NPM)

Tunnel File Wizard works fine behind [Nginx Proxy Manager](https://nginxproxymanager.com/), but WebSocket traffic needs to be explicitly allowed through — otherwise the signaling connection (steps 1–5 in the [connection lifecycle](#the-connection-lifecycle-step-by-step)) will fail to establish.

1. Add a new **Proxy Host** pointing at wherever Tunnel File Wizard is actually running (e.g. `http://tunnel-file-wizard:3000` if it's a Docker container on the same network, or `http://<host-ip>:3000` otherwise).
2. On the **Details** tab, turn on **"Websockets Support."** This is the single most important toggle — without it, `wss://` connections get dropped and nothing will connect.
3. Request a Let's Encrypt certificate (or use your own) on the **SSL** tab, and enable **"Force SSL."** Tunnel File Wizard's client automatically switches to `wss://` when the page loads over `https://`, so this just works once the certificate's in place.
4. **Recommended:** on the **Advanced** tab, add a custom Nginx config block to raise the proxy's idle timeout, as a second layer of defense alongside Tunnel File Wizard's own 25-second WebSocket heartbeat:
   ```nginx
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   ```
   Without this, Nginx's default 60-second read timeout could close a signaling connection while a sender is still waiting for a receiver to join — the heartbeat ping Tunnel File Wizard sends every 25 seconds should already prevent this, but the explicit timeout removes any doubt.

### Exposing it with a Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`) lets you expose Tunnel File Wizard to the internet without opening any inbound ports on your router — the tunnel daemon makes an outbound connection to Cloudflare, which then routes requests back through it.

1. Authenticate and create a tunnel (once):
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create tunnel-file-wizard
   ```
2. Create a config file (e.g. `~/.cloudflared/config.yml`):
   ```yaml
   tunnel: <YOUR_TUNNEL_ID>
   credentials-file: /root/.cloudflared/<YOUR_TUNNEL_ID>.json

   ingress:
     - hostname: tunnel-file-wizard.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404
   ```
3. Route DNS to the tunnel and start it:
   ```bash
   cloudflared tunnel route dns tunnel-file-wizard tunnel-file-wizard.yourdomain.com
   cloudflared tunnel run tunnel-file-wizard
   ```

`cloudflared` proxies WebSocket upgrades transparently — there's no extra flag needed for that part, unlike a typical reverse proxy. **The one thing worth understanding clearly:** the tunnel only carries the *signaling* traffic (the HTTP page and the WebSocket handshake). Once the two browsers' `RTCDataChannel` is open, the actual file transfer goes directly between them (or through TURN, if configured) — that traffic never goes through `cloudflared`, your tunnel, or Cloudflare's network at all. This is normal and by design; it's also exactly why the file transfer stays fast and doesn't count against any Cloudflare bandwidth.

### Using Cloudflare's proxy (orange cloud) directly

If you're pointing a regular DNS record at your server's public IP with Cloudflare's proxy (the orange cloud icon) turned on, rather than using a Tunnel:

- Make sure **WebSockets** are allowed for the zone. This used to be an explicit toggle under Network settings — on current Cloudflare plans it's enabled by default, but it's worth confirming under your domain's **Network** tab if a connection ever mysteriously fails to open.
- Set your **SSL/TLS encryption mode** to **Full** or **Full (strict)**, not Flexible. Flexible mode terminates TLS at Cloudflare and talks plain HTTP to your origin, which can cause the browser to try `wss://` (secure) while Cloudflare talks `ws://` (insecure) to your server — this mismatch breaks the WebSocket upgrade. Full mode (with either Cloudflare's free Origin Certificate or your own) keeps things consistent end-to-end.
- Same note as above: Cloudflare's proxy only ever sees the signaling traffic. The peer-to-peer file transfer itself happens completely outside Cloudflare's network.

### Optional: TURN relay for stricter networks

STUN (on by default) gets most connections through. Some networks — notably symmetric NAT setups and some corporate or mobile-carrier NATs — block direct peer-to-peer connections no matter what ICE tries. TURN is the fallback: both browsers connect to a relay server instead of each other, and it forwards their traffic.

It's off by default in `docker-compose.yml` (commented out) because of the tradeoff described in [What "nothing is stored" really means](#what-nothing-is-stored-really-means) — a TURN relay does route the (still encrypted) file bytes through a server. Enable it only if you've decided that's acceptable for your use case:

```bash
docker compose up --build   # after uncommenting the coturn service and setting real credentials
```

and set these environment variables on the `signaling` service:
```bash
TURN_URL=turn:your-server-ip:3478
TURN_USERNAME=tunnel-file-wizard
TURN_CREDENTIAL=a-real-secret
```

**Important if you're also using a Cloudflare Tunnel:** `cloudflared` tunnels HTTP(S)/TCP traffic well, but TURN needs raw UDP ports open (`coturn`'s relay range) — that generally isn't something a standard Cloudflare Tunnel carries. Run `coturn` with its UDP ports forwarded directly on your server's public IP (via your router/firewall) rather than trying to route it through the tunnel.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `PORT` | `server.js` | Port the signaling server listens on. Defaults to `3000`. |
| `TURN_URL` | `server.js` | Optional TURN server URL (e.g. `turn:your-server-ip:3478`) handed to clients alongside the default STUN servers. |
| `TURN_USERNAME` | `server.js` | Username for the TURN server above. |
| `TURN_CREDENTIAL` | `server.js` | Credential/password for the TURN server above. |
| `DATA_DIR` | `server.js` | Where the accounts database (`tunnel-file-wizard.json`) lives. Defaults to `./data`. Mount a volume here in Docker so users survive rebuilds. |
| `LOGIN_REQUIRED` | `server.js` | Set to `1` to require sign-in for sending/receiving. First-run default only — the admin panel toggle wins after that. |
| `SIGNUP_MODE` | `server.js` | `invite` (default) or `public`. First-run default only — the admin panel toggle wins after that. |
| `SITE_URL` | `server.js` | Public URL of this server (e.g. `https://files.example.com`), used for links in emails. First-run default only. |
| `SITE_NAME` | `server.js` | Display name for the server. First-run default only. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_ENCRYPTION` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | `server.js` | Your mail server, for invite and password-reset emails. `SMTP_ENCRYPTION` is `starttls` (port 587), `ssl` (port 465), or `none` (port 25). First-run defaults only — the admin panel owns these afterwards. |
| `COOKIE_SECURE` | `server.js` | `auto` (default: secure cookies only over HTTPS), `1` (always), or `0` (never — only for plain-HTTP testing). |

## Accounts, invites, and SMTP

Out of the box the server works exactly like v1: anyone with the link can send and receive, no accounts. The accounts system is there for when you want control over who uses your server.

**First run.** The first time you open the server with no accounts, you're taken to a one-time setup page that creates the admin account. Do this on the admin's device.

**The admin panel** (`/admin.html`, admin accounts only) has:

- **Access control** — the two master switches:
  - **Login required.** When ON, only signed-in users can create or join transfers. Anonymous visitors get a lock screen, and the signaling server itself rejects their room create/join messages — so strangers can't use your server for anything, good or bad. When OFF, the server behaves exactly like v1 (open to anyone with the link).
  - **Sign-up mode** (only matters when login is required): **Invite only** — new users need a code you generate; or **Public sign-up** — anyone can create an account.
- **Users** — create, disable/enable, reset passwords, promote/demote, delete. You can't demote, disable, or delete the last admin (or yourself).
- **Invites** — create single- or multi-use codes with optional expiry and an optional locked-to email address. Copy the sign-up link, or email it straight from the panel (needs SMTP below).
- **Email (SMTP)** — connect your own mail server: host, port, STARTTLS/SSL/none, username, password, from-address. A **Send test email** button verifies the connection before you rely on it. Invite emails and password-reset emails go out through it; nothing is ever sent anywhere else. The same settings can be seeded from `SMTP_*` environment variables on first run.
- **Trusted devices** — devices that skip sign-in entirely. This is how the admin's device "is the service": tick **Trust this device** at sign-in (or on the account page) and that browser never sees a login screen again. Revoke any device you don't recognize.
- **Transfer log** — who created which room and when. Metadata only: the server still never sees file names, sizes, or contents.

**User side.** Signed-in users get `/account.html`: their profile (display name, password change), trusted-device management, and "My transfers" — the rooms they've created. Sign-in is email + password (scrypt-hashed, rate-limited); forgotten passwords go through an emailed reset link when SMTP is configured.

**Data.** Everything lives in one JSON file (`DATA_DIR/tunnel-file-wizard.json`, `./data` by default, `./data:/app/data` in Docker). Back it up like anything else; sessions and trusted-device tokens are random 256-bit values, password hashes never leave the server.

## Themes, light/dark mode, and your logo

Every page — the transfer UI and all the account/admin pages — supports light and dark mode (sun/moon button in the header, follows your OS preference until you pick) and the same 5 themes (Amber, Midnight, Forest, Rosewood, Mono). On the account page you can pick the theme for that device; the sender's theme choice per transfer still works exactly as before.

**Branding:** the admin panel has a Branding section where you upload two logos — one for dark mode, one for light mode (PNG, JPG, WebP, GIF, or SVG, under 500 KB each). The right one appears automatically in the header of every page based on the viewer's mode. Two extra toggles let you hide the default yellow icon and/or the "Tunnel File Wizard" text for a logo-only header. Logos are stored under `./data/branding/` so they survive upgrades.

## Known limitations

- **No resume after a dropped connection** — by design, see [above](#if-the-connection-drops-or-the-sender-leaves).
- **Receiver buffers the whole file in memory** before triggering the download — see [Maximum file size](#maximum-file-size).
- **One file per transfer** in this version — sending multiple files means zipping them first, or extending the protocol to loop the meta → chunks → done cycle.
- **Room codes are short (6 digits) and not rate-limited** — fine for personal/small-team use; add rate limiting before exposing this to the general public.
- **Password protection gates room access, not the file itself** — the file is already encrypted in transit by WebRTC regardless of whether a password is set.
- **Share-link scrambling is obfuscation, not encryption** — see [Share link scrambling](#share-link-scrambling). Anyone with dev tools can unpack a token; it just stops the code/password from being readable at a glance.

## What's already built in (v2)

The "ask AI to add more" list from v1 is now done — all of it lives in this repo:

- **Admin panel** (`/admin.html`): users, invites, access toggles, SMTP, trusted devices, transfer log — see [Accounts, invites, and SMTP](#accounts-invites-and-smtp).
- **Signups and logins**: invite-only or public sign-up, email + password sign-in, password resets.
- **Email sending**: your own SMTP server, wired to invites and password resets, with a test button.
- **Transfer tracking**: who created which room and when (metadata only — the server still never touches file contents).

Still genuinely not built (and still good next contributions): payment portals, multi-file transfers, resumable transfers, streaming writes for very large files (see [Maximum file size](#maximum-file-size)), and relay-network analytics.
