import { collection, addDoc, query, where, orderBy, limit, getDocs } from 'firebase/firestore'
import { db } from '../firebase'

// ── Audit Log Entry ───────────────────────────────────────────────────────────

/*
  auditLog/{storeId}/entries/{auto-id}
  {
    staffId: string,
    staffName: string,
    storeId: string,
    storeName: string,
    weekStart: string,
    day: string,           // MON, TUE, etc.
    fromShift: string | null,
    toShift: string,      // The authorized shift
    authorizedBy: string,  // 'DM'
    reason: string,        // e.g., 'rest-period', 'double-shift'
    timestamp: Timestamp,
  }
*/

export async function logDmAuthorization({
  storeId,
  storeName,
  staffId,
  staffName,
  weekStart,
  day,
  fromShift,
  toShift,
  reason,
}) {
  try {
    await addDoc(collection(db, 'auditLog', storeId, 'entries'), {
      staffId,
      staffName,
      storeId,
      storeName,
      weekStart,
      day,
      fromShift: fromShift || null,
      toShift,
      authorizedBy: 'DM',
      reason: reason || 'manual_override',
      timestamp: new Date(),
    })
  } catch (err) {
    console.error('Failed to write audit log:', err)
    // Don't throw - audit logging should not break the main flow
  }
}

// ── Get Recent Audit Entries ─────────────────────────────────────────────────

export async function getAuditEntries(storeId, options = {}) {
  const {
    limitCount = 50,
    staffId = null,
    weekStart = null,
  } = options

  let q = collection(db, 'auditLog', storeId, 'entries')
  const constraints = []

  if (staffId) {
    constraints.push(where('staffId', '==', staffId))
  }

  if (weekStart) {
    constraints.push(where('weekStart', '==', weekStart))
  }

  constraints.push(orderBy('timestamp', 'desc'))
  constraints.push(limit(limitCount))

  const snapshot = await getDocs(query(q, ...constraints))
  return snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))
}

// ── Get Audit Stats ─────────────────────────────────────────────────────────

export async function getAuditStats(storeId) {
  const entries = await getAuditEntries(storeId, { limitCount: 500 })
  
  // Group by week
  const byWeek = {}
  entries.forEach((e) => {
    if (!byWeek[e.weekStart]) byWeek[e.weekStart] = []
    byWeek[e.weekStart].push(e)
  })

  // Most authorized staff
  const byStaff = {}
  entries.forEach((e) => {
    if (!byStaff[e.staffId]) byStaff[e.staffId] = { name: e.staffName, count: 0 }
    byStaff[e.staffId].count++
  })
  const topStaff = Object.entries(byStaff)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([id, data]) => ({ staffId: id, ...data }))

  // Reason breakdown
  const byReason = {}
  entries.forEach((e) => {
    byReason[e.reason] = (byReason[e.reason] || 0) + 1
  })

  return {
    totalEntries: entries.length,
    weeksCovered: Object.keys(byWeek).length,
    topStaff,
    byReason,
  }
}
