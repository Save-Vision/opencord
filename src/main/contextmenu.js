'use strict'
// The right-click menu for text: cut / copy / paste in text boxes, copy for selected text,
// spelling suggestions, and copy for links and pictures. Places with their own menu (people,
// soundboard buttons) call preventDefault in the page, so Electron never asks for this one there.

// params: Electron's context-menu params. act: { replace(word), learn(word), openLink(url),
// copyText(text), copyImage(x, y) }. Returns a Menu template ([] = show nothing).
function contextMenuItems (p, act) {
  const items = []
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }) }
  const flags = p.editFlags || {}

  if (p.isEditable && p.misspelledWord) {
    const words = (p.dictionarySuggestions || []).slice(0, 5)
    for (const w of words) items.push({ label: w, click: () => act.replace(w) })
    if (!words.length) items.push({ label: 'No spelling suggestions', enabled: false })
    items.push({ label: 'Add to dictionary', click: () => act.learn(p.misspelledWord) })
    sep()
  }
  if (p.linkURL && /^https?:\/\//i.test(p.linkURL)) {
    items.push({ label: 'Open link', click: () => act.openLink(p.linkURL) })
    items.push({ label: 'Copy link', click: () => act.copyText(p.linkURL) })
    sep()
  }
  if (p.mediaType === 'image' && p.hasImageContents !== false && p.srcURL) {
    items.push({ label: 'Copy image', click: () => act.copyImage(p.x, p.y) })
    sep()
  }
  if (p.isEditable) {
    items.push(
      { role: 'undo', label: 'Undo', enabled: !!flags.canUndo },
      { role: 'redo', label: 'Redo', enabled: !!flags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: 'Cut', enabled: !!flags.canCut },
      { role: 'copy', label: 'Copy', enabled: !!flags.canCopy },
      { role: 'paste', label: 'Paste', enabled: !!flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: 'Select all', enabled: !!flags.canSelectAll }
    )
  } else if ((p.selectionText || '').trim()) {
    items.push({ role: 'copy', label: 'Copy' })
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop()
  return items
}

// Shows it for one window's page
function attachContextMenu (win, { Menu, shell, clipboard }) {
  const wc = win.webContents
  wc.on('context-menu', (e, params) => {
    const items = contextMenuItems(params, {
      replace: (w) => wc.replaceMisspelling(w),
      learn: (w) => wc.session.addWordToSpellCheckerDictionary(w),
      openLink: (url) => shell.openExternal(url),
      copyText: (text) => clipboard.writeText(text),
      copyImage: (x, y) => wc.copyImageAt(x, y)
    })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
  })
}

module.exports = { contextMenuItems, attachContextMenu }
