# OpenDiscord

A Discord-style app for a small group of friends that runs **without any server**:
text channels, file sharing, voice channels, webcam and screen sharing. Everything goes
directly between your computers, encrypted end to end.

![three friends](build/icon.png)

## What you get

| | OpenDiscord | Discord (free tier, as of 2025) |
|---|---|---|
| Text channels, replies, edits, reactions, @mentions, markdown | ✅ | ✅ |
| Threads (side panel, "also send to channel", follow + unread) | ✅ | ✅ |
| Shared calendar (RSVP, reminders) and task board per group / private chat | ✅ | ❌ |
| Folders for channels (nested up to 3 levels, drag and drop) | ✅ | one level (categories) |
| Chess in any channel or private chat, with or without a clock | ✅ | via Activities |
| Texas hold'em poker for 2–8, cards dealt fairly with no dealer to trust | ✅ | via Activities |
| Polls (one or several answers, optional end time) | ✅ | ✅ |
| Search (`from:`, `in:`, `has:`, `before:`, `after:`) | ✅ on your PC, also offline | ✅ |
| Soundboard (your group's own sounds) | ✅ | ✅ |
| Status: online, away (automatic when idle), appear offline | ✅ | ✅ |
| Ask Claude (AI) with `@claude` in any chat, using your own API key; it only reads what you allow | ✅ | ❌ |
| Account backup with a password, restore on a new PC | ✅ | (account lives on their servers) |
| One-time invite links, "only admins can invite" | ✅ | ✅ |
| Emoji picker, `:shortcodes:`, pinned messages, link previews | ✅ | ✅ |
| Friends, private chats and private calls | ✅ | ✅ |
| File sharing | ✅ any size, sent directly | 10 MB limit |
| Code and markdown files | ✅ previewed with syntax highlighting | ✅ |
| Voice channels | ✅ Opus up to 192 kbps | 64–96 kbps |
| Noise suppression | ✅ RNNoise (AI), runs on your PC | ✅ Krisp |
| Screen share | ✅ up to 4K · 60 fps, GPU-encoded (H.264/HEVC/AV1), zoomable, see who's watching | 720p · 30 fps |
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
2. One person clicks **Create a group**, then **Create invite link**, and sends the
   `opendiscord://join/…` link to one friend. **Each link lets exactly one person in** and then
   stops working (it also expires, after 7 days by default), so a forwarded link is harmless.
   Make one link per friend.
3. The friend clicks the link (it opens OpenDiscord), or pastes it under **Join with invite**.
   Someone from the group has to be online at that moment: their app checks the link is unused
   and hands over the group key, encrypted for the newcomer only. Channels and history then sync.
4. If you still don't see each other after a minute, see
   [If you can't see each other](#if-you-cant-see-each-other). (VPNs are the usual cause.)

The group owner and admins can switch on **Only the owner and admins can invite** in the invite
window. Members then can't make links, and links they made earlier stop working.

**Friends and private chats:** click the people icon at the top of the left bar → **Add friend** →
**Create a friend link**, and send it. Whoever opens it first becomes your friend right away (no
request to accept); after that the link is dead. You get a private chat with a call button, a
shared calendar and a task list. You can also add anyone you share a group with: right-click
their name.

Tips:
- Closing the window keeps the app running in the tray, so friends can sync messages from you.
  Quit from the tray icon. (Settings → Network to turn this off.)
- `Ctrl+Shift+F9` mute / `Ctrl+Shift+F10` deafen work globally while you're in a call.
- **Right-click a person** (member list, call tile, voice channel) for their volume, *Mute for
  me*, and, if you're the group's owner or an admin: *Mute for everyone*, *Move to* another voice
  channel, *Disconnect* and *Kick*. The owner can make people admins there.
- Screen shares are **opt-in**: you see "Alice is streaming" and click **Watch stream**. Your PC
  only receives (and Alice's only sends) the video while you watch. Hover the stream for
  **Stop watching**, fullscreen, and the stream's own volume/mute (separate from Alice's voice).
  Whoever shares sees who is watching, on the tile and under *Voice connected*.
- Scroll on a stream to **zoom** in (up to 8×) and drag to pan. Double-click (or ⤢) for fullscreen.
- Hover a message → **Reply in thread**. Thread replies stay out of the channel (tick
  *Also send to #channel* to post one in both). You get notified about threads you started or
  replied in, and when someone @mentions you.
- **Calendar** and **Tasks** are at the top of every group's channel list (and in the header of a
  private chat). Events have a time, place, details, RSVPs and a desktop reminder; tasks move
  between *To do / Doing / Done* by drag and drop and have an assignee, a due date and a checklist.
  Everyone in the group sees and can edit them, also offline, like messages.
- Type `:` and a name (`:fire`) for emoji. Hover a message to **pin** it; pins are in the 📌 menu.
- **Search** with `Ctrl+F` (or `/search`). Narrow it down with `from:bob`, `in:#general`,
  `has:image|video|file|link|poll|game`, `before:2026-05-01` and `after:`.
- Click someone's **name or picture** in the chat for their profile card: status, role, which call
  they're in and which groups you share.
- Click your name (bottom left) to set your **status**: *Online*, *Away* or *Appear offline*.
  You go *Away* by yourself after 10 minutes without touching the PC (Settings → My profile).
- `/poll` (or the poll button in the chat header) makes a **poll**. Results show once you've voted.
- `/poker` (or the game button in the chat header) opens a **poker table**: friends click *Take a seat*, the host
  clicks *Start dealing*. Buy-in, blinds and the turn timer are set when opening the table.
- In a voice channel, the ♪ button opens the **soundboard**. Anyone can add short sounds (up to
  7 seconds, 1 MB); everyone in the channel hears them. Settings → Voice & audio sets the volume
  of sounds and of the little join/leave tones.
- Settings → **Account** → **Back up my account** saves a password-locked file with your identity,
  friends, groups and history. On a new PC, choose *Restore from a backup* on the first screen.
- Settings → Voice & audio → **Noise suppression**: *AI (RNNoise)* (default) removes fans, keyboard
  clicks and hum. Use *Hear yourself* next to the mic meter to check it.
- Settings → **Storage** shows what takes up space, removes files friends sent (they can be
  downloaded again), and moves your data (identity, history, files) to another folder or drive.
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
- **One-time invite links** contain a random token, never the group key. The member who makes one
  publishes `invite.create` (the token's hash-derived id, a rendezvous topic and a check key) in
  the group's log, so every member can let the guest in. The guest connects to whoever is online
  on that topic and proves it holds the token (an HMAC bound to the connection). A member who sees
  the invite unused appends a signed `invite.used` op (which syncs, so a second redeem fails
  everywhere) and sends the group key sealed to the guest's identity key. Friend links work the
  same way, app to app.
- **Storage:** each group's log is kept as Brotli-compressed segments plus a small plain-text tail
  (about 4× smaller than raw JSON). Deleting a message, editing it again, or changing your picture
  marks the older ops as superseded; two days later they're replaced by small signed "stubs" that
  keep the log's numbering intact, so the deleted text and old pictures are really gone from every
  disk. Files from friends can be cleaned up and re-downloaded on demand.
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
- **Nobody listens in, even with a modified app.** Your microphone only opens when you join a
  voice channel. While you're muted, deafened or muted by a moderator, your app takes the mic
  track off every connection, so no audio packet leaves your PC at all (it doesn't just send
  silence). Your app only connects to people the network let into the group and who announced
  that they're in *your* channel, so everyone who can hear you is listed under it; an offer from
  anyone else is ignored. Your screen only goes to people in the call who appear in your viewer
  list. A friend's app can't change any of this, because the decisions are made by yours.
- **Folders** are ops like everything else (`folder.create`, `folder.set`, `channel.move`). Each
  field keeps its newest value, and if two people move folders into each other at the same time,
  every app breaks the loop the same way, so everyone sees the same tree. Folding is per device.
- **Chess** games live in the group's log: the challenge is a message, every move a signed op.
  Every app replays the moves with full rules (castling, en passant, promotion, check, mate,
  stalemate, repetition, 50 moves, insufficient material), so an illegal move, or a move by
  someone not playing, is simply ignored. If both players' apps sent a move for the same turn, the
  one signed first counts. With a clock, each app measures its own player's thinking time, so the
  clocks work even when your PCs' times differ.
- **@claude** runs on the asker's PC: their app sends that chat's recent messages and any pictures
  or text files in their message to Anthropic with **their own API key**, shows the answer to
  everyone online while it's being written, and posts it as a signed message marked as Claude's.
  **Claude only reads the asker's own messages and its answers to them**, plus messages from
  people who switched on *Claude may read my messages* (Settings → Privacy, off by default).
  Everyone else's messages are left out; Claude is told some were skipped. The one exception is a
  message the asker replies to, which Claude sees because the asker pointed at it. Replying to one
  of Claude's answers asks again, no `@claude` needed. The key never leaves that PC (it's stored
  encrypted with Windows DPAPI, the macOS keychain or your Linux keyring) and is never sent to
  friends. Friends without a key can't make your app ask, and admins can turn `@claude` off per group.
- **Poker** is dealt by "mental poker", so nobody (not even the host) has to be trusted with the
  deck. Each player's app shuffles the deck in turn and locks every card with its own secret key
  (commutative encryption on Ed25519), so a card can only be read when *every* player has
  published their key for it. Your apps hand out the keys for the board as it's dealt and give you
  the keys for your own two cards only. Every bet is a signed op, every app replays the hand with
  the same rules, and a wrong key or a stalled player cancels the hand and returns the bets
  instead of dealing nonsense. Timeouts are checked against the signed times of the ops, so a
  friend's app can't fold you early.
- **Polls, statuses and the soundboard:** a vote is a signed op (your newest vote before the poll
  ends counts). Your status is sent only to friends who are online and isn't stored anywhere.
  Soundboard clips are shared files like any other; pressing one tells the others in your channel
  which clip to play, and each app plays it locally.
- **Your account on disk and in backups:** your secret identity key is stored encrypted with
  Windows DPAPI (or the macOS keychain / Linux keyring), so a copy of the data folder alone isn't
  enough to pretend to be you. A backup is encrypted with your password (scrypt + AES-256-GCM).
  After a restore, your groups stay read-only until a friend has sent you everything you'd
  written since the backup, so your app never reuses a message number your friends already have.
- **Versions:** apps tell each other which protocol versions they understand. If a friend's app
  is too old to sync with yours, nothing half-syncs: the newer app shows who needs to update, and
  the older one shows a full-screen *Time to update* with an install button.

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
- **Anthropic**, only when someone asks Claude: the asker's app sends their own recent messages in
  that chat, Claude's answers to them, and messages from people who allowed it, to Anthropic's
  API. An admin can turn `@claude` off for a whole group (Claude settings in the group menu).

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
- **Calls when the direct route fails:** if you can chat but a call can't find a direct path (some
  firewalls block WebRTC's UDP but not the chat connection), the call automatically runs through
  your existing encrypted chat connection instead. It's still only between your two PCs; the call
  tile then says *via chat link*.
- After fixing your network, click **Retry now**. The app also looks for friends again every minute
  while nobody is connected.

## Limitations (it's a side project)

- History lives only on members' devices. If nobody who has a message is online, a newcomer has
  to wait. Your secret key is encrypted on disk, but the **history isn't**, so use
  BitLocker/FileVault.
- A member hands out the group key when letting someone in, so a group is only as private as its
  least careful member. Kicking someone cuts them off and changes the key, but they keep the
  messages and files they already had. Nothing can take back data from a PC.
- If two people open the *same* invite link at the same moment and reach two *different* members,
  both may get in (each member only sees the other's `invite.used` a moment later). With one link
  per friend this doesn't come up. Old `OD1-…` codes from before 0.4 still work until the next
  kick changes the key, because they are the key.
- If the owner loses their account without a backup, nobody can promote new admins (existing
  admins keep their powers). Make a backup (Settings → Account).
- No push-to-talk (toggle hotkeys instead), custom emoji or mobile app. Reminders only fire
  while the app is running (it keeps running in the tray by default). Search only finds what's
  on your PC.
- Claude only answers in text chats, not in voice channels, and only while the asker's app is
  running. Each answer costs the asker a little on their Anthropic bill (Settings → Claude shows
  this month's total).
- A chess clock trusts each player's own app to report its time honestly, as there's no referee.
  It's for friends, not for prize money. The same goes for poker: the cards are dealt fairly, but
  a player whose app quits mid-hand just has that hand cancelled.
- A mesh is perfect for 3–5 people. Roughly: about 10 people can talk in one channel, 4–6 with
  cameras on, and a 1080p60 screen share reaches 3–4 viewers before the sharer's upload runs out.
  For more you'd want an SFU (a server).
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
runs the tests, builds the installer and portable exe, runs the two-app end-to-end test against
that build, and only then publishes a GitHub release `vX.Y.Z` (screenshots of a failed run are
kept as a workflow artifact).
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
npm test                  # headless tests: sync, gossip, auth, forged messages, files, kick, friends, one-time links, stubs, backups, versions, chess, poker, polls, search, Claude's privacy
npm run test:e2e          # drives two real app instances through every feature (chat, threads, planner, chess, poker, polls, search, @claude against a local stand-in, calls, soundboard, backup and restore…)
npm run dist              # Windows installer + portable .exe into dist/
npm run test:update       # after dist: update flow against a local feed (never installs anything)
```

`OD_EXE=dist/win-unpacked/OpenDiscord.exe npm run test:e2e` runs the same e2e against the
packaged build. `REAL_CAPTURE=1` uses your real screen instead of Chromium's test pattern.
Screenshots go to `test/screenshots/` (gitignored, because they can contain your screen).

```
src/main/          Electron main process
  crypto.js        one-time links, membership HMAC, op signatures, sealed boxes, DM keys
  store.js         identity (sealed on disk), backups, settings, friends, roles/kicks, invites, compressed op log + stubs, blob store
  poker.js         the card crypto for mental poker (shuffle, lock, per-card keys)
  network.js       Hyperswarm connections, auth, sync/gossip, invite redemption, friend requests, file transfer
  linkpreview.js   builds link previews (OpenGraph, YouTube oEmbed) for links you send
  datadir.js       choosing and moving the data folder
  updater.js       self-update from GitHub releases
  framing.js       length-prefixed JSON/binary frames
  main.js          window, IPC, custom protocols, opendiscord:// links, screen-capture picker
src/preload/       the narrow API the UI is allowed to call
src/renderer/      UI (Preact + htm, no build step)
  lib/model.js     derives channels/messages/threads/reactions/pins/roles/events/tasks from ops
  lib/voice.js     WebRTC mesh, codecs, bitrates, speaking detection, moderation, stats, fallback path
  lib/poker.js     hand evaluator and the poker rules every app replays; lib/pokerplay.js deals
  lib/claudelog.js what Claude may read; lib/search.js search filters
  lib/presence.js  status and auto-away; lib/sounds.js join/leave tones and soundboard playback
  lib/denoise.js   RNNoise noise suppression (AudioWorklet: lib/rnnoise-worklet.js)
  lib/markdown.js  chat markdown and full markdown documents
  lib/highlight.js syntax highlighting for code blocks and code files
  views/           chat + threads, call stage, calendar/tasks, friends, members, emoji picker, modals
```

Third-party pieces shipped with the app: [RNNoise](https://github.com/xiph/rnnoise) via
[`@shiguredo/rnnoise-wasm`](https://github.com/shiguredo/rnnoise-wasm) (Apache-2.0; RNNoise itself
BSD-3-Clause) and emoji data from [`unicode-emoji-json`](https://github.com/muan/unicode-emoji-json) (MIT).
