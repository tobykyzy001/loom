/** Test-only, explicitly owned Rust Concierge fixture handle, not a service installer. */
export interface RustFixtureConcierge {
  baseUrl: string
  clientToken: string
  dataDir: string
  stop(): Promise<void>
}

export function startRustConcierge(input: {
  root: string
  env?: Record<string, string | undefined>
  dataDir?: string
  baseUrl?: string
}): Promise<RustFixtureConcierge>

export function testingRoot(): Promise<string>
export function testingClientToken(): string
