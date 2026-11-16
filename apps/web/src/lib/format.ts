import type { TicketStatus } from '../api/types'

export const statusLabels: Record<TicketStatus, string> = {
  pending: '待执行',
  running: '执行中',
  waiting_approval: '等待批准',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  reconciling: '待对账',
}

export const statusTone: Record<TicketStatus, string> = {
  pending: 'waiting', running: 'active', waiting_approval: 'waiting', succeeded: 'success',
  failed: 'danger', cancelled: 'neutral', reconciling: 'waiting',
}

export function statusLabel(status: string): string {
  if (status === 'cancel_requested') return '取消中'
  return (statusLabels as Record<string, string>)[status] ?? `未知状态：${status}`
}
export function statusToneFor(status: string): string {
  if (status === 'cancel_requested') return 'waiting'
  return (statusTone as Record<string, string>)[status] ?? 'waiting'
}

export function formatTime(value?: string, full = false): string {
  if (!value) return '尚未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    ...(full ? { year: 'numeric', second: '2-digit' } : {}),
  }).format(date)
}

export function formatBytes(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '大小未知'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

export function nodeConnected(status?: string): boolean {
  return ['online', 'busy', 'degraded'].includes(status ?? '')
}

export function capabilityName(capability: string | Record<string, unknown>): string {
  if (typeof capability === 'string') return capability
  const candidate = capability.ticket_kind ?? capability.name ?? capability.kind
  return typeof candidate === 'string' ? candidate : '已声明能力（详情未展开）'
}

export function heartbeatStale(value?: string): boolean {
  return !value || new Date(value).getTime() < Date.now() - 90_000
}

export function reportStatusLabel(status: string): string {
  return ({ running: '进行中报告', succeeded: '成功报告', failed: '失败报告', cancelled: '已取消报告', unknown: '结果未知', reconciling: '待对账报告' } as Record<string, string>)[status] ?? `未知报告状态：${status}`
}

export function reportStatusTone(status: string): string {
  return ({ running: 'active', succeeded: 'success', failed: 'danger', cancelled: 'neutral', unknown: 'waiting', reconciling: 'waiting' } as Record<string, string>)[status] ?? 'waiting'
}

export function projectName(projects: { id: string; name: string }[], id: string): string {
  return projects.find(project => project.id === id)?.name ?? '未关联项目'
}

export function safeRelativePath(value: string): boolean {
  if (!value || value.length > 512 || value.includes('\\') || value.includes('\0')) return false
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false
  const pieces = value.split('/')
  return pieces.every(piece => piece && piece !== '.' && piece !== '..' && !/[\u0000-\u001f]/.test(piece))
}

export function safeJson(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}, null, 2) } catch { return '无可用证据' }
}
