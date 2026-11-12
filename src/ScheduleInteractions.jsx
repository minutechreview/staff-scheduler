import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import { adjustShift, dragMinutes, wallTime } from './scheduleEditing.mjs'

export function ShiftCard({ shift, employee, day, zone, disabled, proposed, onEdit, onChange, onMenu, onCopy, onPaste, onRemove, onError }) {
  const drag = useRef(null)
  const button = useRef(null)
  const suppressClick = useRef(false)
  const [preview, setPreview] = useState(null)
  const display = preview?.shift || shift
  const start = wallTime(display.start, zone), end = wallTime(display.end, zone)
  const timeLabel = `${start.slice(11)} – ${end.slice(11)}${start.slice(0, 10) !== end.slice(0, 10) ? ' +1' : ''}`
  function commit(edited) {
    const operation = onChange(edited)
    operation?.then(() => requestAnimationFrame(() => button.current?.focus({ preventScroll: true })))
  }
  function begin(event, edge) {
    // Touch retains scrolling and the explicit menu. Never hijack a swipe.
    if (disabled || event.button !== 0 || event.pointerType === 'touch') return
    event.stopPropagation()
    suppressClick.current = false
    drag.current = { x: event.clientX, edge, pointer: event.pointerId, moved: false, shift }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event) {
    const state = drag.current
    if (!state || state.pointer !== event.pointerId) return
    const pixels = event.clientX - state.x
    if (Math.abs(pixels) < 5 && !state.moved) return
    state.moved = true
    suppressClick.current = true
    const minutes = dragMinutes(pixels)
    try { setPreview({ shift: adjustShift(state.shift, zone, state.edge, minutes), minutes, valid: true }) }
    catch (error) { setPreview({ shift: state.shift, minutes, valid: false, error: error.message }) }
  }
  function finish(event, cancel = false) {
    const state = drag.current
    if (!state || state.pointer !== event.pointerId) return
    drag.current = null
    setPreview(null)
    if (cancel || !state.moved) return
    const minutes = dragMinutes(event.clientX - state.x)
    if (!minutes) return
    try { commit(adjustShift(state.shift, zone, state.edge, minutes)) }
    catch (error) { onError(error.message) }
  }
  function keys(event, edge) {
    if (event.key === 'Escape' && drag.current) { drag.current = null; setPreview(null); suppressClick.current = true; return }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); onMenu(event); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); onCopy(); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); onPaste(); return }
    if (edge === 'move' && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); onRemove(); return }
    if ((edge !== 'move' || event.altKey) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      try { commit(adjustShift(shift, zone, edge, event.key === 'ArrowLeft' ? -30 : 30)) }
      catch (error) { onError(error.message) }
    }
  }
  const pointer = edge => ({ onPointerDown: e => begin(e, edge), onPointerMove: move, onPointerUp: e => finish(e), onPointerCancel: e => finish(e, true), onLostPointerCapture: e => finish(e, true), onKeyDown: e => keys(e, edge) })
  return <div className={`shift-card ${preview ? 'dragging' : ''}`}>
    <button ref={button} {...pointer('move')} disabled={disabled} className={`shift ${shift.role === 'lead' ? 'lead' : ''} ${proposed ? 'proposed' : ''}`} onContextMenu={e => { if (!disabled) { e.preventDefault(); e.stopPropagation(); onMenu(e) } }} onClick={() => { if (suppressClick.current) { suppressClick.current = false; return } onEdit() }} aria-label={`Edit ${employee.name}, ${day}, ${start.slice(11)} to ${end.slice(11)}`} aria-describedby="shift-edit-help" title="Click to edit. Drag left/right: 30 minutes per 20px. Alt + arrow keys move times.">
      <strong>{timeLabel}</strong><span>{shift.role} · {preview ? 'release to check & save' : `${((new Date(shift.end) - new Date(shift.start)) / 3600000).toFixed(1)}h`}</span>
    </button>
    <button {...pointer('start')} disabled={disabled} className="shift-resize start" aria-label={`Adjust start of ${employee.name} shift on ${day}`} title="Drag start time; arrow keys adjust 30 minutes" onClick={e => e.stopPropagation()} /><button {...pointer('end')} disabled={disabled} className="shift-resize end" aria-label={`Adjust end of ${employee.name} shift on ${day}`} title="Drag end time; arrow keys adjust 30 minutes" onClick={e => e.stopPropagation()} /><button disabled={disabled} className="shift-menu-trigger" aria-label={`Shift actions for ${employee.name} on ${day}`} onClick={onMenu}><MoreHorizontal size={16} /></button>
    {preview && <div className={`drag-preview ${preview.valid ? '' : 'invalid'}`} role="status">{preview.valid ? `${timeLabel} · ${preview.minutes >= 0 ? '+' : ''}${preview.minutes} min · release to save draft` : preview.error}</div>}
  </div>
}

export function ScheduleMenu({ menu, actions, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const node = ref.current
    node.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true })
    const dismiss = event => { if (!(event.target instanceof Node) || !node.contains(event.target)) onClose(false) }
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', dismiss)
    // Dismiss for intentional scrolling outside the menu. A queued scroll from
    // bringing its trigger into view must not immediately close a new menu.
    document.addEventListener('wheel', dismiss, { capture: true, passive: true })
    document.addEventListener('touchmove', dismiss, { capture: true, passive: true })
    return () => { document.removeEventListener('pointerdown', dismiss); window.removeEventListener('resize', dismiss); document.removeEventListener('wheel', dismiss, true); document.removeEventListener('touchmove', dismiss, true) }
  }, [onClose])
  function keys(event) {
    const items = [...ref.current.querySelectorAll('[role="menuitem"]:not(:disabled)')]
    const index = items.indexOf(document.activeElement)
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(true) }
  }
  const timing = actions.filter(action => action.adjustment)
  const item = action => <button role="menuitem" key={action.label} aria-label={action.label} disabled={action.disabled} onClick={() => { onClose(true); action.run() }}>{action.text || action.label}{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>
  return createPortal(<div ref={ref} className="schedule-menu" role="menu" aria-label="Schedule actions" onKeyDown={keys} style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 278)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 448)) }}>
    <p>{menu.employee.name}<small>{menu.day}{menu.shift ? ` · ${wallTime(menu.shift.start, menu.zone).slice(11)}–${wallTime(menu.shift.end, menu.zone).slice(11)}` : ''}</small></p>
    {actions.map(action => action.adjustment ? action === timing[0] && <div className="menu-timing" key="timing" role="group" aria-label="Adjust times in 30-minute steps">{timing.map(item)}</div> : item(action))}
  </div>, document.querySelector('main.main-content') || document.body)
}

export function RepeatShiftForm({ employee, template, days, onSubmit }) {
  const [selected, setSelected] = useState(new Set())
  const [saving, setSaving] = useState(false)
  return <form onSubmit={async event => {
    event.preventDefault()
    if (saving || !selected.size) return
    setSaving(true)
    try { await onSubmit([...selected]) } finally { setSaving(false) }
  }}>
    <p>Repeat <strong>{template.start}–{template.end}{template.days ? ` +${template.days} day` : ''} · {template.role}</strong> for {employee.name}. Existing shifts stay in place.</p>
    <div className="repeat-selection-actions"><button className="button" type="button" disabled={saving} onClick={() => setSelected(new Set(days.filter(day => !day.occupied && !day.duplicate && !day.leave).map(day => day.day)))}>Select empty days</button><button className="button" type="button" disabled={saving || !selected.size} onClick={() => setSelected(new Set())}>Clear days</button></div>
    <fieldset className="repeat-days" disabled={saving}><legend>Choose days</legend>{days.map(day => <label className={`check-field ${day.duplicate || day.leave ? 'unavailable' : ''}`} key={day.day}><input type="checkbox" name={`day_${day.day}`} disabled={day.duplicate || day.leave} checked={selected.has(day.day)} onChange={event => setSelected(old => { const next = new Set(old); if (event.target.checked) next.add(day.day); else next.delete(day.day); return next })} /><span>{day.label}<small>{day.leave ? 'Approved leave' : day.duplicate ? 'Already assigned' : day.occupied ? 'Has another shift · conflicts checked on save' : 'No shifts assigned'}</small></span></label>)}</fieldset>
    <p className="repeat-summary" role="status">{selected.size ? `${selected.size} new draft shift${selected.size === 1 ? '' : 's'} selected. All selected days must pass together.` : 'Choose days or select all empty days to get started.'}</p>
    <p className="help">Availability, leave, skills, support permissions, rest and hours are rechecked on save. If any day conflicts, none are saved. This never publishes.</p>
    <button className="button primary" disabled={saving || !selected.size}>{saving ? 'Checking and saving…' : 'Save repeated draft shifts'}</button>
  </form>
}
