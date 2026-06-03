import { useState, useEffect } from 'react'
import { collection, onSnapshot, doc, setDoc, deleteDoc, getDoc, query, where } from 'firebase/firestore'
import { db } from '../firebase'
import {
  DEFAULT_HOLIDAYS,
  countLeaveDays,
  applyLeaveToSchedule,
  removeLeaveFromSchedule,
} from '../utils/leaveUtils'

const ANNUAL_ENTITLEMENT = 30

// ── Leave Balances ────────────────────────────────────────────────────────────
// Document ID: `${year}_${staffId}`
// Stored in: leaveBalances/{id}

export function useLeaveBalances(storeId) {
  const [balances, setBalances] = useState({}) // staffId -> balance doc
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!storeId) return
    const year = new Date().getFullYear()
    const q = query(collection(db, 'leaveBalances'), where('storeId', '==', storeId), where('year', '==', year))
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const bal = {}
      snapshot.docs.forEach((d) => {
        const data = d.data()
        bal[data.staffId] = { docId: d.id, ...data }
      })
      setBalances(bal)
      setLoading(false)
    })
    return unsubscribe
  }, [storeId])

  async function ensureBalance(staffId, staffName, carryForward = 0) {
    const year = new Date().getFullYear()
    const docId = `${year}_${staffId}`
    const ref = doc(db, 'leaveBalances', docId)
    const snap = await getDoc(ref)
    if (!snap.exists()) {
      const total = ANNUAL_ENTITLEMENT + carryForward
      const data = {
        staffId, staffName, storeId, year,
        annualEntitlement: ANNUAL_ENTITLEMENT,
        carryForward,
        totalBalance: total,
        used: 0,
        remaining: total,
      }
      await setDoc(ref, data)
      return data
    }
    return snap.data()
  }

  async function setCarryForward(staffId, staffName, carryForward) {
    const year = new Date().getFullYear()
    const ref = doc(db, 'leaveBalances', `${year}_${staffId}`)
    const snap = await getDoc(ref)
    const used = snap.exists() ? (snap.data().used || 0) : 0
    const total = ANNUAL_ENTITLEMENT + carryForward
    await setDoc(ref, {
      staffId, staffName, storeId, year,
      annualEntitlement: ANNUAL_ENTITLEMENT,
      carryForward,
      totalBalance: total,
      used,
      remaining: total - used,
    })
  }

  async function deductLeave(staffId, staffName, days) {
    const bal = await ensureBalance(staffId, staffName)
    const year = new Date().getFullYear()
    const ref = doc(db, 'leaveBalances', `${year}_${staffId}`)
    await setDoc(ref, {
      ...bal,
      used: (bal.used || 0) + days,
      remaining: (bal.remaining ?? bal.totalBalance) - days,
    }, { merge: true })
  }

  async function restoreLeave(staffId, days) {
    const year = new Date().getFullYear()
    const ref = doc(db, 'leaveBalances', `${year}_${staffId}`)
    const snap = await getDoc(ref)
    if (!snap.exists()) return
    const bal = snap.data()
    await setDoc(ref, {
      used: Math.max(0, (bal.used || 0) - days),
      remaining: Math.min(bal.totalBalance, (bal.remaining || 0) + days),
    }, { merge: true })
  }

  return { balances, loading, ensureBalance, setCarryForward, deductLeave, restoreLeave }
}

// ── Leave Plans ───────────────────────────────────────────────────────────────
// Document ID: auto
// Stored in: leavePlans/{id}

export function useLeavePlans(storeId) {
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [holidays, setHolidays] = useState(DEFAULT_HOLIDAYS)

  // Load public holidays config (optional Firestore override)
  useEffect(() => {
    getDoc(doc(db, 'config', 'publicHolidays'))
      .then((snap) => { if (snap.exists() && snap.data().dates) setHolidays(snap.data().dates) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!storeId) return
    const q = query(collection(db, 'leavePlans'), where('storeId', '==', storeId))
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const storePlans = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => a.startDate.localeCompare(b.startDate))
      setPlans(storePlans)
      setLoading(false)
    })
    return unsubscribe
  }, [storeId])

  async function addPlan({ staffId, staffName, startDate, endDate, note }, deductFn) {
    const daysCount = countLeaveDays(startDate, endDate, holidays)
    const planRef = doc(collection(db, 'leavePlans'))
    const planData = {
      staffId, staffName, storeId,
      year: new Date(startDate + 'T00:00:00').getFullYear(),
      startDate, endDate, daysCount,
      note: note || '',
      createdAt: new Date().toISOString(),
    }
    await setDoc(planRef, planData)
    await deductFn(staffId, staffName, daysCount)
    await applyLeaveToSchedule(staffId, storeId, startDate, endDate, holidays)
    return { id: planRef.id, ...planData }
  }

  async function deletePlan(plan, restoreFn) {
    await deleteDoc(doc(db, 'leavePlans', plan.id))
    await restoreFn(plan.staffId, plan.daysCount)
    await removeLeaveFromSchedule(plan.staffId, plan.storeId, plan.startDate, plan.endDate, holidays)
  }

  async function updatePlan(plan, { startDate, endDate, note }, deductFn, restoreFn) {
    await restoreFn(plan.staffId, plan.daysCount)
    await removeLeaveFromSchedule(plan.staffId, plan.storeId, plan.startDate, plan.endDate, holidays)
    const daysCount = countLeaveDays(startDate, endDate, holidays)
    const updated = { ...plan, startDate, endDate, daysCount, note: note || '' }
    await setDoc(doc(db, 'leavePlans', plan.id), updated)
    await deductFn(plan.staffId, plan.staffName, daysCount)
    await applyLeaveToSchedule(plan.staffId, plan.storeId, startDate, endDate, holidays)
  }

  return { plans, loading, holidays, addPlan, deletePlan, updatePlan }
}
