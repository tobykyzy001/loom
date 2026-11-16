export const TOKEN_KEY = 'loom.client-token'
export const TICKET_KEY = 'loom.selected-ticket'
export const PAGE_KEY = 'loom.selected-page'
const PREF_PREFIX = 'loom.preferences:'

export function localRead(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}

export function localWrite(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch { /* A connection may be useful in a storage-restricted browser. */ }
}

export function cachedExpanded(ticketId?: string): boolean {
  return localRead(PREF_PREFIX + (ticketId ?? 'global')) === 'true'
}
