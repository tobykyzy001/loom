import type { GrantOperation } from '../api/types'

export interface GrantSelection {
  project_id: string
  operations: GrantOperation[]
  node_id?: string
}

/** The current API accepts read_write as a normalized array entry, not only a legacy string. */
export function selectedGrantOperations(read: boolean, write: boolean): GrantOperation[] {
  // Both permissions are represented explicitly in one current-API array entry.
  // The checked read box is disabled because write implies the required read permission.
  if (write) return ['read_write']
  return read ? ['read_summary'] : []
}

const operationLabels: Record<string, string> = {
  read_write: '读取 + 写入（read_write）',
  read_summary: '读取目录并生成摘要',
  read: '读取',
  edit_file: '写入文件',
  write: '写入',
}

export function grantOperationLabel(operation: string): string {
  return operationLabels[operation] ?? `未知操作：${operation}`
}

export function grantOperationsSummary(operations: string[]): string {
  return operations.map(grantOperationLabel).join('、')
}
