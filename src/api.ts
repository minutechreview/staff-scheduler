let csrf = ''
let acceptanceSecret = ''

// Optional acceptance harness only. Keep the code in this page's memory,
// never in URLs, browser storage or the ordinary product flow.
export function setAcceptanceSecret(value: string) { acceptanceSecret = value }

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

export async function api(path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', signal,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }), ...(acceptanceSecret ? { 'X-Relay-Acceptance': acceptanceSecret } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let content
  try {
    content = await response.json()
  } catch (error) {
    // Refreshes can abort after headers arrive. Preserve cancellation so stale
    // requests never replace domain state with a fabricated success object.
    if (error instanceof Error && error.name === 'AbortError') throw error
    throw new ApiError('The API returned an unreadable response. Reload and try again.', response.ok ? 502 : response.status)
  }
  if (!response.ok) {
    const error = new ApiError(content.error || 'Request failed.', response.status)
    throw error
  }
  if (content.user?.csrf) csrf = content.user.csrf
  if (path === '/signout') acceptanceSecret = ''
  return content
}

export function dayPlus(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

export function firstDay(day: string, first: number): string {
  const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7
  return dayPlus(day, -((weekday - first + 7) % 7))
}

export function today(zone = 'UTC'): string {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (name: string) => values.find(x => x.type === name)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function localDate(value: string, zone: string): string {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  const part = (name: string) => values.find(x => x.type === name)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function clock(value: string, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function duration(shift: { start: string; end: string }): number {
  return (new Date(shift.end).getTime() - new Date(shift.start).getTime()) / 3600000
}

export function dateLabel(day: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
}

export function formData(event: { preventDefault: () => void; currentTarget: HTMLFormElement }): Record<string, FormDataEntryValue> {
  event.preventDefault()
  return Object.fromEntries(new FormData(event.currentTarget))
}
