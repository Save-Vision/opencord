// Runs the chess computer (chessbot.js) off the main thread, so the window stays smooth while
// it thinks. In: { key, moves: [uci], level }. Out: { key, uci } (uci null if it has no move).
import { botReply } from './chessbot.js'

self.onmessage = (e) => {
  const { key, moves, level } = e.data || {}
  let uci = null
  try { uci = botReply(Array.isArray(moves) ? moves : [], level) } catch {}
  self.postMessage({ key, uci })
}
