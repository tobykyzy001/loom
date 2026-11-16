import { resolve, isAbsolute } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { CoordinatorLoop, runLocalDshPlugin } from './lib/coordinator.js'
import { LocalFileDispatcher } from './lib/file-dispatcher.js'
import { DshAdapter } from './lib/dsh-adapter.js'
import { DshDispatcher } from './lib/dsh-dispatcher.js'

export const name = 'loom-local-node'
export const Config = z.object({
  enabled: z.boolean().default(false).description('Start outbound HTTP registration only; does not enable task execution.'),
  allow_workers: z.boolean().default(false).description('Explicit opt-in to perform any Loom-assigned work.'),
  executor: z.union(['unsupported', 'local', 'dsh']).default('unsupported').description('local=file-only/no models; dsh=public Agent APIs, not the local file worker.'),
  base_url: z.string().default('http://127.0.0.1:8765').description('Explicit Loom coordinator URL, HTTP(S) only.'),
  state_dir: z.string().default('').description('Required absolute isolated state directory; never defaults to a DSH profile.'),
  artifact_dir: z.string().default('').description('Required explicitly isolated directory for generated artifacts.'),
  enrollment_code: z.string().description('One-use enrollment code, obtained by an administrator; leave empty for fixed-token testing only.'),
  allow_dsh_agent_creation: z.boolean().default(false).description('Allow creation of an owned Agent; otherwise use existing agent_session_id and never dispose it.'),
  agent_session_id: z.string().default('').description('Optional existing DSH Session id; resume failures are reported, not faked.'),
  profile_id: z.string().default('isolated').description('Loom worker-scope label, not a source of host authorization.'),
  provider: z.string().description('Optional provider route passed verbatim to ctx.agents.create().'),
  model: z.string().description('Optional model identifier; must actually exist on the selected Host.'),
  reasoning_effort: z.string().description('Optional adapter-supported reasoning effort for model that accepts it.'),
  max_tokens: z.number().step(1).min(1).max(1_000_000).description('Optional DSH AgentOptions.maxTokens cap.'),
  max_active_workers: z.number().step(1).min(1).max(4).default(1).description('Host-local work concurrency limit; no cross-machine authority.'),
  heartbeat_ms: z.number().step(1).min(2000).max(60_000).default(15_000),
  poll_seconds: z.number().step(1).min(0).max(60).default(1),
  request_timeout_ms: z.number().step(1).min(100).max(65_000).default(15_000),
})

export async function apply(ctx, config) {
  if (!config.enabled) return
  if (!config.allow_workers || config.executor === 'unsupported') {
    // No scheduler, HTTP attempt, session creation, or registration on unsupported config.
    console.info('[loom-local-node] Disabled for execution: configure enabled, allow_workers, isolated directories and a verified executor explicitly.')
    return
  }
  if (typeof config.base_url !== 'string' || !/^https?:\/\//.test(config.base_url)) throw new Error('Loom base_url must be an explicit HTTP(S) endpoint')
  for (const key of ['state_dir', 'artifact_dir']) {
    if (!isAbsolute(config[key] || '')) throw new Error(`Loom ${key} must be an explicit absolute isolated directory`)
    const path = resolve(config[key])
    if (path === '/' || path === resolve(process.env.HOME || '__none__')) throw new Error(`Loom ${key} must not be HOME or filesystem root`)
    if (process.env.DSH_PROFILE_DIR && (path === resolve(process.env.DSH_PROFILE_DIR) || path.startsWith(resolve(process.env.DSH_PROFILE_DIR) + '/'))) {
      throw new Error(`Loom ${key} must stay outside DSH profile; plugin will not edit/read its configuration database`)
    }
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  let loop
  await ctx.effect(async () => {
    if (config.executor === 'local') {
      loop = await runLocalDshPlugin(config, {
        createClient: undefined,
        localDispatcher: (conf, runner) => new LocalFileDispatcher(runner),
      })
    } else if (config.executor === 'dsh') {
      // Optional dynamic service detection keeps an absent Agent surface an error, never simulated execution.
      if (!ctx.agents || typeof ctx.agents.get !== 'function') throw new Error('Unsupported DSH executor: verified ctx.agents service is not mounted')
      const adapter = new DshAdapter(ctx, { allowCreation: config.allow_dsh_agent_creation,
        agentSessionId: config.agent_session_id, snapshotDir: config.artifact_dir })
      loop = await runLocalDshPlugin(config, {
        createClient: undefined,
        localDispatcher: (conf, runner) => new DshDispatcher(runner, adapter, conf),
      })
    } else throw new Error('executor must remain unsupported or select local/dsh explicitly')
    return async () => { if (loop) await loop.dispose() }
  })
}
