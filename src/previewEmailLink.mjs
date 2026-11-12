import { parseEmailAction } from './emailActions.mjs'

export async function parsePreviewEmailLink(raw, config) {
  const invalid = () => { throw new Error('Use the original verification or reset link for this staging project. Nothing was submitted.') }
  if (typeof raw !== 'string' || raw.length > 4096) return invalid()
  let url, expected
  try { url = new URL(raw.trim()); expected = new URL(config.provider_callback) } catch { return invalid() }
  if (url.protocol !== 'https:' || url.origin !== expected.origin || url.pathname !== expected.pathname ||
      url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].some(key => !['mode', 'oobCode', 'apiKey', 'continueUrl', 'lang'].includes(key))) return invalid()
  const action = parseEmailAction(url.href)
  if (!action || action.error || !url.searchParams.get('apiKey')) return invalid()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.searchParams.get('apiKey')))
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (hex !== config.api_key_sha256) return invalid()
  return action
}
