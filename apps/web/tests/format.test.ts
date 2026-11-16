import { describe, expect, it } from 'vitest'
import { reportStatusLabel, reportStatusTone, safeRelativePath, statusLabel, statusLabels, statusTone } from '../src/lib/format'

describe('M0 status and relative paths', () => {
  it('does not interpret waiting approval or reconciliation as success', () => {
    expect(statusLabels.waiting_approval).toBe('等待批准')
    expect(statusLabels.reconciling).toBe('待对账')
    expect(statusTone.reconciling).toBe('waiting')
    expect(statusTone.failed).toBe('danger')
    expect(Object.values(statusTone).filter(value => value === 'success')).toEqual(['success'])
  })

  it('does not label cancellation reports or transient cancellation as running', () => {
    expect(reportStatusLabel('cancelled')).toBe('已取消报告')
    expect(reportStatusTone('cancelled')).toBe('neutral')
    expect(reportStatusLabel('unknown')).toBe('结果未知')
    expect(statusLabel('cancel_requested')).toBe('取消中')
  })

  it('allows only true UTF8 project-relative paths', () => {
    expect(safeRelativePath('reports/季度摘要.md')).toBe(true)
    expect(safeRelativePath('note.txt')).toBe(true)
    expect(safeRelativePath('../secrets')).toBe(false)
    expect(safeRelativePath('nested/../file')).toBe(false)
    expect(safeRelativePath('/absolute')).toBe(false)
    expect(safeRelativePath('C:\\Windows')).toBe(false)
    expect(safeRelativePath('C:/Windows')).toBe(false)
    expect(safeRelativePath('./file')).toBe(false)
    expect(safeRelativePath('folder/')).toBe(false)
    expect(safeRelativePath('folder//file')).toBe(false)
    expect(safeRelativePath('')).toBe(false)
  })
})
