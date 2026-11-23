// Live connectivity diagnostics: is the P2P network reachable, is a VPN in the way, what kind
// of NAT are we behind, and why did connecting to a friend fail?
import { html, useState, useEffect } from '../vendor/preact-htm.js'
import { api, model, act } from '../lib/core.js'
import { Icon } from '../lib/icons.js'

const HOLEPUNCH = 'Hole punching through the routers failed — usually a VPN, a strict firewall, or carrier-grade NAT on one side.'
const UNREACHABLE = 'Your friend was found on the network but could not be reached. A firewall may be dropping UDP traffic, or they just went offline.'
const FAILURES = {
  HOLEPUNCH_DOUBLE_RANDOMIZED_NATS: 'Both of you are behind "randomized" NATs (VPN, mobile hotspot or carrier-grade NAT). These can never connect directly without a relay — at least one of you has to fix their side.',
  HOLEPUNCH_ABORTED: HOLEPUNCH,
  HOLEPUNCH_PROBE_TIMEOUT: HOLEPUNCH,
  CANNOT_HOLEPUNCH: HOLEPUNCH,
  REMOTE_NOT_HOLEPUNCHABLE: HOLEPUNCH,
  REMOTE_NOT_HOLEPUNCHING: HOLEPUNCH,
  REMOTE_ABORTED: HOLEPUNCH,
  PEER_NOT_FOUND: UNREACHABLE,
  PEER_CONNECTION_FAILED: UNREACHABLE,
  HANDSHAKE_UNFINISHED: UNREACHABLE,
  REQUEST_TIMEOUT: UNREACHABLE,
  ETIMEDOUT: UNREACHABLE
}

export function useNetStatus (intervalMs = 3000) {
  const [st, setSt] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => api.netStatus().then((s) => { if (alive) setSt(s) }).catch(() => {})
    load()
    const iv = setInterval(load, intervalMs)
    return () => { alive = false; clearInterval(iv) }
  }, [])
  return st
}

export function networkIssues (st) {
  if (!st) return []
  const out = []
  if (!st.dht.online) {
    out.push({ level: 'bad', title: 'Not connected to the P2P network yet', body: "If this doesn't change within a minute, UDP traffic is being blocked — check your firewall or antivirus, or try another network." })
  } else {
    out.push({ level: 'ok', title: 'Connected to the P2P network' })
  }
  if (st.route?.vpn) {
    out.push({
      level: 'bad',
      title: `A VPN is routing your traffic (${st.route.iface})`,
      body: "Your connection leaves through the VPN server, which blocks the direct connections this app relies on — and calls would detour through that server anyway. Turn the VPN off while using OpenDiscord, or exclude OpenDiscord in your VPN app's split-tunneling settings."
    })
  }
  if (st.dht.natKnown && st.dht.randomized && !st.route?.vpn) {
    out.push({ level: 'warn', title: 'Your network uses a "randomized" NAT', body: 'Typical for mobile hotspots and carrier-grade NAT. You can still reach friends on normal home internet, but not friends who have the same kind of NAT.' })
  } else if (st.dht.natKnown && !st.dht.randomized) {
    out.push({ level: 'ok', title: 'Your network is P2P-friendly' })
  }
  return out
}

export function hasProblem (st) {
  return networkIssues(st).some(i => i.level === 'bad')
}

function diagnosticsText (st) {
  const lines = [
    `OpenDiscord ${st.version} (${st.platform})`,
    `P2P network: ${st.dht.online ? 'online' : 'OFFLINE'}`,
    `NAT: ${!st.dht.natKnown ? 'unknown yet' : st.dht.randomized ? 'randomized (hard)' : 'consistent (good)'}, firewalled: ${st.dht.firewalled ? 'yes' : 'no'}`,
    `VPN: ${st.route ? (st.route.vpn ? 'YES (' + st.route.iface + ')' : 'no') : 'unknown'}`
  ]
  for (const [gid, gs] of Object.entries(st.groups || {})) {
    const g = model.groups.get(gid)
    lines.push(`Group "${g ? model.groupName(g) : gid.slice(0, 6)}": found ${gs.found}, connected ${gs.connected}`)
    for (const f of gs.failures) lines.push(`  peer ${f.peer}…: ${f.code} ×${f.count}`)
  }
  return lines.join('\n')
}

export function NetworkHealth ({ gid = null }) {
  const st = useNetStatus()
  const [retrying, setRetrying] = useState(false)
  if (!st) return html`<div class="net-health"><p class="muted">Checking your network…</p></div>`
  const issues = networkIssues(st)
  const groups = gid ? [[gid, st.groups[gid]]] : Object.entries(st.groups)
  const retry = async () => {
    setRetrying(true)
    await act(() => api.netRetry())
    setTimeout(() => setRetrying(false), 1500)
    model.toast('Looking for your friends again…')
  }
  return html`
    <div class="net-health">
      ${issues.map(i => html`
        <div class="net-item ${i.level}">
          <${Icon} name=${i.level === 'ok' ? 'check' : 'signal'} size=${16} />
          <div><b>${i.title}</b>${i.body && html`<small>${i.body}</small>`}</div>
        </div>`)}
      ${groups.filter(([, gs]) => gs).map(([id, gs]) => {
        const g = model.groups.get(id)
        return html`
          <div class="net-item ${gs.connected ? 'ok' : gs.failures.length ? 'bad' : 'warn'}" key=${id}>
            <${Icon} name="users" size=${16} />
            <div>
              <b>${gid ? 'Friends in this group' : (g ? model.groupName(g) : 'Group')}: ${gs.connected} connected${gs.found > gs.connected ? `, ${gs.found - gs.connected} found but unreachable` : ''}</b>
              ${!gs.found && html`<small>Nobody from this group is reachable on the network right now. Make sure a friend has OpenDiscord open — finding each other can take up to a minute.</small>`}
              ${gs.failures.map(f => html`<small key=${f.peer}>Friend ${f.peer}…: ${FAILURES[f.code] || f.message} <code class="inline">${f.code}</code></small>`)}
            </div>
          </div>`
      })}
      <div class="row">
        <button class="btn" disabled=${retrying} onClick=${retry}>${retrying ? 'Retrying…' : 'Retry now'}</button>
        <button class="btn" onClick=${async () => { await api.copy(diagnosticsText(st)); model.toast('Diagnostics copied — paste them to your friend') }}><${Icon} name="copy" size=${16} /> Copy diagnostics</button>
      </div>
    </div>`
}
