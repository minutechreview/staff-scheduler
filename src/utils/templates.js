import { collection, doc, getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import { db } from '../firebase'

// ── Template Data Model ──────────────────────────────────────────────────────

/*
  templates/{storeId}/entries/{templateId}
  {
    id: string,
    name: string,              // "Morning Shift Pattern", "Weekend Heavy", etc.
    createdAt: Timestamp,
    storeId: string,
    shifts: {
      // { [positionCategory]: { [day]: 'AM Shift' | 'PM Shift' | 'Day Off' | 'Mid Shift' | 'GY Shift' } }
      // Example: { 'B': { 'MON': 'AM Shift', 'TUE': 'AM Shift', ... }, 'SIC': { ... } }
      [positionCategory: string]: {
        [day: string]: string
      }
    },
    notes: string | null
  }
*/

// ── Save current week as template ────────────────────────────────────────────

export async function saveAsTemplate(storeId, storeName, staff, scheduleEntries, templateName) {
  if (!templateName?.trim()) throw new Error('Template name is required')
  if (staff.length === 0) throw new Error('No staff to save')

  // Group shifts by position category (B, SIC, A, etc.)
  const shifts = {}
  
  staff.forEach((member) => {
    const entry = scheduleEntries[member.id] || {}
    const position = member.position || 'B'
    
    if (!shifts[position]) shifts[position] = {}
    
    // Store only the shift type, not the staff ID
    // This allows applying the template to any staff with matching positions
    const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
    DAYS.forEach((day) => {
      const shift = entry[day]
      // Only save working shifts and day off - skip Leave, Support, Activity
      const WORKING = ['AM Shift', 'PM Shift', 'Day Off', 'Mid Shift', 'GY Shift', 'AM 8h']
      if (shift && WORKING.includes(shift)) {
        shifts[position][day] = shift
      }
    })
  })

  // Count how many shifts we actually saved
  let shiftCount = 0
  Object.values(shifts).forEach((dayShifts) => {
    shiftCount += Object.keys(dayShifts).length
  })

  if (shiftCount === 0) throw new Error('No shift patterns to save (only Leave/Support/Activity found)')

  const templateId = `tmpl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const templateData = {
    id: templateId,
    name: templateName.trim(),
    createdAt: new Date(),
    storeId,
    storeName,
    shifts,
    notes: null,
  }

  await setDoc(doc(db, 'templates', storeId, 'entries', templateId), templateData)
  
  return { id: templateId, name: templateName.trim(), shiftCount }
}

// ── Load templates for a store ─────────────────────────────────────────────

export async function getTemplates(storeId) {
  const snap = await getDocs(collection(db, 'templates', storeId, 'entries'))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

// ── Delete a template ───────────────────────────────────────────────────────

export async function deleteTemplate(storeId, templateId) {
  await deleteDoc(doc(db, 'templates', storeId, 'entries', templateId))
}

// ── Apply template to a week ────────────────────────────────────────────────

export async function applyTemplateToWeek(storeId, weekStart, staff, scheduleEntries, templateId) {
  const snap = await getDocs(collection(db, 'templates', storeId, 'entries'))
  const templateDoc = snap.docs.find((d) => d.id === templateId)
  
  if (!templateDoc) throw new Error('Template not found')
  
  const template = templateDoc.data()
  const shifts = template.shifts || {}
  
  // Track what we apply
  let applied = 0
  
  // For each staff member, apply shifts matching their position
  staff.forEach((member) => {
    const position = member.position || 'B'
    const positionShifts = shifts[position]
    
    if (!positionShifts) return
    
    // Apply each day's shift
    Object.entries(positionShifts).forEach(([day, shift]) => {
      // Don't overwrite existing Leave, Support, or Activity
      const existing = scheduleEntries[member.id]?.[day]
      const PROTECTED = ['Leave', 'Support', 'Activity']
      
      if (!existing || !PROTECTED.includes(existing)) {
        // We'll return what needs to be applied - actual writing happens in StoreView
        applied++
      }
    })
  })
  
  return { templateName: template.name, shifts, applied }
}

// ── Count templates by store ────────────────────────────────────────────────

export async function getTemplateCount(storeId) {
  const snap = await getDocs(collection(db, 'templates', storeId, 'entries'))
  return snap.size
}
