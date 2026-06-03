import { useState, useEffect } from 'react'
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDoc, getDocs, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'

// Firestore path: roster/{staffId}
// Each doc: { id, name, empNo, position, gender, homeStore }

export function useRoster(storeId = null) {
  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // If storeId given, listen to store-specific roster; otherwise listen to full master roster
    const colRef = storeId
      ? collection(db, 'stores', storeId, 'roster')
      : collection(db, 'roster')

    const unsubscribe = onSnapshot(colRef, (snapshot) => {
      const staffList = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))
      setStaff(staffList.sort((a, b) => (a.order ?? 99) - (b.order ?? 99)))
      setLoading(false)
    })

    return unsubscribe
  }, [storeId])

  async function addStaffMember(storeId, staffData) {
    const staffRef = doc(collection(db, 'stores', storeId, 'roster'))
    await setDoc(staffRef, { ...staffData, id: staffRef.id })
  }

  async function removeStaffMember(storeId, staffId) {
    await deleteDoc(doc(db, 'stores', storeId, 'roster', staffId))
  }

  async function updateStaffMember(storeId, staffId, staffData) {
    await setDoc(doc(db, 'stores', storeId, 'roster', staffId), staffData, { merge: true })
  }

  async function transferStaffMember(fromStoreId, toStoreId, staffId, effectiveDate) {
    const fromRef = doc(db, 'stores', fromStoreId, 'roster', staffId)
    const snap = await getDoc(fromRef)
    if (!snap.exists()) return

    const staffData = snap.data()
    const toRef = doc(db, 'stores', toStoreId, 'roster', staffId)

    // Write to destination store with transfer metadata
    await setDoc(toRef, {
      ...staffData,
      transferredFrom: { storeId: fromStoreId, effectiveDate },
    })

    // Soft-remove from origin store — keep doc so historical schedules remain visible
    await setDoc(fromRef, {
      transferredOut: { storeId: toStoreId, effectiveDate },
      active: false,
    }, { merge: true })

    // Update storeId in leave balance records so leave follows the staff member
    const year = new Date().getFullYear()
    const balRef = doc(db, 'leaveBalances', `${year}_${staffId}`)
    const balSnap = await getDoc(balRef)
    if (balSnap.exists()) {
      await setDoc(balRef, { storeId: toStoreId }, { merge: true })
    }

    // Update storeId in all leave plan entries for this staff member
    const plansSnap = await getDocs(collection(db, 'leavePlans'))
    const staffPlans = plansSnap.docs.filter((d) => d.data().staffId === staffId)
    await Promise.all(staffPlans.map((d) => setDoc(d.ref, { storeId: toStoreId }, { merge: true })))
  }

  async function reorderStaff(storeId, orderedIds) {
    const batch = writeBatch(db)
    orderedIds.forEach((staffId, idx) => {
      const ref = doc(db, 'stores', storeId, 'roster', staffId)
      batch.update(ref, { order: idx + 1 })
    })
    await batch.commit()
  }

  return { staff, loading, addStaffMember, updateStaffMember, removeStaffMember, transferStaffMember, reorderStaff }
}

// Fetch support pool staff (not tied to any store)
export function useSupportPool() {
  const [supportStaff, setSupportStaff] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'supportPool'), (snapshot) => {
      setSupportStaff(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })))
      setLoading(false)
    })
    return unsubscribe
  }, [])

  return { supportStaff, loading }
}
