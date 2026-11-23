// Calendar and task board, shared by everyone in a group (or both people in a private chat).
// Events and tasks are ops like messages (event.set / task.set, edited field by field), so
// they sync peer-to-peer and work offline. See lib/model.js "planner".
import { html, useState, useEffect, useRef } from '../vendor/preact-htm.js'
import { model, append, act, rid, fmtTime } from '../lib/core.js'
import { dayKey, parseDay, eventStart, eventEnd, eventDay, RSVP, DM_TEXT } from '../lib/model.js'
import { Icon } from '../lib/icons.js'
import { Avatar } from './chat.js'
import { Modal } from './modals.js'

const COLUMNS = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' }
]
const RSVP_LABEL = { yes: 'Going', maybe: 'Maybe', no: "Can't go" }
const REMINDERS = [
  [null, 'No reminder'], [0, 'When it starts'], [5, '5 minutes before'], [15, '15 minutes before'],
  [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']
]
const DURATIONS = [[30, '30 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'], [480, '8 hours']]

const todayKey = () => dayKey(new Date())
const fmtDayShort = (key) => parseDay(key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

export function eventWhen (e) {
  if (e.allDay) return fmtDayShort(e.day) + ' · all day'
  return fmtDayShort(eventDay(e)) + ' · ' + fmtTime(e.start) + '–' + fmtTime(eventEnd(e))
}

function going (e) {
  const out = { yes: [], maybe: [], no: [] }
  for (const [k, r] of e.rsvp) if (r.v && out[r.v]) out[r.v].push(k)
  return out
}

const rsvp = (g, e, v) => {
  const mine = e.rsvp.get(model.me.key)?.v
  return act(() => append(g.id, 'event.rsvp', { id: e.id, going: mine === v ? null : v }))
}

export const myOpenTasks = (g) => model.tasksOf(g).filter(t => t.status !== 'done' && t.assignee === model.me.key).length
export const eventsToday = (g) => model.eventsOf(g).filter(e => eventDay(e) === todayKey()).length

export function PlannerView ({ g }) {
  const tab = model.ui.planner.tab
  const go = (t) => { model.ui.planner = { gid: g.id, tab: t }; model.emit() }
  return html`
    <section class="planner">
      <header class="chat-header">
        ${g.dm && html`<button class="icon-btn" title="Back to the chat" onClick=${() => model.selectChannel(g.id, DM_TEXT)}><${Icon} name="chevronLeft" /></button>`}
        <${Icon} name=${tab === 'calendar' ? 'calendar' : 'tasks'} size=${22} class="dim" />
        <h2>${tab === 'calendar' ? 'Calendar' : 'Tasks'}</h2>
        <span class="header-note"><${Icon} name="lock" size=${13} /> Shared with ${g.dm ? model.groupName(g) : 'everyone in ' + model.groupName(g)}</span>
        <div class="spacer" />
        <div class="seg-tabs">
          <button class=${tab === 'calendar' ? 'active' : ''} onClick=${() => go('calendar')}><${Icon} name="calendar" size=${16} /> Calendar</button>
          <button class=${tab === 'tasks' ? 'active' : ''} onClick=${() => go('tasks')}><${Icon} name="tasks" size=${16} /> Tasks</button>
        </div>
      </header>
      ${tab === 'calendar' ? html`<${Calendar} g=${g} />` : html`<${TaskBoard} g=${g} />`}
    </section>`
}

// ---------------------------------------------------------------- calendar

function Calendar ({ g }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const events = model.eventsOf(g).sort((a, b) => eventStart(a) - eventStart(b))
  const byDay = new Map()
  for (const e of events) {
    const k = eventDay(e)
    if (!byDay.has(k)) byDay.set(k, [])
    byDay.get(k).push(e)
  }
  const today = todayKey()
  const offset = (cursor.getDay() + 6) % 7 // weeks start on Monday
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - offset)
  const cells = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i))
  const weekdays = cells.slice(0, 7).map(d => d.toLocaleDateString([], { weekday: 'short' }))
  const now = Date.now()
  const upcoming = events.filter(e => eventEnd(e) >= now).slice(0, 15)
  const shift = (n) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1))
  const create = (day) => model.openModal('event', { gid: g.id, day })
  const open = (e) => model.openModal('event', { gid: g.id, id: e.id })

  return html`
    <div class="calendar">
      <div class="cal-main">
        <div class="cal-bar">
          <button class="icon-btn" title="Previous month" onClick=${() => shift(-1)}><${Icon} name="chevronLeft" /></button>
          <h3>${cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h3>
          <button class="icon-btn" title="Next month" onClick=${() => shift(1)}><${Icon} name="chevronRight" /></button>
          <button class="btn sm" onClick=${() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)) }}>Today</button>
          <div class="spacer" />
          <button class="btn primary sm" onClick=${() => create(today)}><${Icon} name="plus" size=${15} /> New event</button>
        </div>
        <div class="cal-grid">
          ${weekdays.map(w => html`<div class="cal-head" key=${'h' + w}>${w}</div>`)}
          ${cells.map((d) => {
            const k = dayKey(d)
            const evs = byDay.get(k) || []
            return html`
              <div key=${k} class="cal-cell ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${k === today ? 'today' : ''}" onDblClick=${() => create(k)}>
                <div class="cal-date"><span>${d.getDate()}</span><button class="cal-add" title="Add an event" onClick=${() => create(k)}><${Icon} name="plus" size=${13} /></button></div>
                ${evs.slice(0, 3).map(e => html`
                  <button key=${e.id} class="cal-chip ${e.allDay ? 'allday' : ''} ${eventEnd(e) < now ? 'past' : ''}" title=${e.title + ' — ' + eventWhen(e)} onClick=${() => open(e)}>
                    ${!e.allDay && html`<b>${fmtTime(e.start)}</b>`}<span>${e.title}</span>
                  </button>`)}
                ${evs.length > 3 && html`<button class="cal-more" onClick=${() => open(evs[3])}>+${evs.length - 3} more</button>`}
              </div>`
          })}
        </div>
      </div>
      <aside class="cal-upcoming">
        <h4>Upcoming</h4>
        ${!upcoming.length && html`<div class="empty-note"><${Icon} name="calendar" size=${26} /><p>Nothing planned yet. Double-click a day to add an event.</p></div>`}
        ${upcoming.map(e => html`<${UpcomingItem} key=${e.id} g=${g} e=${e} />`)}
      </aside>
    </div>`
}

function UpcomingItem ({ g, e }) {
  const d = parseDay(eventDay(e))
  const who = going(e)
  const mine = e.rsvp.get(model.me.key)?.v
  const live = !e.allDay && Date.now() >= e.start && Date.now() < eventEnd(e)
  return html`
    <div class="up-item ${live ? 'live' : ''}">
      <button class="up-date" onClick=${() => model.openModal('event', { gid: g.id, id: e.id })}>
        <small>${d.toLocaleDateString([], { month: 'short' })}</small><b>${d.getDate()}</b>
      </button>
      <div class="up-body">
        <button class="up-title" onClick=${() => model.openModal('event', { gid: g.id, id: e.id })}>${e.title}</button>
        <small>${live ? 'Happening now · ' : ''}${e.allDay ? 'All day' : fmtTime(e.start) + '–' + fmtTime(eventEnd(e))}${e.loc ? ' · ' + e.loc : ''}</small>
        <div class="up-rsvp">
          ${who.yes.length > 0 && html`<span class="avatar-stack" title=${'Going: ' + who.yes.map(k => model.memberName(g, k)).join(', ')}>${who.yes.slice(0, 4).map(k => html`<${Avatar} key=${k} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${18} />`)}</span>`}
          ${RSVP.map(v => html`<button key=${v} class="chip-btn ${mine === v ? 'on ' + v : ''}" onClick=${() => rsvp(g, e, v)}>${RSVP_LABEL[v]}</button>`)}
        </div>
      </div>
    </div>`
}

const pad = (n) => String(n).padStart(2, '0')
const timeOf = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }

export function EventModal ({ gid, id = null, day = null }) {
  const g = model.groups.get(gid)
  const e = id ? g?.events.get(id) : null
  const [f, setF] = useState(() => e
    ? { title: e.title, desc: e.desc, loc: e.loc, allDay: e.allDay, day: eventDay(e), time: e.allDay ? '19:00' : timeOf(e.start), dur: e.dur || 60, remind: e.remind }
    : { title: '', desc: '', loc: '', allDay: false, day: day || todayKey(), time: '19:00', dur: 120, remind: 15 })
  if (!g) return null
  const set = (k) => (ev) => setF({ ...f, [k]: ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value })
  const save = async () => {
    const [hh, mm] = f.time.split(':').map(Number)
    const d = parseDay(f.day)
    const data = {
      title: f.title.trim(), desc: f.desc, loc: f.loc.trim(), allDay: !!f.allDay, day: f.day,
      start: f.allDay ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh || 0, mm || 0).getTime(),
      dur: Number(f.dur) || 60,
      remind: f.remind === '' || f.remind == null ? null : Number(f.remind)
    }
    // only send what changed: edits by friends to other fields still win
    const changed = e ? Object.fromEntries(Object.entries(data).filter(([k, v]) => e[k] !== v)) : data
    const eid = e ? e.id : rid()
    if (Object.keys(changed).length) await act(() => append(gid, 'event.set', { id: eid, ...changed }))
    if (!e) await act(() => append(gid, 'event.rsvp', { id: eid, going: 'yes' })) // you're going to what you plan
    model.closeModal()
  }
  const del = () => model.openModal('confirm', {
    title: 'Delete event', body: `Delete “${e.title}” for everyone?`, confirm: 'Delete', danger: true,
    onConfirm: () => act(() => append(gid, 'event.delete', { id: e.id }))
  })
  const who = e ? going(e) : null
  const mine = e?.rsvp.get(model.me.key)?.v
  const by = e?.createdBy ? model.memberName(g, e.createdBy) : null
  return html`
    <${Modal} title=${e ? 'Event' : 'New event'}>
      <div class="modal-body planner-form">
        <label>Title<input value=${f.title} maxLength="200" autoFocus placeholder="Game night" onInput=${set('title')} onKeyDown=${(ev) => ev.key === 'Enter' && f.title.trim() && save()} /></label>
        <div class="row">
          <label class="grow">Date<input type="date" value=${f.day} onInput=${set('day')} /></label>
          ${!f.allDay && html`<label>Starts<input type="time" value=${f.time} onInput=${set('time')} /></label>`}
          ${!f.allDay && html`<label>Length<select value=${f.dur} onChange=${set('dur')}>${DURATIONS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>`}
        </div>
        <label class="check"><input type="checkbox" checked=${f.allDay} onChange=${set('allDay')} /> All day</label>
        <label>Where<input value=${f.loc} maxLength="200" placeholder="Optional: a voice channel, an address…" onInput=${set('loc')} /></label>
        <label>Details<textarea rows="3" value=${f.desc} maxLength="4000" placeholder="Optional" onInput=${set('desc')} /></label>
        <label>Reminder<select value=${f.remind ?? ''} onChange=${set('remind')}>${REMINDERS.map(([v, l]) => html`<option value=${v ?? ''}>${l}</option>`)}</select></label>
        <p class="hint">Everyone gets a desktop reminder, except people who said they can't go.</p>
        ${e && html`
          <div class="rsvp-block">
            <div class="rsvp-mine">${RSVP.map(v => html`<button key=${v} class="chip-btn ${mine === v ? 'on ' + v : ''}" onClick=${() => rsvp(g, e, v)}>${RSVP_LABEL[v]}</button>`)}</div>
            ${RSVP.map(v => who[v].length > 0 && html`
              <div class="rsvp-row" key=${v}><small>${RSVP_LABEL[v]}</small>
                ${who[v].map(k => html`<span class="rsvp-person" key=${k}><${Avatar} name=${model.memberName(g, k)} color=${model.memberColor(g, k)} src=${model.memberAvatar(g, k)} size=${20} />${model.memberName(g, k)}</span>`)}
              </div>`)}
          </div>
          ${by && html`<p class="hint">Added by ${by}</p>`}`}
      </div>
      <footer>
        ${e && html`<button class="btn danger" onClick=${del}>Delete</button>`}
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn primary" disabled=${!f.title.trim() || !f.day} onClick=${save}>${e ? 'Save' : 'Add event'}</button>
      </footer>
    <//>`
}

// ---------------------------------------------------------------- tasks

function TaskBoard ({ g }) {
  const [mineOnly, setMineOnly] = useState(false)
  const [over, setOver] = useState(null)
  const tasks = model.tasksOf(g).filter(t => !mineOnly || t.assignee === model.me.key)
  const move = (id, status) => {
    const t = g.tasks.get(id)
    if (t && t.status !== status) act(() => append(g.id, 'task.set', { id, status, order: Date.now() }))
  }
  return html`
    <div class="board">
      <div class="board-bar">
        <div class="seg-tabs small">
          <button class=${!mineOnly ? 'active' : ''} onClick=${() => setMineOnly(false)}>All tasks</button>
          <button class=${mineOnly ? 'active' : ''} onClick=${() => setMineOnly(true)}>Assigned to me</button>
        </div>
        <small class="muted">Drag cards between columns · click one for details</small>
      </div>
      <div class="board-cols">
        ${COLUMNS.map((c) => {
          const list = tasks.filter(t => t.status === c.id)
          return html`
            <div key=${c.id} class="board-col ${over === c.id ? 'over' : ''}"
              onDragOver=${(e) => { if (e.dataTransfer.types.includes('text/od-task')) { e.preventDefault(); setOver(c.id) } }}
              onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null) }}
              onDrop=${(e) => { e.preventDefault(); setOver(null); move(e.dataTransfer.getData('text/od-task'), c.id) }}>
              <header><span class="col-dot ${c.id}" />${c.label}<small>${list.length}</small></header>
              ${c.id === 'todo' && html`<${QuickAdd} g=${g} />`}
              <div class="col-cards">
                ${list.map(t => html`<${TaskCard} key=${t.id} g=${g} t=${t} onToggle=${() => move(t.id, t.status === 'done' ? 'todo' : 'done')} />`)}
                ${!list.length && c.id !== 'todo' && html`<div class="col-empty">${c.id === 'doing' ? 'Drag a task here when you start it' : 'Finished tasks land here'}</div>`}
              </div>
            </div>`
        })}
      </div>
    </div>`
}

function QuickAdd ({ g }) {
  const [title, setTitle] = useState('')
  const add = async () => {
    const t = title.trim()
    if (!t) return
    setTitle('')
    await act(() => append(g.id, 'task.set', { id: rid(), title: t, status: 'todo', order: Date.now() }))
  }
  return html`
    <div class="quick-add">
      <${Icon} name="plus" size=${16} />
      <input value=${title} maxLength="200" placeholder="Add a task…" onInput=${(e) => setTitle(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && add()} />
    </div>`
}

function dueLabel (due) {
  if (!due) return null
  const today = todayKey()
  const cls = due < today ? 'overdue' : due === today ? 'today' : ''
  const tomorrow = dayKey(new Date(Date.now() + 864e5))
  const text = due === today ? 'Today' : due === tomorrow ? 'Tomorrow' : fmtDayShort(due)
  return { cls, text }
}

function TaskCard ({ g, t, onToggle }) {
  const done = t.checklist.filter(i => i.done).length
  const due = t.status !== 'done' ? dueLabel(t.due) : null
  return html`
    <div class="task-card ${t.status}" draggable="true"
      onDragStart=${(e) => { e.dataTransfer.setData('text/od-task', t.id); e.dataTransfer.effectAllowed = 'move' }}
      onClick=${() => model.openModal('task', { gid: g.id, id: t.id })}>
      <button class="task-check ${t.status === 'done' ? 'on' : ''}" title=${t.status === 'done' ? 'Mark as not done' : 'Mark as done'} onClick=${(e) => { e.stopPropagation(); onToggle() }}><${Icon} name="check" size=${13} /></button>
      <div class="task-main">
        <span class="task-title">${t.title}</span>
        ${(due || t.checklist.length > 0 || t.desc) && html`
          <div class="task-meta">
            ${due && html`<span class="due ${due.cls}"><${Icon} name="clock" size=${12} /> ${due.text}</span>`}
            ${t.checklist.length > 0 && html`<span class="checks ${done === t.checklist.length ? 'all' : ''}"><${Icon} name="tasks" size=${12} /> ${done}/${t.checklist.length}</span>`}
            ${t.desc && html`<${Icon} name="file" size=${12} class="dim" title="Has a description" />`}
          </div>`}
      </div>
      ${t.assignee && html`<span class="task-who" title=${'Assigned to ' + model.memberName(g, t.assignee)}><${Avatar} name=${model.memberName(g, t.assignee)} color=${model.memberColor(g, t.assignee)} src=${model.memberAvatar(g, t.assignee)} size=${24} /></span>`}
    </div>`
}

export function TaskModal ({ gid, id }) {
  const g = model.groups.get(gid)
  const t = g?.tasks.get(id)
  const [f, setF] = useState(() => t ? { title: t.title, desc: t.desc, status: t.status, assignee: t.assignee || '', due: t.due || '', checklist: t.checklist.map(i => ({ ...i })) } : null)
  const [item, setItem] = useState('')
  const itemRef = useRef()
  useEffect(() => { if (t && t.deleted) model.closeModal() })
  if (!g || !t || !f) return null
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const people = [model.me.key, ...model.membersOf(g).map(m => m.key).filter(k => k !== model.me.key)]
  const addItem = () => {
    const text = item.trim()
    if (!text) return
    setF({ ...f, checklist: [...f.checklist, { id: rid().slice(0, 8), text, done: false }].slice(0, 50) })
    setItem('')
    itemRef.current?.focus()
  }
  const save = async () => {
    const data = { title: f.title.trim(), desc: f.desc, status: f.status, assignee: f.assignee || null, due: f.due || null, checklist: f.checklist }
    const changed = Object.fromEntries(Object.entries(data).filter(([k, v]) => JSON.stringify(t[k]) !== JSON.stringify(v)))
    if (changed.status) changed.order = Date.now()
    if (Object.keys(changed).length) await act(() => append(gid, 'task.set', { id: t.id, ...changed }))
    model.closeModal()
  }
  const del = () => model.openModal('confirm', {
    title: 'Delete task', body: `Delete “${t.title}” for everyone?`, confirm: 'Delete', danger: true,
    onConfirm: () => act(() => append(gid, 'task.delete', { id: t.id }))
  })
  const done = f.checklist.filter(i => i.done).length
  return html`
    <${Modal} title="Task">
      <div class="modal-body planner-form">
        <label>Title<input value=${f.title} maxLength="200" onInput=${set('title')} /></label>
        <div class="seg-tabs status-tabs">
          ${COLUMNS.map(c => html`<button key=${c.id} class=${f.status === c.id ? 'active' : ''} onClick=${() => setF({ ...f, status: c.id })}><span class="col-dot ${c.id}" />${c.label}</button>`)}
        </div>
        <div class="row">
          <label class="grow">Assigned to
            <select value=${f.assignee} onChange=${set('assignee')}>
              <option value="">Nobody</option>
              ${people.map(k => html`<option value=${k}>${k === model.me.key ? model.me.name + ' (you)' : model.memberName(g, k)}</option>`)}
            </select>
          </label>
          <label>Due<input type="date" value=${f.due} onInput=${set('due')} /></label>
        </div>
        <label>Description<textarea rows="3" value=${f.desc} maxLength="4000" placeholder="Details, links, notes…" onInput=${set('desc')} /></label>
        <div class="checklist">
          <div class="cl-head"><b>Checklist</b>${f.checklist.length > 0 && html`<small>${done}/${f.checklist.length}</small>`}</div>
          ${f.checklist.length > 0 && html`<div class="progress"><i style=${{ width: Math.round(done / f.checklist.length * 100) + '%' }} /></div>`}
          ${f.checklist.map((i, n) => html`
            <div class="cl-item ${i.done ? 'done' : ''}" key=${i.id}>
              <input type="checkbox" checked=${i.done} onChange=${(e) => setF({ ...f, checklist: f.checklist.map((x, j) => j === n ? { ...x, done: e.target.checked } : x) })} />
              <input class="cl-text" value=${i.text} maxLength="300" onInput=${(e) => setF({ ...f, checklist: f.checklist.map((x, j) => j === n ? { ...x, text: e.target.value } : x) })} />
              <button class="icon-btn small" title="Remove" onClick=${() => setF({ ...f, checklist: f.checklist.filter((_, j) => j !== n) })}><${Icon} name="x" size=${14} /></button>
            </div>`)}
          <div class="cl-add">
            <${Icon} name="plus" size=${15} />
            <input ref=${itemRef} value=${item} maxLength="300" placeholder="Add an item" onInput=${(e) => setItem(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && addItem()} />
          </div>
        </div>
        ${t.createdBy && html`<p class="hint">Added by ${model.memberName(g, t.createdBy)}</p>`}
      </div>
      <footer>
        <button class="btn danger" onClick=${del}>Delete</button>
        <div class="spacer" />
        <button class="btn" onClick=${() => model.closeModal()}>Cancel</button>
        <button class="btn primary" disabled=${!f.title.trim()} onClick=${save}>Save</button>
      </footer>
    <//>`
}

// ---------------------------------------------------------------- reminders

// Desktop reminders while the app runs: timed events `remind` minutes before they start,
// all-day events at 9:00 on the day, and tasks assigned to you at 9:00 on their due day.
let remindTimer = null
export function startReminders ({ api }) {
  let fired
  try { fired = new Set(JSON.parse(localStorage.getItem('od.reminded') || '[]')) } catch { fired = new Set() }
  const remember = (k) => {
    fired.add(k)
    try { localStorage.setItem('od.reminded', JSON.stringify([...fired].slice(-500))) } catch {}
  }
  const notify = (g, title, body, onClick) => {
    model.toast(title + (body ? ' — ' + body : ''))
    api.attention()
    if (!model.settings.notifications) return
    try {
      const n = new Notification(title, { body })
      n.onclick = () => { api.showWindow(); onClick() }
    } catch {}
  }
  const check = () => {
    const now = Date.now()
    for (const g of model.groups.values()) {
      if (g.kickedMe) continue
      for (const e of model.eventsOf(g)) {
        if (e.remind == null || e.rsvp.get(model.me.key)?.v === 'no') continue
        const start = eventStart(e)
        const at = e.allDay ? start + 9 * 3600e3 : start - e.remind * 60000
        const until = e.allDay ? start + 864e5 : start + 15 * 60000
        const key = 'e:' + g.id + ':' + e.id + ':' + start + ':' + e.remind
        if (now < at || now > until || fired.has(key)) continue
        remember(key)
        const where = model.groupName(g)
        const mins = Math.round((start - now) / 60000)
        notify(g, e.title, e.allDay ? 'Today · ' + where : (mins > 1 ? `Starts in ${mins} min` : 'Starting now') + ' · ' + where,
          () => { model.openPlanner(g.id, 'calendar'); model.openModal('event', { gid: g.id, id: e.id }) })
      }
      for (const t of model.tasksOf(g)) {
        if (t.status === 'done' || t.assignee !== model.me.key || !t.due) continue
        const at = parseDay(t.due).getTime() + 9 * 3600e3
        const key = 't:' + g.id + ':' + t.id + ':' + t.due
        if (now < at || now > at + 864e5 || fired.has(key)) continue
        remember(key)
        notify(g, 'Task due today: ' + t.title, model.groupName(g), () => { model.openPlanner(g.id, 'tasks'); model.openModal('task', { gid: g.id, id: t.id }) })
      }
    }
  }
  clearInterval(remindTimer)
  remindTimer = setInterval(check, 20000)
  setTimeout(check, 4000)
}
