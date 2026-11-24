// Online / away / appear offline. Your app tells everyone it's connected to (an ephemeral
// 'status' message, never stored) whenever it changes, and each friend who connects. "Away"
// comes on by itself after a while without keyboard or mouse input anywhere on the PC.
//
// "Appear offline" hides you in lists, but your app still connects to friends so messages
// keep syncing (that's how P2P works without a server).

import { api, model, saveSettings } from './core.js'

let last = null

export function announceStatus (gid = null, to = null) {
  const s = model.myStatus()
  if (gid) { api.sendEph(gid, to, { type: 'status', s }); return }
  last = s
  for (const g of model.groups.values()) api.sendEph(g.id, null, { type: 'status', s })
}

export async function setMyStatus (s) {
  await saveSettings({ status: s })
  announceStatus()
  model.emit()
}

// Checks idle time every 20 s; announces when "away" starts or ends
export function startPresence () {
  const tick = async () => {
    let idle = false
    const minutes = Number(model.settings.autoAway) || 0
    if (minutes > 0) {
      try { idle = (await api.idleSeconds()) >= minutes * 60 } catch {}
    }
    if (idle !== model.idle) { model.idle = idle; model.emit() }
    if (model.myStatus() !== last) announceStatus()
  }
  tick()
  setInterval(tick, 20000)
}

export const STATUS_LABEL = { online: 'Online', away: 'Away', invisible: 'Appear offline', offline: 'Offline' }
