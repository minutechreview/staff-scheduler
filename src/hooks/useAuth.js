import { useState, useEffect } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { auth, googleProvider } from '../firebase'

export function useAuth() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(null)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        // Domain restriction — uncomment and update domain to restrict sign-in
        // if (!firebaseUser.email?.endsWith('@your-company.com')) {
        //   signOut(auth)
        //   setAuthError('Access is restricted to @your-company.com accounts only.')
        //   setUser(null)
        // } else {
          setUser(firebaseUser)
          setAuthError(null)
        // }
      } else {
        setUser(null)
      }
      setLoading(false)
    })

    return unsubscribe
  }, [])

  async function signInWithGoogle() {
    setAuthError(null)
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (error) {
      if (error.code === 'auth/popup-closed-by-user') return
      setAuthError('Sign-in failed. Make sure you use your authorized Google account.')
    }
  }

  async function signOutUser() {
    await signOut(auth)
  }

  return { user, loading, authError, signInWithGoogle, signOutUser }
}
