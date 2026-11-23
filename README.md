# OpenDiscord

A Discord-style app for a small group of friends that runs **without any server**:
text channels, file sharing, voice channels, webcam and screen sharing. Everything goes
directly between your computers, encrypted end to end.

![three friends](build/icon.png)

## What you get

| | OpenDiscord | Discord (free tier, as of 2025) |
|---|---|---|
| Text channels, replies, edits, reactions, @mentions, markdown | ✅ | ✅ |
| Emoji picker, `:shortcodes:`, pinned messages, link previews | ✅ | ✅ |
| Friends, private chats and private calls | ✅ | ✅ |
| File sharing | ✅ any size, sent directly | 10 MB limit |
| Code and markdown files | ✅ previewed with syntax highlighting | ✅ |
| Voice channels | ✅ Opus up to 192 kbps | 64–96 kbps |
| Noise suppression | ✅ RNNoise (AI), runs on your PC | ✅ Krisp |
| Screen share | ✅ up to 4K · 60 fps, GPU-encoded (H.264/HEVC/AV1), zoomable | 720p · 30 fps |
| Webcam | ✅ | ✅ |
| Moderation: kick, admins, mute for everyone, move between channels | ✅ | ✅ |
| Profile and group pictures | ✅ synced, visible offline | ✅ |
| Updates | ✅ automatic, from this repo's GitHub releases | ✅ |
| Where your data lives | only on your three PCs | Discord's servers |
| Encryption | end to end, always | calls only; messages readable by Discord |

Every call tile shows the **real ping, path (LAN/direct, IPv4/IPv6), resolution, fps, bitrate and
codec**, so you can see what you're getting.

## Getting started (for your friends)

**Windows:** download `OpenDiscord-Setup-<version>.exe` from the newest
[release](../../releases) and run it. It installs for your user only (no admin needed) and
**updates itself** from then on. Windows SmartScreen will warn because the app isn't code-signed:
*More info → Run anyway*. If Windows Firewall asks, allow access on **private networks**.
(There's also a portable `.exe`. It can't update itself, so its first update installs the app.)

**Mac/Linux:** install [Node.js 20+](https://nodejs.org), then from this folder:
`npm install` and `npm start`. (Mac `.dmg`/Linux AppImage builds have to be made on those systems:
`npm run dist:mac` / `npm run dist:linux`.)

Then:
1. Pick a display name. You can add a profile picture in Settings → My profile.
2. One person clicks **Create a group** and copies the invite code (`OD1-…`).
3. Send the code to your friends privately (in person, Signal, WhatsApp). **The code is the group
   key:** anyone who has it can join and read the history.
4. Friends click **Join with invite** and paste it. Channels and history sync as soon as anyone
   in the group is online.
5. If you still don't see each other after a minute, see
   [If you can't see each other](#if-you-cant-see-each-other). (VPNs are the usual cause.)

**Friends and private chats:** click the people icon at the top of the left bar → **Add friend**.
Copy your friend code (`ODF1-…`) and send it to your friend, or paste theirs. Their app gets the
request directly from yours as soon as you're both online. Once they accept, you have a private
chat with a call button. You can also add anyone you share a group with: click their name.

Tips:
- Closing the window keeps the app running in the tray, so friends can sync messages from you.
  Quit from the tray icon. (Settings → Network to turn this off.)
- `Ctrl+Shift+F9` mute / `Ctrl+Shift+F10` deafen work globally while you're in a call.
- **Right-click a person** (member list, call tile, voice channel) for their volume, *Mute for
  me*, and, if you're the group's owner or an admin: *Mute for everyone*, *Move to* another voice
  channel, *Disconnect* and *Kick*. The owner can make people admins there.
- Screen shares: scroll to **zoom** in (up to 8×) and drag to pan. Double-click (or ⤢) for fullscreen.
- Type `:` and a name (`:fire`) for emoji. Hover a message to **pin** it; pins are in the 📌 menu.
- Settings → Voice & audio → **Noise suppression**: *AI (RNNoise)* (default) removes fans, keyboard
  clicks and hum. Use *Hear yourself* next to the mic meter to check it.
- Settings → **Storage** moves your data (identity, history, files) to another folder or drive.
- Settings → Privacy → **Link previews** turns off fetching previews for links you send.

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
- **Private chats** are two-person groups whose key both of you derive from an X25519 key exchange
  between your identity keys. Nobody else can compute it, and both apps refuse anyone but the two
  of you even if the key leaked. A friend code is just your public key and name, so it's safe to
  share. Every app listens on its own key, which is how a friend request reaches you directly.
- **Roles and kicking:** whoever creates a group is its owner (pinned by the first, signed op).
  The owner can make members admins. Owner and admins can kick, mute for everyone and move people.
  A **kick rotates the group key**: the new key is sealed to each remaining member's identity key
  inside the signed kick op, so the kicked person can't read anything sent afterwards and their
  copy of the invite stops working. Everyone's app checks who may moderate whom, so a member
  can't fake a kick.
- **Link previews** are made by the *sender's* app (title, description, a small thumbnail) and
  sent as part of the signed message. Friends' apps never load anything from the web: they show
  the preview the sender attached. Pictures inside markdown files aren't loaded either.
- **Noise suppression** runs [RNNoise](https://github.com/xiph/rnnoise) (a small neural network)
  in an AudioWorklet on your PC, before your voice is encoded.

### "Truly P2P": what does touch a third party?

Being precise about it:
- **DHT bootstrap nodes** (run by Holepunch) are the first contact to join the DHT. Like every DHT
  node, they can see the hashed topic and your IP address, and they forward the encrypted
  hole-punch handshake. They never see message content, names or the group secret, and **no
  chat/voice/file data** flows through them.
- **STUN servers** (Google/Cloudflare by default) answer "what's my public IP:port?" for WebRTC.
  They carry **no** media. You can change or remove them in Settings → Network.
- There are **no TURN/relay servers**, by design.
- **Websites you link to**, if link previews are on: your app fetches the page to build the preview,
  so that site sees your IP address (as if you'd opened the link). YouTube previews use YouTube's
  public oEmbed endpoint. Your friends' apps don't contact the site.

## Is it actually faster?

- **Screen share: yes, a lot.** No server caps or server-side re-encoding: you get whatever your
  upload can carry. 1080p60 needs ~10 Mbps upload *per viewer* (2 viewers in a group of 3).
- **Files: yes.** Straight from PC to PC at your connection speed, with no size limit.
- **Voice latency: somewhat.** Friends in the same city usually get 5–20 ms ping directly, versus
  routing through a Discord data center. You save the detour, but most mouth-to-ear delay comes
  from audio buffering on both ends, so expect "snappier", not "night and day".

## If you can't see each other

**Settings → Network → Connection check** (also shown on the "Waiting for a friend" screen) tells
you what's wrong: whether you're on the P2P network, whether a VPN is in the way, your NAT type,
and *why* connecting to a friend failed. **Copy diagnostics** gives you a text summary to send to each other.

Without relays, a direct connection needs at least one of you to be on a "hole-punchable" network:
- **Turn off your VPN** (or exclude OpenDiscord in its split-tunneling settings). This is the most
  common cause. VPN servers use NATs that block hole punching, and calls would detour through the VPN
  server anyway.
- Hole punching fails when **both** sides are behind a "randomized" NAT: VPNs, mobile hotspots,
  and **CGNAT** (some cable/fiber providers, DS-Lite). One friend on normal home internet is enough
  to connect to both others. If you're stuck behind CGNAT, ask your ISP for a public IPv4 address.
- IPv6 doesn't help with this part: the P2P network (HyperDHT) connects over IPv4 only. Once you're
  connected, calls do use IPv6 if both of you have it.
- On the same Wi-Fi it always works (LAN).
- After fixing your network, click **Retry now**. The app also looks for friends again every minute
  while nobody is connected.

## Limitations (it's a side project)

- History lives only on members' devices. If nobody who has a message is online, a newcomer has
  to wait. History on disk is **not encrypted at rest**, so use BitLocker/FileVault.
- Anyone with the invite code can join. Kicking someone cuts them off and changes the key, but
  they keep the messages and files they already had. Nothing can take back data from a PC.
- If the owner loses their data folder, nobody can promote new admins (existing admins keep
  their powers). Back up the folder (Settings → Storage shows where it is).
- No push-to-talk (toggle hotkeys instead), search, threads, custom emoji, bots or mobile app.
- A mesh is perfect for 3–5 people. For 10+ in one call you'd want an SFU (a server).
- System-audio capture when screen sharing (Windows) captures *all* sound, including friends'
  voices, so they may hear themselves. It's off by default.

## Updates and releases

**For everyone using the app:** it checks GitHub for a new version a few seconds after starting
and every 3 hours after that. It downloads new versions in the background and verifies their
SHA-512 hash. A green **Restart to update** button then appears in the title bar. If you
ignore it, the update installs the next time you quit the app. Settings → Updates shows the
version, lets you check by hand, and turns automatic checks off.

**For whoever maintains the repo:** releasing is automatic.
[`.github/workflows/release.yml`](.github/workflows/release.yml) runs on every push to `main`. It
runs the tests, builds the installer and portable exe, and publishes a GitHub release `vX.Y.Z`.
- **Version numbers:** `major.minor` comes from `package.json` and the patch number counts up
  by itself (0.2.0, 0.2.1, 0.2.2, …). For a bigger release, set `package.json` to e.g. `0.3.0`.
- **Skipping a release:** start the commit's first line with `[skip release]` to push without
  releasing. Only the first line counts.
- **The repository must be public**, because the app downloads updates without logging in.
  To keep the source private, create a separate **public** repo for releases (with a README so
  it has a commit). Then, in this repo's *Settings → Secrets and variables → Actions*, add:
  - the variable `RELEASES_REPO` set to `owner/name` of that repo, and
  - the secret `RELEASES_TOKEN`, a fine-grained token with *Contents: Read and write* on it.

  The workflow then publishes there and builds the app to look for updates there.
- **Security:** anyone who can push to `main` (or holds that token) can ship code to every
  friend's PC. Keep push access to people you trust, and turn on 2FA.

## Development

```bash
npm install
npm start                 # run the app
npm run dev:alice         # isolated profiles to simulate several friends on one PC
npm run dev:bob
npm test                  # headless tests: sync, gossip, auth, forged messages, files, kick, friends
npm run test:e2e          # drives two real app instances through every feature (chat, files, call, friends…)
npm run dist              # Windows installer + portable .exe into dist/
npm run test:update       # after dist: update flow against a local feed (never installs anything)
```

`OD_EXE=dist/win-unpacked/OpenDiscord.exe npm run test:e2e` runs the same e2e against the
packaged build. `REAL_CAPTURE=1` uses your real screen instead of Chromium's test pattern.
Screenshots go to `test/screenshots/` (gitignored, because they can contain your screen).

```
src/main/          Electron main process
  crypto.js        invite and friend codes, membership HMAC, op signatures, sealed boxes, DM keys
  store.js         identity, settings, friends, roles/kicks, per-group signed op log, blob store
  network.js       Hyperswarm connections, auth, sync/gossip, friend requests, file transfer
  linkpreview.js   builds link previews (OpenGraph, YouTube oEmbed) for links you send
  datadir.js       choosing and moving the data folder
  updater.js       self-update from GitHub releases
  framing.js       length-prefixed JSON/binary frames
  main.js          window, IPC, custom protocols, screen-capture picker
src/preload/       the narrow API the UI is allowed to call
src/renderer/      UI (Preact + htm, no build step)
  lib/model.js     derives channels/messages/reactions/pins/roles from ops
  lib/voice.js     WebRTC mesh, codecs, bitrates, speaking detection, moderation, stats
  lib/denoise.js   RNNoise noise suppression (AudioWorklet: lib/rnnoise-worklet.js)
  lib/markdown.js  chat markdown and full markdown documents
  lib/highlight.js syntax highlighting for code blocks and code files
  views/           chat, call stage, friends, members/context menu, emoji picker, modals
```

Third-party pieces shipped with the app: [RNNoise](https://github.com/xiph/rnnoise) via
[`@shiguredo/rnnoise-wasm`](https://github.com/shiguredo/rnnoise-wasm) (Apache-2.0; RNNoise itself
BSD-3-Clause) and emoji data from [`unicode-emoji-json`](https://github.com/muan/unicode-emoji-json) (MIT).
