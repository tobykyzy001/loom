import { credentialKey } from '@deepseek-ai/dsh-credentials'

export const name = 'loom-credential-seed'
export const inject = ['credentials']

// Test-only setup writes exactly one selected synthetic record through the
// documented public method; an absent record is not replaced by a seed.
export async function apply(ctx, { enabled = false, record_key } = {}) {
  if (!enabled) return
  console.error('[loom-credential-seed] configured for exact test binding')
  if (typeof record_key !== 'string' || !/^refid-[a-z0-9][a-z0-9-]{0,111}$/.test(record_key)) {
    throw new Error('An exact test credential record id is required')
  }
  await ctx.credentials.modifyRecord(credentialKey('loom-local-node', record_key), () => ({
    kind: 'grant', payload: { intent: 'isolated-loomed-test-record', value: 'synthetic-record-never-a-real-credential' },
  }))
  const observed = await ctx.credentials.describeRecord(credentialKey('loom-local-node', record_key))
  console.error('[loom-credential-seed] wrote exact synthetic record', { configured: observed.configured, kind: observed.kind, writable: observed.writable })
  if (observed.configured !== true) throw new Error('Public modifyRecord did not create the requested test record')
}
