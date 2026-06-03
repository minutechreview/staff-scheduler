import { createContext, useContext, useState } from 'react'

const RamadanContext = createContext({ ramadan: false, toggleRamadan: () => {} })

export function RamadanProvider({ children }) {
  const [ramadan, setRamadan] = useState(() => localStorage.getItem('ramadanMode') === 'true')

  function toggleRamadan() {
    setRamadan((prev) => {
      const next = !prev
      localStorage.setItem('ramadanMode', String(next))
      return next
    })
  }

  return <RamadanContext.Provider value={{ ramadan, toggleRamadan }}>{children}</RamadanContext.Provider>
}

export function useRamadan() {
  return useContext(RamadanContext)
}
