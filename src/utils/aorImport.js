import { doc, setDoc, writeBatch, collection } from 'firebase/firestore'
import { db } from '../firebase'

/**
 * importAreaFromExcel
 * 
 * Logic:
 * 1. Reads a "Stores" sheet to create the AOR structure.
 * 2. Looks for individual store sheets to populate rosters.
 * 
 * Expected Excel structure:
 * Sheet "STORES": [Name, Category, MinAM, MinPM]
 * Sheet "StoreName": [#, Name, EmpNo, Position, Gender, ...]
 */
export async function importAreaFromExcel(file, aorId) {
  const { read, utils } = await import('xlsx')
  const arrayBuffer = await file.arrayBuffer()
  const workbook = read(arrayBuffer, { type: 'array' })

  const results = { stores: 0, staff: 0 }
  
  // 1. Process "STORES" summary sheet
  const storesSheet = workbook.Sheets['STORES'] || workbook.Sheets[workbook.SheetNames[0]]
  const storeRows = utils.sheet_to_json(storesSheet, { defval: null })
  
  const batch = writeBatch(db)
  const createdStoreIds = []

  for (const row of storeRows) {
    const name = row['Store Name'] || row['Name'] || row['Store']
    if (!name) continue

    const id = String(name).replace(/\s+/g, '')
    const storeData = {
      id,
      name,
      aorId,
      storeCategory: row['Category'] || 'regular',
      minAM: parseInt(row['Min AM'] || 6),
      minPM: parseInt(row['Min PM'] || 6),
      type: 'Retail',
      location: 'Regional'
    }

    batch.set(doc(db, 'stores', id), storeData)
    createdStoreIds.push({ id, name })
    results.stores++
  }

  await batch.commit()

  // 2. Process Rosters (find sheets matching created store names)
  for (const { id, name } of createdStoreIds) {
    // Exact match or name without spaces
    const sheetName = workbook.SheetNames.find(sn => 
      sn.toLowerCase() === name.toLowerCase() || 
      sn.toLowerCase() === id.toLowerCase()
    )

    if (sheetName) {
      const sheet = workbook.Sheets[sheetName]
      const rows = utils.sheet_to_json(sheet, { header: 1, defval: null })
      
      const rosterBatch = writeBatch(db)
      let staffCount = 0

      // Assume standard format: Row 8 starts data (index 7 if header was row 8)
      // We'll search for rows where the first column is a number
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        if (!row || typeof row[0] !== 'number' || !row[1]) continue

        const staffName = String(row[1]).trim()
        const staffId = staffName.replace(/\s+/g, '_').toLowerCase().slice(0, 30)
        
        const staffData = {
          name: staffName,
          empNo: String(row[2] || ''),
          position: row[3] || 'B',
          gender: row[4] || '',
          order: staffCount + 1
        }

        rosterBatch.set(doc(db, 'schedules', id, 'roster', staffId), staffData)
        staffCount++
      }

      if (staffCount > 0) {
        await rosterBatch.commit()
        results.staff += staffCount
      }
    }
  }

  return results
}

/**
 * generateAorTemplate
 * Creates a downloadable Excel blob for the regional import.
 */
export async function generateAorTemplate() {
  const { utils, write } = await import('xlsx')
  
  // Sheet 1: STORES Summary
  const storesData = [
    { 'Store Name': 'Assima Mall', 'Category': 'regular', 'Min AM': 6, 'Min PM': 6 },
    { 'Store Name': 'Shaheed Park', 'Category': 'regular', 'Min AM': 5, 'Min PM': 5 },
    { 'Store Name': 'Tijaria Tower', 'Category': 'regular', 'Min AM': 4, 'Min PM': 4 },
  ]
  const wsStores = utils.json_to_sheet(storesData)

  // Sheet 2: Example Store Roster (Matches 'Assima Mall')
  const rosterData = [
    ['#', 'Name', 'EmpNo', 'Position', 'Gender'],
    [1, 'Ahmed Ali', '2001', 'SM', 'Male'],
    [2, 'Sara Khan', '2002', 'B', 'Female'],
  ]
  const wsRoster = utils.aoa_to_sheet(rosterData)

  const wb = utils.book_new()
  utils.book_append_sheet(wb, wsStores, 'STORES')
  utils.book_append_sheet(wb, wsRoster, 'Assima Mall')
  
  const wbout = write(wb, { type: 'array', bookType: 'xlsx' })
  return new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
