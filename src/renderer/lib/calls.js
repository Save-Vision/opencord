// Call history in private chats. A private call is the chat's "call" voice channel; who calls,
// answers, declines and hangs up last is written down as signed ops in the chat's own history,
// so both of you see it, also when one of you was offline:
//
//   call.start   {id}  the caller's app, when they start a call (the friend wasn't in it)
//   call.join    {id}  the friend's app, when they answer (join while the caller is in it)
//   call.decline {id}  the friend's app, when they press Decline
//   call.end     {id}  the app of whoever leaves last
//
// The id travels in the voice state too (`call`), so the answering app knows which call it is.
// Apps before 0.8.1 ignore these ops. Kept free of browser code so tests can use it.

export const CALL_ID = /^[0-9a-f]{16}$/

// A call as the model keeps it: { id, by, t, joins: Map(key -> t), declined: Map(key -> t), end }
export function newCall (id) {
  return { id, by: null, t: 0, joins: new Map(), declined: new Map(), end: 0 }
}

// What became of a call, seen by `me`. live: someone is in it right now.
//   ringing  someone else is calling me      calling  I'm calling, no answer yet
//   ongoing  answered and still going on     done     answered and over
//   declined the other one pressed Decline   missed   never answered
export function callStatus (c, me, live) {
  const answered = [...c.joins.keys()].some(k => k !== c.by)
  if (live) return answered ? 'ongoing' : c.by === me ? 'calling' : 'ringing'
  if (answered) return 'done'
  if ([...c.declined.keys()].some(k => k !== c.by)) return 'declined'
  return 'missed'
}

// How long an answered call lasted (0 when nobody wrote down its end)
export function callLength (c) {
  if (!c.end) return 0
  return Math.max(0, c.end - c.t)
}

export function fmtCallLength (ms) {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'less than a minute'
  if (m < 60) return m === 1 ? 'a minute' : m + ' minutes'
  const h = Math.floor(m / 60)
  const rest = m % 60
  return (h === 1 ? 'an hour' : h + ' hours') + (rest ? ' ' + rest + ' min' : '')
}
