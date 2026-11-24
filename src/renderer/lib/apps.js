// Group apps. A group starts without any; the owner or an admin adds them (group menu → Apps),
// which is a group.settings op like the invite and Claude settings. Removing an app only hides
// it: its events, tasks, games and documents stay in the group and come back when it's added
// again. Private chats always have all of them.
export const APPS = [
  { id: 'calendar', icon: 'calendar', name: 'Calendar', desc: 'Plan events together, with RSVPs and reminders.' },
  { id: 'tasks', icon: 'tasks', name: 'Tasks', desc: 'A shared task board with assignees, due dates and checklists.' },
  { id: 'games', icon: 'chess', name: 'Games', desc: 'Chess (also against the computer) and poker, played in your channels.' },
  { id: 'docs', icon: 'focus', name: 'Focus docs', desc: 'Documents you write together, live, with a distraction-free editor.' }
]

export const APP_IDS = APPS.map(a => a.id)

// The apps listed in a group.settings op, cleaned up (unknown ones dropped, in a fixed order)
export const cleanApps = (list) => Array.isArray(list) ? APP_IDS.filter(id => list.includes(id)) : null
