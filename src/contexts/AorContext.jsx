import { createContext, useContext, useState, useEffect } from 'react'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '../firebase'

const AorContext = createContext(null)

export function AorProvider({ user, children }) {
  const [role, setRole] = useState(null) // 'ADMIN' | 'DM' | 'SM'
  const [aorId, setAorId] = useState(null)
  const [storeId, setStoreId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [aorData, setAorData] = useState(null)

  useEffect(() => {
    if (!user) {
      setRole(null)
      setAorId(null)
      setStoreId(null)
      setAorData(null)
      setLoading(false)
      return
    }

    async function fetchProfile() {
      setLoading(true)
      try {
        const userRef = doc(db, 'users', user.email)
        const userSnap = await getDoc(userRef)

        if (userSnap.exists()) {
          const profile = userSnap.data()
          setRole(profile.role)
          setAorId(profile.aorId)
          setStoreId(profile.storeId)

          if (profile.aorId) {
            const aorSnap = await getDoc(doc(db, 'aors', profile.aorId))
            if (aorSnap.exists()) {
              setAorData(aorSnap.data())
            }
          }
        } else {
          // New user, onboarding will handle setting profile
          setRole(null)
          setAorId(null)
          setStoreId(null)
          setAorData(null)
        }
      } catch (err) {
        console.error('[AorContext] Error fetching profile:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchProfile()
  }, [user])

  async function updateProfile(profileData) {
    if (!user) return
    const userRef = doc(db, 'users', user.email)
    await setDoc(userRef, profileData, { merge: true })
    
    setRole(profileData.role || role)
    setAorId(profileData.aorId || aorId)
    setStoreId(profileData.storeId || storeId)

    if (profileData.aorId) {
      const aorSnap = await getDoc(doc(db, 'aors', profileData.aorId))
      if (aorSnap.exists()) setAorData(aorSnap.data())
    }
  }

  const value = {
    role,
    aorId,
    storeId,
    aorData,
    loading,
    updateProfile,
    isDM: role === 'DM' || role === 'ADMIN' || role === 'AOR_ADMIN',
    isAdmin: role === 'ADMIN',
    isAuthenticated: !!role,
  }

  return <AorContext.Provider value={value}>{children}</AorContext.Provider>
}

export function useAor() {
  const ctx = useContext(AorContext)
  if (!ctx) throw new Error('useAor must be used inside AorProvider')
  return ctx
}
