// Incoming links are data, never provider configuration or redirect targets.
export function parseEmailAction(href) {
  const url = new URL(href)
  const params = url.searchParams
  const actionKeys = ['mode', 'oobCode', 'apiKey', 'continueUrl', 'tenantId']
  const fragmentAction = /(?:mode|oobCode)=/.test(url.hash)
  if (!actionKeys.some(key => params.has(key)) && !fragmentAction) return null
  const invalid = message => ({ mode: null, code: '', error: message })
  if (url.search.length > 4096 || [...params].length > 20 || fragmentAction) return invalid('This email link is invalid. Reopen the original message or request a new link.')
  const keys = [...params.keys()]
  if (new Set(keys).size !== keys.length || params.has('tenantId')) return invalid('This email link is ambiguous or belongs to an unsupported identity tenant.')
  const mode = params.get('mode'), code = params.get('oobCode') || ''
  if (!['verifyEmail', 'resetPassword'].includes(mode)) return invalid('This email action is unsupported. Return to sign in or contact your administrator.')
  if (!/^[\x21-\x7e]{1,1024}$/.test(code)) return invalid('This email link is invalid. Reopen the original message or request a new link.')
  // apiKey, continueUrl and lang are intentionally not returned. The backend
  // uses its pinned project; completion always stays in this application.
  return { mode, code, error: '' }
}
