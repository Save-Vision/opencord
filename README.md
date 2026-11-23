# OpenDiscord

A Discord-style app for a small group of friends that runs **without any server**:
text channels, file sharing, voice channels, webcam and screen sharing. Everything goes
directly between your computers, encrypted end to end.

![three friends](build/icon.png)

## What you get

| | OpenDiscord | Discord (free tier, as of 2025) |
|---|---|---|
| Text channels, replies, edits, reactions, @mentions, markdown | ✅ | ✅ |
| File sharing | ✅ any size, sent directly | 10 MB limit |
| Voice channels | ✅ Opus up to 192 kbps | 64–96 kbps |
| Screen share | ✅ up to 4K · 60 fps, GPU-encoded (H.264/HEVC/AV1) | 720p · 30 fps |
| Webcam | ✅ | ✅ |
| Where your data lives | only on your three PCs | Discord's servers |
| Encryption | end to end, always | calls only; messages readable by Discord |

Every call tile shows the **real ping, path (LAN/direct, IPv4/IPv6), resolution, fps, bitrate and
codec**, so you can see what you're getting.

## Getting started (for your friends)

**Windows:** run `OpenDiscord-0.1.0-portable.exe` (build it with `npm run dist`, see below).
Windows SmartScreen will warn because the app isn't code-signed: *More info → Run anyway*.
If Windows Firewall asks, allow access on **private networks**.

**Mac/Linux:** install [Node.js 20+](https://nodejs.org), then from this folder:
`npm install` and `npm start`. (Mac `.dmg`/Linux AppImage builds have to be made on those systems:
`npm run dist:mac` / `npm run dist:linux`.)

Then:
1. Pick a display name.
2. One person clicks **Create a group** and copies the invite code (`OD1-…`).
3. Send the code to your friends privately (in person, Signal, WhatsApp). **The code is the group
   key:** anyone who has it can join and read the history.
4. Friends click **Join with invite** and paste it. Channels and history sync as soon as anyone
   in the group is online.

Tips:
- Closing the window keeps the app running in the tray, so friends can sync messages from you.
  Quit from the tray icon. (Settings → Network to turn this off.)
- `Ctrl+Shift+F9` mute / `Ctrl+Shift+F10` deafen work globally while you're in a call.
- Hover a person's tile in a call for a per-friend volume slider.
- Double-click a screen share (or the ⤢ button) for fullscreen.

## How it works

```
 ┌────────── you ──────────┐                       ┌──────── friend ─────────┐
 │ Electron UI (Preact)    │   WebRTC DTLS-SRTP    │                         │
 │  voice/video/screen ◄───┼───────────────────────┼───►  (direct, UDP)      │
 │                         │                       │                         │
 │ main process            │  Hyperswarm (Noise)   │                         │
 │  signed op log, files ◄─┼───────────────────────┼───►  chat, files,       │
 │                         │                       │      call signalling    │
 └─────────────────────────┘                       └─────────────────────────┘
            ▲  announce sha256(group secret)                ▲
            └──────────── HyperDHT (public P2P DHT) ────────┘
```

- **Finding each other:** each group announces `sha256(secret)` on the
  [HyperDHT](https://github.com/holepunchto/hyperdht), a Kademlia DHT run by its own users.
  Hyperswarm then **UDP hole-punches** a direct connection. No relay is configured, so your bytes
  never pass through anyone else's machine.
- **Encryption & auth:** connections use the Noise protocol (Ed25519/X25519 + ChaCha20-Poly1305).
  Before a peer gets *anything*, it must prove it knows the group secret with an HMAC bound to that
  connection's handshake hash, so DHT observers and replayers get nothing.
- **Chat history** is an append-only log of operations (message, edit, reaction, rename, ...).
  Each op is **signed** with the author's key and numbered per author, so syncing is just
  "here's the highest number I have from each of you". Ops are gossiped, so if Alice is offline,
  Carol still gets Alice's messages from Bob. All three of you converge on the same state.
- **Files** are content-addressed (SHA-256), streamed directly from whoever has them, and verified
  on arrival. Files up to 25 MB are copied automatically so they stay available when the sender is
  offline (Settings → Network).
- **Calls** are a WebRTC full mesh (each pair connects directly; ideal for 3 people). Media is
  DTLS-SRTP encrypted end to end. The DTLS fingerprints travel over the authenticated Hyperswarm
  link, so a call can't be man-in-the-middled. Starting a screen share doesn't renegotiate; the
  stream just swaps into a pre-negotiated slot.

### "Truly P2P": what does touch a third party?

Being precise about it:
- **DHT bootstrap nodes** (run by Holepunch) are the first contact to join the DHT. Like every DHT
  node, they can see the hashed topic and your IP address, and they forward the encrypted
  hole-punch handshake. They never see message content, names or the group secret, and **no
  chat/voice/file data** flows through them.
- **STUN servers** (Google/Cloudflare by default) answer "what's my public IP:port?" for WebRTC.
  They carry **no** media. You can change or remove them in Settings → Network.
- There are **no TURN/relay servers**, by design.

## Is it actually faster?

- **Screen share: yes, a lot.** No server caps or server-side re-encoding: you get whatever your
  upload can carry. 1080p60 needs ~10 Mbps upload *per viewer* (2 viewers in a group of 3).
- **Files: yes.** Straight from PC to PC at your connection speed, with no size limit.
- **Voice latency: somewhat.** Friends in the same city usually get 5–20 ms ping directly, versus
  routing through a Discord data center. You save the detour, but most mouth-to-ear delay comes
  from audio buffering on both ends, so expect "snappier", not "night and day".

## If a call won't connect

Without relays, a direct connection needs at least one of you to be reachable:
- **IPv6** is the best fix and is enabled on most fiber and many cable connections. If both of you
  have it, it almost always connects. Check the path label on the call tile.
- Hole punching fails when **both** sides are behind strict "symmetric" NAT, which is common with
  **CGNAT** (mobile hotspots, some cable/fiber providers, DS-Lite IPv4). Ask your ISP for a
  public IPv4 or "Dual Stack", or use IPv6.
- On the same Wi-Fi it always works (LAN).

## Limitations (it's a side project)

- History lives only on members' devices. If nobody who has a message is online, a newcomer has
  to wait. History on disk is **not encrypted at rest**, so use BitLocker/FileVault.
- Anyone with the invite code is a member, and there's no kick. To remove someone, create a new
  group and re-invite everyone else.
- No push-to-talk (toggle hotkeys instead), search, threads, custom emoji, bots or mobile app.
- A mesh is perfect for 3–5 people. For 10+ in one call you'd want an SFU (a server).
- System-audio capture when screen sharing (Windows) captures *all* sound, including friends'
  voices, so they may hear themselves. It's off by default.

## Development

```bash
npm install
npm start                 # run the app
npm run dev:alice         # isolated profiles to simulate several friends on one PC
npm run dev:bob
npm test                  # headless tests: sync, gossip, auth, forged messages, file transfer
npm run test:e2e          # drives two real app instances: chat, image, voice call, screen share
npm run dist              # Windows installer + portable .exe into dist/
```

`OD_EXE=dist/win-unpacked/OpenDiscord.exe npm run test:e2e` runs the same e2e against the
packaged build. `REAL_CAPTURE=1` uses your real screen instead of Chromium's test pattern.
Screenshots go to `test/screenshots/` (gitignored, because they can contain your screen).

```
src/main/      Electron main process
  crypto.js    invite codes, membership HMAC, op signatures
  store.js     identity, settings, per-group signed op log, blob store
  network.js   Hyperswarm connections, auth, sync/gossip, file transfer
  framing.js   length-prefixed JSON/binary frames
  main.js      window, IPC, custom protocols, screen-capture picker
src/preload/   the narrow API the UI is allowed to call
src/renderer/  UI (Preact + htm, no build step)
  lib/model.js derives channels/messages/reactions from ops
  lib/voice.js WebRTC mesh, codecs, bitrates, speaking detection, stats
```
