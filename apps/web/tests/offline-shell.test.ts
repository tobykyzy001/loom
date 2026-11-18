import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareOfflineShell, startOfflineShell } from '../src/lib/offline-shell'

type FakeContainer = Pick<ServiceWorkerContainer, 'register' | 'ready'>

function fakeContainer(config: {
  rejectRegistration?: boolean
  rejectReady?: boolean
} = {}) {
  const calls: Array<{ url: string; options: RegistrationOptions | undefined }> = []
  let readyReads = 0
  const registration = { scope: 'http://loom.invalid/' } as ServiceWorkerRegistration
  const container: FakeContainer = {
    register: vi.fn(async (url: string, options?: RegistrationOptions) => {
      calls.push({ url, options })
      if (config.rejectRegistration) throw new Error('registration failed')
      return registration
    }),
    get ready() {
      readyReads++
      return config.rejectReady ? Promise.reject(new Error('worker unavailable')) : Promise.resolve(registration)
    },
  }
  return { container, calls, readyReads: () => readyReads }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('prepareOfflineShell', () => {
  it('registers the root worker and waits for the browser ready promise', async () => {
    const { container, calls, readyReads } = fakeContainer()
    expect(await prepareOfflineShell(container)).toBe('ready')
    expect(calls).toEqual([{ url: '/sw.js', options: { scope: '/' } }])
    expect(readyReads()).toBe(1)
  })

  it('returns unavailable when registration fails', async () => {
    const { container, readyReads } = fakeContainer({ rejectRegistration: true })
    expect(await prepareOfflineShell(container)).toBe('unavailable')
    expect(readyReads()).toBe(0)
  })

  it('returns unavailable when the worker never becomes ready', async () => {
    const { container } = fakeContainer({ rejectReady: true })
    expect(await prepareOfflineShell(container)).toBe('unavailable')
  })

  it('reports unsupported without a provided container or browser service worker', async () => {
    vi.stubGlobal('navigator', {})
    expect(await prepareOfflineShell()).toBe('unsupported')
  })

  it('uses the navigator only as the default container', async () => {
    const { container, calls } = fakeContainer()
    vi.stubGlobal('navigator', { serviceWorker: container })
    expect(await prepareOfflineShell()).toBe('ready')
    expect(calls[0]).toEqual({ url: '/sw.js', options: { scope: '/' } })
  })
})

describe('startup', () => {
  it('starts one registration on window load without adding a notification', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let listener: (() => void) | undefined
    let registrations = 0
    vi.stubGlobal('window', {
      addEventListener: (name: string, callback: () => void) => {
        if (name === 'load') listener = callback
      },
    })
    vi.stubGlobal('navigator', { serviceWorker: {
      register: async () => { registrations++; return { scope: 'http://loom.invalid/' } as ServiceWorkerRegistration },
      ready: Promise.reject(new Error('fixture ready failure')),
    } })
    startOfflineShell()
    expect(registrations).toBe(0)
    listener?.()
    listener?.()
    await vi.waitFor(() => expect(registrations).toBe(1))
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
  })
})
