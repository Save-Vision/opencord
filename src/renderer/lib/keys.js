// Keyboard shortcuts: Ctrl on Windows and Linux, ⌘ on a Mac (where Ctrl+click is a right-click
// and Ctrl+arrows switch desktops). app.js calls setMac() once it knows the platform.
let mac = false

export const setMac = (v) => { mac = !!v }
export const isMac = () => mac

// The shortcut key is held: Ctrl, or ⌘ on a Mac
export const mod = (e) => mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey

// A shortcut written for Windows ('Ctrl+Shift+F') as people read it here ('⌘⇧F' on a Mac)
export const keyLabel = (s) => !s || !mac ? s : s.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥')
