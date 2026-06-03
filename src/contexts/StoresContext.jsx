import { createContext, useContext } from 'react'
import { useStores } from '../hooks/useStores'
import { useAor } from './AorContext'

const StoresContext = createContext(null)

export function StoresProvider({ children }) {
  const { aorId } = useAor()
  const storesData = useStores(aorId)
  
  return (
    <StoresContext.Provider value={storesData}>
      {children}
    </StoresContext.Provider>
  )
}

export function useStoresContext() {
  const ctx = useContext(StoresContext)
  if (!ctx) throw new Error('useStoresContext must be used inside StoresProvider')
  return ctx
}
