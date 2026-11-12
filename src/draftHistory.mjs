// History is local to the current branch/week. Every undo/redo still saves
// through the server with its current revision and all scheduling rules.
export function emptyDraftHistory() { return { past: [], future: [] } }
export function canTravelDraft(history, direction, revision) {
  return history[direction].at(-1)?.revision === revision
}
function rebaseTop(entries, revision) {
  return entries.map((entry, index) => index === entries.length - 1 ? { ...entry, revision } : entry)
}
export function rememberDraft(history, shifts, previousRevision, revision) {
  const past = canTravelDraft(history, 'past', previousRevision) ? history.past : []
  return { past: [...past, { shifts: shifts.slice(), revision }].slice(-20), future: [] }
}
export function travelDraft(history, direction, shifts, previousRevision, revision) {
  if (!canTravelDraft(history, direction, previousRevision)) return emptyDraftHistory()
  const other = direction === 'past' ? 'future' : 'past'
  return {
    [direction]: rebaseTop(history[direction].slice(0, -1), revision),
    [other]: [...history[other], { shifts: shifts.slice(), revision }].slice(-20),
  }
}
