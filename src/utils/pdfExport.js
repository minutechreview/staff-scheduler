
import { WEEK_DAYS, getWeekDates, formatDate, getWeekNumber } from '../data/stores'
import logoUrl from '../assets/logo.png'

const SHIFT_SHORT = {
  'AM Shift': 'AM',
  'PM Shift': 'PM',
  'Day Off':  'Off',
  'Support':  'Sup',
  'Leave':    'Lve',
  '':         '-',
}

// Brand palette (RGB) — customize these colors to match your brand
const BRAND = {
  brandGreen:  [41,  96,  68],   // #296044 — primary (update to your brand color)
  accentGreen: [50,  115, 78],   // #32734E — hover
  houseGreen:  [36,  56,  50],   // #243832 — header bg
  darkText:    [28,  40,  34],   // near-black text
  bodyBg:      [249, 249, 249],  // #F9F9F9 cool neutral
  altBg:       [240, 247, 243],  // very light green tint
  lightGreen:  [216, 232, 226],  // #D8E8E2 — light accent
  warmNeutral: [242, 240, 235],  // #F2F0EB
  white:       [255, 255, 255],
  headerText:  [200, 220, 210],  // dimmed white for header labels
  mutedText:   [110, 140, 125],
  amBlue:      [37,  99,  235],
  pmIndigo:    [99,  102, 241],
  offGray:     [107, 114, 128],
  supportAmber:[180, 110, 10],
  leaveRed:    [185, 28,  28],
}

function shiftFill(value) {
  switch (value) {
    case 'AM Shift': return { bg: [209, 236, 218], text: [22, 101, 52]  }  // light green / dark green text
    case 'PM Shift': return { bg: [255, 237, 180], text: [146, 64, 14]  }  // warm yellow / amber text
    case 'Day Off':  return { bg: [243, 244, 246], text: [107, 114, 128] }  // gray-100 / gray-500
    case 'Support':  return { bg: [254, 215, 170], text: [154, 52, 18]  }  // orange-200 / orange-800
    case 'Leave':    return { bg: [254, 202, 202], text: [185, 28, 28]  }  // red-200 / red-700
    default:         return { bg: BRAND.bodyBg,      text: BRAND.mutedText  }
  }
}

// Loads logo and clips it to a circle using canvas — returns a PNG data URL with transparency
async function loadLogo() {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const size = Math.min(img.width, img.height)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(img, 0, 0, size, size)
      resolve(canvas.toDataURL('image/png'))
    }
    img.src = logoUrl
  })
}

function drawHeader(doc, logo, title, subtitle, weekNo) {
  const W = 297

  // Light warm neutral page background
  doc.setFillColor(...BRAND.warmNeutral)
  doc.rect(0, 0, W, 210, 'F')

  // Dark green header band
  doc.setFillColor(...BRAND.houseGreen)
  doc.rect(0, 0, W, 34, 'F')

  // Circular logo — canvas already clipped it, PNG has transparency
  doc.addImage(logo, 'PNG', 8, 5, 24, 24, '', 'FAST')

  // Title
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(15)
  doc.setTextColor(...BRAND.white)
  doc.text(title, 37, 15)

  // Subtitle
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.setTextColor(...BRAND.lightGreen)
  doc.text(subtitle, 37, 24)

  // Week badge (top-right)
  doc.setFillColor(...BRAND.brandGreen)
  doc.roundedRect(263, 10, 26, 12, 2, 2, 'F')
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(9)
  doc.setTextColor(...BRAND.white)
  doc.text(`WK ${weekNo}`, 276, 17.5, { align: 'center' })
}

function addFooter(doc, weekNo) {
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFillColor(...BRAND.houseGreen)
    doc.rect(0, 203, 297, 7, 'F')
    doc.setFontSize(6.5)
    doc.setTextColor(...BRAND.lightGreen)
    doc.setFont('helvetica', 'normal')
    doc.text(
      `RetailCo  |  Store Scheduler  |  Week ${weekNo}  |  Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      14, 207.5
    )
    doc.text(`${i} / ${pageCount}`, 283, 207.5, { align: 'right' })
  }
}

export async function exportSupportPoolPDF(poolEntries, weekStart) {
  const weekDates = getWeekDates(weekStart)
  const weekNo = getWeekNumber(weekStart)
  const logo = await loadLogo()

  const { default: jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  drawHeader(
    doc, logo,
    'SUPPORT POOL',
    `Week ${weekNo}  |  ${formatDate(weekDates[0])} - ${formatDate(weekDates[6])}  |  ${poolEntries.length} assignments`,
    weekNo
  )

  const head = [[
    { content: '#',          styles: { halign: 'center' } },
    { content: 'Staff' },
    { content: 'Pos',        styles: { halign: 'center' } },
    { content: 'Home Store' },
    { content: 'Supporting' },
    { content: 'Days' },
  ]]

  const body = poolEntries.map((entry, idx) => [
    { content: String(idx + 1), styles: { halign: 'center', textColor: BRAND.mutedText } },
    { content: entry.staffName, styles: { fontStyle: 'bold', textColor: BRAND.darkText } },
    { content: entry.position || '', styles: { halign: 'center', textColor: BRAND.mutedText } },
    { content: entry.homeStoreName, styles: { textColor: BRAND.mutedText } },
    { content: '-> ' + entry.destStoreName, styles: { textColor: BRAND.brandGreen, fontStyle: 'bold' } },
    { content: entry.days.join(', '), styles: { textColor: BRAND.mutedText } },
  ])

  autoTable(doc, {
    head, body,
    startY: 36,
    margin: { left: 14, right: 14 },
    styles: {
      fillColor: BRAND.bodyBg,
      textColor: BRAND.darkText,
      fontSize: 8.5,
      cellPadding: 3.5,
      lineColor: BRAND.lightGreen,
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: BRAND.brandGreen,
      textColor: BRAND.white,
      fontSize: 8,
      fontStyle: 'bold',
      cellPadding: 3,
    },
    alternateRowStyles: { fillColor: BRAND.altBg },
  })

  addFooter(doc, weekNo)
  doc.save(`support_pool_week${weekNo}_${weekStart}.pdf`)
}

export async function exportStorePDF(store, staff, visitors, scheduleEntries, weekStart, dayNotes = {}) {
  const weekDates = getWeekDates(weekStart)
  const weekNo = getWeekNumber(weekStart)
  const logo = await loadLogo()

  const { default: jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  drawHeader(
    doc, logo,
    store.name.toUpperCase(),
    `Week ${weekNo}  |  ${formatDate(weekDates[0])} - ${formatDate(weekDates[6])}  |  Min: ${store.minAM} AM / ${store.minPM} PM  |  ${staff.length} staff`,
    weekNo
  )

  const allStaff = [
    ...staff,
    ...(visitors || []).map((v) => ({ ...v, isVisitor: true })),
  ]

  const head = [[
    { content: '#',       styles: { halign: 'center' } },
    { content: 'Name' },
    { content: 'Pos',     styles: { halign: 'center' } },
    ...WEEK_DAYS.map((day, i) => ({
      content: `${day}\n${formatDate(weekDates[i])}`,
      styles: { halign: 'center' },
    })),
    { content: 'Remarks' },
  ]]

  const amCounts = WEEK_DAYS.map((day) =>
    allStaff.filter((s) => scheduleEntries[s.id]?.[day] === 'AM Shift').length
  )
  const pmCounts = WEEK_DAYS.map((day) =>
    allStaff.filter((s) => scheduleEntries[s.id]?.[day] === 'PM Shift').length
  )

  const countRowStyle = { fillColor: [235, 245, 240], fontStyle: 'bold' }

  const noteRowStyle = { fillColor: [255, 252, 235], fontStyle: 'italic' }

  const body = [
    // Day notes row
    [
      { content: '', styles: noteRowStyle },
      { content: 'Day Notes', styles: { ...noteRowStyle, textColor: BRAND.mutedText, fontStyle: 'italic' } },
      { content: '', styles: noteRowStyle },
      ...WEEK_DAYS.map((day) => ({
        content: dayNotes[day] || '',
        styles: { ...noteRowStyle, halign: 'center', textColor: [120, 100, 40], fontSize: 7 },
      })),
      { content: '', styles: noteRowStyle },
    ],
    // AM count row
    [
      { content: '', styles: countRowStyle },
      { content: 'AM Shift Count', styles: { ...countRowStyle, textColor: BRAND.amBlue } },
      { content: '', styles: countRowStyle },
      ...amCounts.map((count) => ({
        content: `${count}/${store.minAM}`,
        styles: {
          ...countRowStyle,
          halign: 'center',
          textColor: count >= store.minAM ? [22, 163, 74] : [220, 38, 38],
        },
      })),
      { content: `Min: ${store.minAM}`, styles: { ...countRowStyle, textColor: BRAND.mutedText, fontStyle: 'normal' } },
    ],
    // PM count row
    [
      { content: '', styles: countRowStyle },
      { content: 'PM Shift Count', styles: { ...countRowStyle, textColor: BRAND.pmIndigo } },
      { content: '', styles: countRowStyle },
      ...pmCounts.map((count) => ({
        content: `${count}/${store.minPM}`,
        styles: {
          ...countRowStyle,
          halign: 'center',
          textColor: count >= store.minPM ? [22, 163, 74] : [220, 38, 38],
        },
      })),
      { content: `Min: ${store.minPM}`, styles: { ...countRowStyle, textColor: BRAND.mutedText, fontStyle: 'normal' } },
    ],
    // Staff rows
    ...staff.map((member, idx) => {
      const entry = scheduleEntries[member.id] || {}
      return [
        { content: String(idx + 1), styles: { halign: 'center', textColor: BRAND.mutedText } },
        { content: member.name, styles: { fontStyle: 'bold', textColor: BRAND.darkText } },
        { content: member.position || '', styles: { halign: 'center', textColor: BRAND.mutedText, fontSize: 7.5 } },
        ...WEEK_DAYS.map((day) => {
          const shiftValue = entry[day] || ''
          const { bg, text } = shiftFill(shiftValue)
          return {
            content: SHIFT_SHORT[shiftValue] || '-',
            styles: { halign: 'center', fillColor: bg, textColor: text, fontStyle: 'bold' },
          }
        }),
        { content: entry.remarks || '', styles: { textColor: BRAND.mutedText, fontSize: 7.5 } },
      ]
    }),
    // Visitor rows
    ...(visitors && visitors.length > 0 ? [
      [{
        content: 'SUPPORT IN',
        colSpan: 10,
        styles: { fillColor: [255, 243, 205], textColor: [146, 64, 14], fontStyle: 'bold', fontSize: 7.5 },
      }],
      ...visitors.map((member, idx) => {
        const entry = scheduleEntries[member.id] || {}
        return [
          { content: `S${idx + 1}`, styles: { halign: 'center', textColor: BRAND.supportAmber } },
          { content: member.name + ' (via)', styles: { fontStyle: 'bold', textColor: [146, 64, 14] } },
          { content: member.position || '', styles: { halign: 'center', textColor: BRAND.mutedText, fontSize: 7.5 } },
          ...WEEK_DAYS.map((day) => {
            const shiftValue = entry[day] || ''
            const { bg, text } = shiftFill(shiftValue)
            return {
              content: SHIFT_SHORT[shiftValue] || '-',
              styles: { halign: 'center', fillColor: bg, textColor: text, fontStyle: 'bold' },
            }
          }),
          { content: member.homeStoreName || '', styles: { textColor: BRAND.supportAmber, fontSize: 7.5 } },
        ]
      }),
    ] : []),
  ]

  autoTable(doc, {
    head, body,
    startY: 36,
    margin: { left: 14, right: 14 },
    styles: {
      fillColor: BRAND.bodyBg,
      textColor: BRAND.darkText,
      fontSize: 8.5,
      cellPadding: 3,
      lineColor: BRAND.lightGreen,
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: BRAND.brandGreen,
      textColor: BRAND.white,
      fontSize: 8,
      fontStyle: 'bold',
      cellPadding: 3,
    },
    alternateRowStyles: { fillColor: BRAND.altBg },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 46 },
      2: { cellWidth: 13 },
      9: { cellWidth: 32 },
    },
  })

  addFooter(doc, weekNo)
  doc.save(`${store.id}_week${weekNo}_${weekStart}.pdf`)
}

/**
 * Same as exportStorePDF but returns a Blob instead of triggering a download.
 * Used for Web Share API (share sheet).
 */
export async function getStorePDFBlob(store, staff, visitors, scheduleEntries, weekStart, dayNotes = {}) {
  const weekDates = getWeekDates(weekStart)
  const weekNo = getWeekNumber(weekStart)
  const logo = await loadLogo()

  const { default: jsPDF } = await import('jspdf')
  const { default: autoTable } = await import('jspdf-autotable')

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

  drawHeader(
    doc, logo,
    store.name.toUpperCase(),
    `Week ${weekNo}  |  ${formatDate(weekDates[0])} - ${formatDate(weekDates[6])}  |  Min: ${store.minAM} AM / ${store.minPM} PM  |  ${staff.length} staff`,
    weekNo
  )

  const allStaff = [
    ...staff,
    ...(visitors || []).map((v) => ({ ...v, isVisitor: true })),
  ]

  const head = [[
    { content: '#',       styles: { halign: 'center' } },
    { content: 'Name' },
    { content: 'Pos',     styles: { halign: 'center' } },
    ...WEEK_DAYS.map((day, i) => ({
      content: `${day}\n${formatDate(weekDates[i])}`,
      styles: { halign: 'center' },
    })),
    { content: 'Remarks' },
  ]]

  const amCounts = WEEK_DAYS.map((day) =>
    allStaff.filter((s) => scheduleEntries[s.id]?.[day] === 'AM Shift').length
  )
  const pmCounts = WEEK_DAYS.map((day) =>
    allStaff.filter((s) => scheduleEntries[s.id]?.[day] === 'PM Shift').length
  )

  const countRowStyle = { fillColor: [235, 245, 240], fontStyle: 'bold' }
  const noteRowStyle = { fillColor: [255, 252, 235], fontStyle: 'italic' }

  const body = [
    [
      { content: '', styles: noteRowStyle },
      { content: 'Day Notes', styles: { ...noteRowStyle, textColor: BRAND.mutedText, fontStyle: 'italic' } },
      { content: '', styles: noteRowStyle },
      ...WEEK_DAYS.map((day) => ({
        content: dayNotes[day] || '',
        styles: { ...noteRowStyle, halign: 'center', textColor: [120, 100, 40], fontSize: 7 },
      })),
      { content: '', styles: noteRowStyle },
    ],
    [
      { content: '', styles: countRowStyle },
      { content: 'AM Shift Count', styles: { ...countRowStyle, textColor: BRAND.amBlue } },
      { content: '', styles: countRowStyle },
      ...amCounts.map((count) => ({
        content: `${count}/${store.minAM}`,
        styles: {
          ...countRowStyle,
          halign: 'center',
          textColor: count >= store.minAM ? [22, 163, 74] : [220, 38, 38],
        },
      })),
      { content: `Min: ${store.minAM}`, styles: { ...countRowStyle, textColor: BRAND.mutedText, fontStyle: 'normal' } },
    ],
    [
      { content: '', styles: countRowStyle },
      { content: 'PM Shift Count', styles: { ...countRowStyle, textColor: BRAND.pmIndigo } },
      { content: '', styles: countRowStyle },
      ...pmCounts.map((count) => ({
        content: `${count}/${store.minPM}`,
        styles: {
          ...countRowStyle,
          halign: 'center',
          textColor: count >= store.minPM ? [22, 163, 74] : [220, 38, 38],
        },
      })),
      { content: `Min: ${store.minPM}`, styles: { ...countRowStyle, textColor: BRAND.mutedText, fontStyle: 'normal' } },
    ],
    ...staff.map((member, idx) => {
      const entry = scheduleEntries[member.id] || {}
      return [
        { content: String(idx + 1), styles: { halign: 'center', textColor: BRAND.mutedText } },
        { content: member.name, styles: { fontStyle: 'bold', textColor: BRAND.darkText } },
        { content: member.position || '', styles: { halign: 'center', textColor: BRAND.mutedText, fontSize: 7.5 } },
        ...WEEK_DAYS.map((day) => {
          const shiftValue = entry[day] || ''
          const { bg, text } = shiftFill(shiftValue)
          return {
            content: SHIFT_SHORT[shiftValue] || '-',
            styles: { halign: 'center', fillColor: bg, textColor: text, fontStyle: 'bold' },
          }
        }),
        { content: entry.remarks || '', styles: { textColor: BRAND.mutedText, fontSize: 7.5 } },
      ]
    }),
    ...(visitors && visitors.length > 0 ? [
      [{
        content: 'SUPPORT IN',
        colSpan: 10,
        styles: { fillColor: [255, 243, 205], textColor: [146, 64, 14], fontStyle: 'bold', fontSize: 7.5 },
      }],
      ...visitors.map((member, idx) => {
        const entry = scheduleEntries[member.id] || {}
        return [
          { content: `S${idx + 1}`, styles: { halign: 'center', textColor: BRAND.supportAmber } },
          { content: member.name + ' (via)', styles: { fontStyle: 'bold', textColor: [146, 64, 14] } },
          { content: member.position || '', styles: { halign: 'center', textColor: BRAND.mutedText, fontSize: 7.5 } },
          ...WEEK_DAYS.map((day) => {
            const shiftValue = entry[day] || ''
            const { bg, text } = shiftFill(shiftValue)
            return {
              content: SHIFT_SHORT[shiftValue] || '-',
              styles: { halign: 'center', fillColor: bg, textColor: text, fontStyle: 'bold' },
            }
          }),
          { content: member.homeStoreName || '', styles: { textColor: BRAND.supportAmber, fontSize: 7.5 } },
        ]
      }),
    ] : []),
  ]

  autoTable(doc, {
    head, body,
    startY: 36,
    margin: { left: 14, right: 14 },
    styles: {
      fillColor: BRAND.bodyBg,
      textColor: BRAND.darkText,
      fontSize: 8.5,
      cellPadding: 3,
      lineColor: BRAND.lightGreen,
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: BRAND.brandGreen,
      textColor: BRAND.white,
      fontSize: 8,
      fontStyle: 'bold',
      cellPadding: 3,
    },
    alternateRowStyles: { fillColor: BRAND.altBg },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 46 },
      2: { cellWidth: 13 },
      9: { cellWidth: 32 },
    },
  })

  addFooter(doc, weekNo)
  return doc.output('blob')
}
