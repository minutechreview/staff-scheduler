import { useState, useEffect, useRef } from 'react'
import {
  doc, getDoc, setDoc, collection, getDocs, onSnapshot, deleteField
} from 'firebase/firestore'
import { db } from '../firebase'
import { getPrevWeekStart } from '../data/stores'

// Firestore path: schedules/{storeId}/weeks/{weekStartDate}
// Each document:
//   entries: { [staffId]: { FRI: 'AM Shift', FRI_dest: 'AlTijar', remarks: '...', ... } }
//   visitors: { [staffId]: { name, position, empNo, homeStoreId, homeStoreName } }
//   dayNotes: { FRI: 'Inventory', SAT: 'Public Holiday', ... }

export function useSchedule(storeId, weekStartDate) {
  const [scheduleEntries, setScheduleEntries] = useState({})
  const [visitors, setVisitors] = useState({})
  const [dayNotes, setDayNotes] = useState({})
  const [loading, setLoading] = useState(true)
  const [prevWeekEntries, setPrevWeekEntries] = useState({})
  const carryForwardDone = useRef(false)

  // Fetch previous week's entries (read-only, for Thu→Fri rest-period check)
  useEffect(() => {
    if (!storeId || !weekStartDate) return
    const prevWeek = getPrevWeekStart(weekStartDate)
    getDoc(doc(db, 'schedules', storeId, 'weeks', prevWeek)).then((snap) => {
      setPrevWeekEntries(snap.exists() ? (snap.data().entries || {}) : {})
    })
  }, [storeId, weekStartDate])

  // Reset carry-forward flag when week/store changes
  useEffect(() => {
    carryForwardDone.current = false
  }, [storeId, weekStartDate])

  useEffect(() => {
    if (!storeId || !weekStartDate) return

    const docRef = doc(db, 'schedules', storeId, 'weeks', weekStartDate)
    const unsubscribe = onSnapshot(docRef, async (snapshot) => {
      const data = snapshot.exists() ? snapshot.data() : null
      const entries = data?.entries || {}

      setScheduleEntries(entries)
      setVisitors(data?.visitors || {})
      setDayNotes(data?.dayNotes || {})
      setLoading(false)

      // Carry forward remarks from previous week — only when this week has no schedule yet.
      // Remarks are carried unless the staff explicitly cleared theirs (remarks: '').
      if (!carryForwardDone.current && !snapshot.exists()) {
        carryForwardDone.current = true
        const prevWeek = getPrevWeekStart(weekStartDate)
        const prevSnap = await getDoc(doc(db, 'schedules', storeId, 'weeks', prevWeek))
        if (prevSnap.exists()) {
          const prevEntries = prevSnap.data().entries || {}
          const carried = {}
          for (const [staffId, prevEntry] of Object.entries(prevEntries)) {
            if (prevEntry.remarks) carried[staffId] = { remarks: prevEntry.remarks }
          }
          if (Object.keys(carried).length > 0) {
            await setDoc(docRef, { entries: carried, storeId, weekStartDate }, { merge: true })
          }
        }
      }
      if (!carryForwardDone.current) carryForwardDone.current = true
    })

    return unsubscribe
  }, [storeId, weekStartDate])

  async function updateShift(staffId, day, shiftValue, detail = null) {
    // detail = destStore (for Support) or activity text (for Activity)
    const docRef = doc(db, 'schedules', storeId, 'weeks', weekStartDate)
    const existing = await getDoc(docRef)
    const currentData = existing.exists() ? existing.data() : {}
    const currentEntries = currentData.entries || {}

    const staffEntry = { ...(currentEntries[staffId] || {}), [day]: shiftValue }
    // Always clear the DM auth flag when the shift changes — it only applies to the original AM override.
    // Use deleteField() sentinel so Firestore actually removes the field (merge:true won't remove it otherwise).
    staffEntry[`${day}_dm_auth`] = deleteField()

    const prevDest = currentEntries[staffId]?.[`${day}_dest`] || null

    if (shiftValue === 'Support' && detail) {
      staffEntry[`${day}_dest`] = detail
      delete staffEntry[`${day}_activity`]
      await injectVisitorInternal(staffId, storeId, detail, weekStartDate, day)
      if (prevDest && prevDest !== detail) {
        await removeVisitorDay(staffId, prevDest, weekStartDate, day)
      }
    } else if (shiftValue === 'Activity') {
      if (detail) staffEntry[`${day}_activity`] = detail
      delete staffEntry[`${day}_dest`]
      if (prevDest) await removeVisitorDay(staffId, prevDest, weekStartDate, day)
    } else {
      delete staffEntry[`${day}_dest`]
      delete staffEntry[`${day}_activity`]
      if (prevDest) await removeVisitorDay(staffId, prevDest, weekStartDate, day)
    }

    const updatedEntries = { ...currentEntries, [staffId]: staffEntry }
    await setDoc(docRef, { ...currentData, entries: updatedEntries, storeId, weekStartDate }, { merge: true })
  }

  async function updateRemarks(staffId, remarks) {
    const docRef = doc(db, 'schedules', storeId, 'weeks', weekStartDate)
    const existing = await getDoc(docRef)
    const currentData = existing.exists() ? existing.data() : {}
    const currentEntries = currentData.entries || {}
    const staffEntry = { ...(currentEntries[staffId] || {}), remarks }
    const updatedEntries = { ...currentEntries, [staffId]: staffEntry }
    await setDoc(docRef, { ...currentData, entries: updatedEntries, storeId, weekStartDate }, { merge: true })
  }

  async function updateDayNote(day, note) {
    const docRef = doc(db, 'schedules', storeId, 'weeks', weekStartDate)
    const existing = await getDoc(docRef)
    const currentData = existing.exists() ? existing.data() : {}
    const currentDayNotes = currentData.dayNotes || {}
    await setDoc(docRef, {
      ...currentData,
      dayNotes: { ...currentDayNotes, [day]: note },
      storeId,
      weekStartDate,
    }, { merge: true })
  }

  // Store a DM-authorized override flag on a specific day's entry
  async function markDmAuth(staffId, day) {
    const docRef = doc(db, 'schedules', storeId, 'weeks', weekStartDate)
    const existing = await getDoc(docRef)
    const currentData = existing.exists() ? existing.data() : {}
    const currentEntries = currentData.entries || {}
    const staffEntry = { ...(currentEntries[staffId] || {}), [`${day}_dm_auth`]: true }
    const updatedEntries = { ...currentEntries, [staffId]: staffEntry }
    await setDoc(docRef, { ...currentData, entries: updatedEntries, storeId, weekStartDate }, { merge: true })
  }

  return { scheduleEntries, visitors, dayNotes, loading, prevWeekEntries, updateShift, updateRemarks, updateDayNote, markDmAuth }
}

async function removeVisitorDay(staffId, destStoreId, weekStartDate, day = null) {
  const destDocRef = doc(db, 'schedules', destStoreId, 'weeks', weekStartDate)
  const snap = await getDoc(destDocRef)
  if (!snap.exists()) return

  const data = snap.data()
  const currentVisitors = { ...(data.visitors || {}) }

  if (day && currentVisitors[staffId]?.supportDays) {
    // Remove just this day from supportDays; only delete visitor record if no days remain
    const updatedDays = currentVisitors[staffId].supportDays.filter((d) => d !== day)
    if (updatedDays.length === 0) {
      delete currentVisitors[staffId]
    } else {
      currentVisitors[staffId] = { ...currentVisitors[staffId], supportDays: updatedDays }
    }
  } else {
    delete currentVisitors[staffId]
  }

  await setDoc(destDocRef, { ...data, visitors: currentVisitors }, { merge: true })
}

// Module-level visitor injection — reusable by both updateShift and assignSupportShift.
async function injectVisitorInternal(staffId, sourceStoreId, destStoreId, weekStartDate, day = null) {
  const rosterSnap = await getDocs(collection(db, 'stores', sourceStoreId, 'roster'))
  const staffDoc = rosterSnap.docs.find((d) => d.id === staffId)
  if (!staffDoc) return

  const { STORES } = await import('../data/stores')
  const homeStore = STORES.find((s) => s.id === sourceStoreId)

  const destDocRef = doc(db, 'schedules', destStoreId, 'weeks', weekStartDate)
  const destExisting = await getDoc(destDocRef)
  const destData = destExisting.exists() ? destExisting.data() : {}
  const currentVisitors = destData.visitors || {}
  const existingSupportDays = currentVisitors[staffId]?.supportDays || []

  const visitorData = {
    name: staffDoc.data().name,
    position: staffDoc.data().position || '',
    empNo: staffDoc.data().empNo || '',
    homeStoreId: sourceStoreId,
    homeStoreName: homeStore?.name || sourceStoreId,
    supportDays: day ? [...new Set([...existingSupportDays, day])] : existingSupportDays,
  }

  await setDoc(destDocRef, {
    ...destData,
    storeId: destStoreId,
    weekStartDate,
    visitors: { ...currentVisitors, [staffId]: visitorData },
  }, { merge: true })
}

// Assign a Support shift from source store to dest store for a specific day.
// Called by SupportPickerModal when the user picks a staff member.
export async function assignSupportShift(sourceStoreId, staffId, day, destStoreId, weekStartDate) {
  const srcDocRef = doc(db, 'schedules', sourceStoreId, 'weeks', weekStartDate)
  const srcSnap = await getDoc(srcDocRef)
  const srcData = srcSnap.exists() ? srcSnap.data() : {}
  const srcEntries = srcData.entries || {}

  const staffEntry = {
    ...(srcEntries[staffId] || {}),
    [day]: 'Support',
    [`${day}_dest`]: destStoreId,
  }

  await setDoc(srcDocRef, {
    ...srcData,
    entries: { ...srcEntries, [staffId]: staffEntry },
    storeId: sourceStoreId,
    weekStartDate,
  }, { merge: true })

  await injectVisitorInternal(staffId, sourceStoreId, destStoreId, weekStartDate, day)
}

// Auto-generate a week's schedule using the rule engine and write it to Firestore.
export async function generateWeekSchedule(storeId, weekStartDate, staff, existingEntries, store, prevWeekEntries) {
  const { planWeekForStaff } = await import('../utils/schedulingAssistant')
  const draft = planWeekForStaff(staff, store, existingEntries, prevWeekEntries)

  const docRef = doc(db, 'schedules', storeId, 'weeks', weekStartDate)
  const snap = await getDoc(docRef)
  const currentData = snap.exists() ? snap.data() : {}

  await setDoc(docRef, {
    ...currentData,
    entries: draft,
    storeId,
    weekStartDate,
  }, { merge: true })
}

// Copy a template week's schedule to one or more target weeks.
// Preserves any existing Leave or Support entries in target weeks.
// Does NOT copy Leave entries from the template (those are period-specific).
export async function copyWeekSchedule(storeId, templateEntries, targetWeekDates) {
  const SKIP_COPY = new Set(['Leave', 'LOP']) // don't replicate absence types across weeks
  const PRESERVE_TARGET = new Set(['Leave', 'LOP', 'Support']) // never overwrite these in target

  for (const targetWeekStart of targetWeekDates) {
    const docRef = doc(db, 'schedules', storeId, 'weeks', targetWeekStart)
    const snap = await getDoc(docRef)
    const existingData = snap.exists() ? snap.data() : {}
    const existingEntries = existingData.entries || {}

    // Build merged entries: template as base, target's Leave/Support preserved
    const merged = {}
    for (const [staffId, templateStaffEntry] of Object.entries(templateEntries)) {
      const targetStaffEntry = existingEntries[staffId] || {}
      merged[staffId] = { ...(targetStaffEntry.remarks ? { remarks: targetStaffEntry.remarks } : {}) }

      for (const day of ['FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU']) {
        // If target already has a protected shift, keep it
        if (PRESERVE_TARGET.has(targetStaffEntry[day])) {
          merged[staffId][day] = targetStaffEntry[day]
          if (targetStaffEntry[`${day}_dest`]) merged[staffId][`${day}_dest`] = targetStaffEntry[`${day}_dest`]
          continue
        }
        // Don't copy Leave from template to future weeks
        if (SKIP_COPY.has(templateStaffEntry[day])) continue
        // Copy the shift
        if (templateStaffEntry[day]) {
          merged[staffId][day] = templateStaffEntry[day]
          if (templateStaffEntry[`${day}_dest`]) merged[staffId][`${day}_dest`] = templateStaffEntry[`${day}_dest`]
          if (templateStaffEntry[`${day}_activity`]) merged[staffId][`${day}_activity`] = templateStaffEntry[`${day}_activity`]
        }
      }
      // Always carry remarks from template if target has none
      if (!merged[staffId].remarks && templateStaffEntry.remarks) {
        merged[staffId].remarks = templateStaffEntry.remarks
      }
    }

    await setDoc(docRef, { ...existingData, entries: merged, storeId, weekStartDate: targetWeekStart }, { merge: true })
  }
}

/**
 * Fetch a summary of multiple stores (for Overview)
 * Accepts a list of store objects to fetch for (filtered by AOR).
 */
export async function fetchAllStoresSummary(stores, weekStartDate, options = {}) {
  const summary = {}
  const includeVisitors = options.includeVisitors === true
  const includeRoster = options.includeRoster === true

  if (!stores || stores.length === 0) return {}

  await Promise.all(
    stores.map(async (store) => {
      try {
        const weekRef = doc(db, 'schedules', store.id, 'weeks', weekStartDate)
        const weekSnap = await getDoc(weekRef)
        const data = weekSnap.exists() ? weekSnap.data() : {}
        let roster = {}
        if (includeRoster) {
          const rosterSnap = await getDocs(collection(db, 'stores', store.id, 'roster'))
          rosterSnap.docs.forEach((d) => { roster[d.id] = d.data() })
        }
        summary[store.id] = includeVisitors || includeRoster
          ? { entries: data.entries || {}, visitors: includeVisitors ? data.visitors || {} : {}, roster }
          : data.entries || {}
      } catch (err) {
        console.warn(`[fetchAllStoresSummary] Error for store ${store.id}:`, err)
      }
    })
  )

  return summary
}
