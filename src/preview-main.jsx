import React from 'react'
import { createRoot } from 'react-dom/client'
import PreviewEmailActionEntry from './PreviewEmailActionEntry'
import './index.css'
import './email-preview.css'

createRoot(document.getElementById('root')).render(<React.StrictMode><PreviewEmailActionEntry /></React.StrictMode>)
