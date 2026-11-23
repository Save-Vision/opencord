'use strict'
// The only bridge between the sandboxed UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const EVENTS = new Set(['ops', 'peer-join', 'peer-leave', 'peer-update', 'eph', 'blob-progress', 'focus-change', 'hotkey', 'update', 'membership', 'friends',
  'group-added', 'group-removed', 'joins', 'notice', 'open-link'])
const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args)

contextBridge.exposeInMainWorld('od', {
  init: () => invoke('init'),
  setProfile: (p) => invoke('profile:set', p),
  setSettings: (patch) => invoke('settings:set', patch),

  createGroup: (name) => invoke('group:create', name),
  joinGroup: (invite) => invoke('group:join', invite),
  leaveGroup: (id) => invoke('group:leave', id),
  createInvite: (gid, ttl) => invoke('invite:create', gid, ttl),
  revokeInvite: (gid, id) => invoke('invite:revoke', gid, id),
  cancelJoin: (id) => invoke('join:cancel', id),

  kick: (gid, key) => invoke('member:kick', gid, key),
  setRole: (gid, key, role) => invoke('member:role', gid, key, role),

  friends: () => invoke('friends:info'),
  addFriend: (code, name) => invoke('friend:add', code, name),
  acceptFriend: (key) => invoke('friend:accept', key),
  declineFriend: (key) => invoke('friend:decline', key),
  removeFriend: (key) => invoke('friend:remove', key),
  createFriendLink: (ttl) => invoke('friend:link', ttl),
  revokeFriendLink: (id) => invoke('friend:link-revoke', id),

  storageInfo: () => invoke('storage:info'),
  pickStorage: () => invoke('storage:pick'),
  checkStorage: (picked) => invoke('storage:check', picked),
  moveStorage: (dir, existing) => invoke('storage:move', dir, existing),
  openStorage: () => invoke('storage:open'),
  cleanStorage: (days) => invoke('storage:clean', days),

  linkPreview: (url) => invoke('link:preview', url),

  append: (gid, kind, data) => invoke('op:append', gid, kind, data),
  sendEph: (gid, to, data) => ipcRenderer.send('eph', gid, to, data),

  pickFiles: () => invoke('dialog:pick-files'),
  importPaths: (paths) => invoke('blob:import-paths', paths),
  importData: (name, mime, bytes) => invoke('blob:import-data', name, mime, bytes),
  hasBlob: (h) => invoke('blob:has', h),
  fetchBlob: (h, gid) => invoke('blob:fetch', h, gid),
  saveBlob: (h, name) => invoke('blob:save', h, name),
  pathForFile: (file) => webUtils.getPathForFile(file),

  screenSources: () => invoke('screen:sources'),
  selectScreen: (id, audio) => invoke('screen:select', id, audio),

  netStatus: () => invoke('net:status'),
  netRetry: () => invoke('net:retry'),

  updateState: () => invoke('update:state'),
  checkForUpdate: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),

  openExternal: (url) => invoke('shell:open', url),
  copy: (text) => invoke('clipboard:write', text),
  attention: () => ipcRenderer.send('attention'),
  showWindow: () => ipcRenderer.send('show-window'),
  setUnread: (n) => ipcRenderer.send('unread', n),
  voiceHotkeys: (on) => ipcRenderer.send('voice-hotkeys', on),

  on: (event, cb) => {
    if (!EVENTS.has(event)) throw new Error('Unknown event ' + event)
    const fn = (_e, ...args) => cb(...args)
    ipcRenderer.on(event, fn)
    return () => ipcRenderer.removeListener(event, fn)
  }
})
