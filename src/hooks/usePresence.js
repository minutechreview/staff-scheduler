import { useState, useEffect, useRef } from 'react'
import { doc, setDoc, onSnapshot, deleteDoc, collection, getDocs } from 'firebase/firestore'
import { db } from '../firebase'

// TTL for presence docs: 30 seconds
const PRESENCE_TTL_SECONDS = 30
const HEARTBEAT_INTERVAL_MS = 15000 // Update every 15 seconds

// Generate a simple user identifier
function getOrCreateUserId() {
  let userId = sessionStorage.getItem('scheduler_user_id')
  if (!userId) {
    userId = `user_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`
    sessionStorage.setItem('scheduler_user_id', userId)
  }
  return userId
}

// Hook for tracking presence in a store/week view
export function usePresence(storeId, weekStart) {
  const [viewers, setViewers] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const userIdRef = useRef(getOrCreateUserId())
  const heartbeatRef = useRef(null)
  const cleanupRef = useRef(null)

  // Set up presence tracking
  useEffect(() => {
    if (!storeId || !weekStart) return

    const presencePath = `presence/${storeId}/${weekStart}`
    const userDoc = doc(db, presencePath, userIdRef.current)
    const presenceCol = collection(db, presencePath)

    // Write initial presence
    const writePresence = async () => {
      try {
        await setDoc(userDoc, {
          userId: userIdRef.current,
          storeId,
          lastSeen: Date.now(),
          expiresAt: Date.now() + PRESENCE_TTL_SECONDS * 1000,
        }, { merge: true })
      } catch (err) {
        // Silently ignore errors (Firestore may not be available)
        console.debug('Presence write failed:', err)
      }
    }

    // Listen to all viewers
    const unsubscribe = onSnapshot(presenceCol, (snapshot) => {
      const now = Date.now()
      const activeViewers = []
      
      snapshot.docs.forEach((docSnap) => {
        const data = docSnap.data()
        // Only include if:
        // 1. It's not the current user
        // 2. Last seen was within TTL
        if (data.userId !== userIdRef.current && data.lastSeen > now - PRESENCE_TTL_SECONDS * 1000) {
          activeViewers.push({
            userId: data.userId,
            lastSeen: data.lastSeen,
            // Generate a simple color based on userId
            color: getViewerColor(data.userId),
          })
        }
      })
      
      setViewers(activeViewers)
      setIsLoading(false)
    }, (err) => {
      // Listen errors are non-fatal
      console.debug('Presence listener error:', err)
      setIsLoading(false)
    })

    // Initial write
    writePresence()

    // Set up heartbeat
    heartbeatRef.current = setInterval(writePresence, HEARTBEAT_INTERVAL_MS)

    // Clean up old entries periodically (run on mount, then every minute)
    const cleanupOldEntries = async () => {
      try {
        const now = Date.now()
        const cutoff = now - PRESENCE_TTL_SECONDS * 1000 * 2 // Double TTL for safety
        
        // Get all docs and delete expired ones
        const snapshot = await getDocs(presenceCol)
        const deletePromises = snapshot.docs
          .filter((docSnap) => {
            const data = docSnap.data()
            return data.lastSeen < cutoff
          })
          .map((docSnap) => deleteDoc(doc(docSnap.ref.path)))
        
        await Promise.all(deletePromises)
      } catch (err) {
        console.debug('Presence cleanup failed:', err)
      }
    }

    // Run cleanup now and then every minute
    cleanupOldEntries()
    cleanupRef.current = setInterval(cleanupOldEntries, 60000)

    // Clean up on unmount
    return () => {
      clearInterval(heartbeatRef.current)
      clearInterval(cleanupRef.current)
      
      // Remove this user's presence doc
      deleteDoc(userDoc).catch(() => {})
      
      unsubscribe()
    }
  }, [storeId, weekStart])

  return { viewers, isLoading }
}

// Generate a consistent color based on userId
function getViewerColor(userId) {
  const colors = [
    { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/40' },
    { bg: 'bg-purple-500/20', text: 'text-purple-400', border: 'border-purple-500/40' },
    { bg: 'bg-pink-500/20', text: 'text-pink-400', border: 'border-pink-500/40' },
    { bg: 'bg-cyan-500/20', text: 'text-cyan-400', border: 'border-cyan-500/40' },
    { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/40' },
    { bg: 'bg-orange-500/20', text: 'text-orange-400', border: 'border-orange-500/40' },
  ]
  
  // Simple hash of userId to get consistent index
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i)
    hash = hash & hash // Convert to 32bit integer
  }
  
  return colors[Math.abs(hash) % colors.length]
}
