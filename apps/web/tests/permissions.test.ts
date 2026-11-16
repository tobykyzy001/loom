import { describe, expect, it } from 'vitest'
import { grantOperationLabel, grantOperationsSummary, selectedGrantOperations } from '../src/lib/permissions'

describe('grant creation and records', () => {
  it('sends the normalized read_write array when both read and write are selected', () => {
    expect(selectedGrantOperations(true, true)).toEqual(['read_write'])
    expect(grantOperationsSummary(selectedGrantOperations(true, true))).toContain('读取 + 写入')
  })

  it('keeps a read-only grant distinct and requires an explicit operation', () => {
    expect(selectedGrantOperations(true, false)).toEqual(['read_summary'])
    expect(selectedGrantOperations(false, false)).toEqual([])
    expect(grantOperationLabel('read_summary')).toBe('读取目录并生成摘要')
  })

  it('does not disguise unknown server operations as a safe permission', () => {
    expect(grantOperationLabel('admin_all')).toBe('未知操作：admin_all')
  })
})
