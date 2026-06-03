import { useState, useEffect } from 'react'
import { collection, query, where, onSnapshot, doc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { STORES as STATIC_STORES } from '../data/stores'

/**
 * useStores hook
 * Now fetches stores from the 'stores' collection, filtered by AOR.
 * It also maintains a legacy 'config/storeSettings' for AOR-wide overrides if needed,
 * but primarily relies on the 'stores' collection for metadata.
 */
export function useStores(aorId) {
  const [stores, setStores] = useState([])
  const [loadedAorId, setLoadedAorId] = useState(null)
  const loading = !!aorId && loadedAorId !== aorId

  useEffect(() => {
    // If no aorId is provided, we can't fetch stores (except as a Global Admin - to be added)
    if (!aorId) {
      return
    }

    // Query stores for this AOR
    const storesRef = collection(db, 'stores')
    const q = query(storesRef, where('aorId', '==', aorId))

    const unsubscribe = onSnapshot(q, (snap) => {
      const storesData = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      
      // If this AOR is empty (first time), seed it with the default store list
      if (storesData.length === 0) {
        const seedData = async () => {
          for (const s of STATIC_STORES) {
            await setDoc(doc(db, 'stores', s.id), { ...s, aorId })
          }
        }
        seedData()
      } else {
        setStores(storesData)
        setLoadedAorId(aorId)
      }
    }, (err) => {
      console.error('[useStores] Fetch error:', err)
      setLoadedAorId(aorId)
    })

    return () => unsubscribe()
  }, [aorId])

  async function addStore(storeData) {
    if (!aorId) return
    const id = storeData.id || storeData.name.replace(/\s+/g, '')
    await setDoc(doc(db, 'stores', id), { ...storeData, id, aorId })
  }

  async function removeStore(storeId) {
    // We should probably just deactivate rather than delete, but following current pattern
    const docRef = doc(db, 'stores', storeId)
    // Security rules will handle the 'owned by AOR' check
    await setDoc(docRef, { deleted: true }, { merge: true }) 
  }

  async function updateStore(storeId, updates) {
    if (!storeId) return
    await setDoc(doc(db, 'stores', storeId), updates, { merge: true })
  }

  return { stores, loading, addStore, removeStore, updateStore }
}
