export type OfflineShellStatus = 'ready' | 'unsupported' | 'unavailable'

type OfflineServiceWorkerContainer = Pick<ServiceWorkerContainer, 'register' | 'ready'>

export async function prepareOfflineShell(
  container?: OfflineServiceWorkerContainer,
): Promise<OfflineShellStatus> {
  const workerContainer = container ?? (typeof navigator === 'undefined' ? undefined : navigator.serviceWorker)
  if (!workerContainer) return 'unsupported'

  try {
    await workerContainer.register('/sw.js', { scope: '/' })
    await workerContainer.ready
    return 'ready'
  } catch {
    return 'unavailable'
  }
}

export function startOfflineShell(): void {
  let started = false
  window.addEventListener('load', () => {
    if (started) return
    started = true
    void prepareOfflineShell().catch(() => {
      console.warn('Offline shell preparation is unavailable.')
    })
  }, { once: true })
}
