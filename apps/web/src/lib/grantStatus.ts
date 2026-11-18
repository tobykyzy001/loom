import type { Grant } from '../api/types'

export type DerivedGrantStatus = 'active' | 'revoked' | 'unknown'

/** Read-only view semantics: the persisted revocation timestamp wins over stale status labels. */
export function grantStatus(grant: Pick<Grant, 'status' | 'revoked_at'>): DerivedGrantStatus {
  if ((grant.revoked_at !== null && grant.revoked_at !== undefined) || grant.status === 'revoked') return 'revoked'
  if (grant.status === 'active' || grant.status === undefined) return 'active'
  return 'unknown'
}

export function grantStatusLabel(grant: Pick<Grant, 'status' | 'revoked_at'>): string {
  const status = grantStatus(grant)
  return status === 'revoked' ? '已撤销' : status === 'active' ? '有效' : `未知状态：${grant.status}`
}

export function activeGrantCount(grants: Array<Pick<Grant, 'status' | 'revoked_at'>>): number {
  return grants.filter(grant => grantStatus(grant) === 'active').length
}
