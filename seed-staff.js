// seed-staff.js
// Seeds example staff data into Firestore for development/demo purposes.
//
// Usage:
//   node seed-staff.js
//
// Requirements:
//   - Copy .env.example to .env and fill in your Firebase credentials
//   - Install dependencies: npm install firebase dotenv

import 'dotenv/config'
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, addDoc, getDocs, deleteDoc } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

// Replace with your actual staff data
// Format: { [storeId]: [{ name, empNo, position, gender }, ...] }
const STAFF_DATA = {
  Store01: [
    { name: 'Alex Johnson', empNo: '001', position: 'SM',  gender: 'Male'   },
    { name: 'Sam Williams', empNo: '002', position: 'ASM', gender: 'Female' },
    { name: 'Jordan Lee',   empNo: '003', position: 'SSV', gender: 'Male'   },
  ],
  Store02: [
    { name: 'Casey Brown',  empNo: '004', position: 'SM',  gender: 'Female' },
    { name: 'Morgan Davis', empNo: '005', position: 'SSV', gender: 'Male'   },
  ],
}

async function seed() {
  for (const [storeId, staff] of Object.entries(STAFF_DATA)) {
    const ref = collection(db, 'stores', storeId, 'roster')

    // Clear existing roster
    const existing = await getDocs(ref)
    for (const doc of existing.docs) await deleteDoc(doc.ref)

    // Add new staff
    for (const member of staff) {
      await addDoc(ref, member)
      console.log(`Added ${member.name} to ${storeId}`)
    }
  }
  console.log('Seeding complete.')
  process.exit(0)
}

seed().catch((err) => { console.error(err); process.exit(1) })
