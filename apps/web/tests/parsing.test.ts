import { describe, expect, it } from 'vitest'
import { artifactFrom, listOf, preferencesFrom, ticketFrom } from '../src/api/parsing'
export {}
describe('bounded display response parsing', () => {
  it('accepts the documented list shape and basic list compatibility', () => {
    expect(listOf({ tickets: [{ id: 'a', status: 'reconciling' }] }, ['tickets'])).toHaveLength(1)
    expect(listOf([], ['projects'])).toEqual([])
    expect(listOf({ error: { code: 'denied' } }, ['projects'])).toEqual([])
  })

  it('does not turn unknown artifact content into HTML', () => {
    const result = artifactFrom({ metadata: { media_type: 'text/plain', size_bytes: 20 }, content: '<h1>safe text</h1>', truncated: true })
    expect(result.content).toBe('<h1>safe text</h1>')
    expect(result.truncated).toBe(true)
  })

  it('preserves cancellation and reconciliation in structured reports', () => {
    const ticket = ticketFrom({ id: 'ticket', status: 'cancel_requested', reports: [{ state: 'cancelled', summary: '节点已确认取消' }, { state: 'reconciling', summary: '待对账' }] })
    expect(ticket.cancel_requested).toBe(true)
    expect(ticket.reports?.map(report => report.status)).toEqual(['cancelled', 'unknown'])
  })

  it('defaults expansion to collapsed', () => {
    expect(preferencesFrom({}).expanded).toBe(false)
    expect(preferencesFrom({ expanded: true, sender_filter: 'worker-id' }).sender_filter).toBe('worker-id')
  })
})
