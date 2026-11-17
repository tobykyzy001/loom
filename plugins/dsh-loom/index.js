import { resolve, isAbsolute } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { CoordinatorLoop, runLocalDshPlugin } from './lib/coordinator.js'
import { LocalFileDispatcher } from './lib/file-dispatcher.js'
import { DshAdapter } from './lib/dsh-adapter.js'
import { DshDispatcher } from './lib/dsh-dispatcher.js'
import { HostCredentialBroker, loadCredentialKey } from './lib/credential-broker.js'

export const name = 'loom-local-node'
export const inject = ['agents', 'sessionPersistence', 'tools', 'llm']
export const Config = z.object({
  enabled: z.boolean().default(false).description('Start outbound HTTP registration only; does not enable task execution.'),
  allow_workers: z.boolean().default(false).description('Explicit opt-in to perform any Loom-assigned work.'),
  executor: z.union(['unsupported', 'local', 'dsh']).default('unsupported').description('local=file-only/no models; dsh=public Agent APIs, not the local file worker.'),
  base_url: z.string().default('http://127.0.0.1:8765').description('Explicit Loom coordinator URL, HTTP(S) only.'),
  state_dir: z.string().default('').description('Required absolute isolated state directory; never defaults to a DSH profile.'),
  artifact_dir: z.string().default('').description('Required explicitly isolated directory for generated artifacts.'),
  enrollment_code: z.string().description('One-use enrollment code, obtained by an administrator; leave empty for fixed-token testing only.'),
  model_text_tasks: z.boolean().default(false).description('Opt in to one explicit provider/model text route using public ctx.llm and invoke_text Grants. Default false; read/write access is not model authority.'),
  model_descriptor_tasks: z.boolean().default(false).description('Opt in to the separately granted read-only model.json descriptor proof task. Uses the controlled file executor, not an Agent or model invocation; defaults false.'),
  credential_broker_tasks: z.union(['unsupported', 'dsh_records']).default('unsupported').description('Opt in to exact controller-bound Host credential metadata inspection and separately granted revoke; never secret extraction.'),
  allow_dsh_agent_creation: z.boolean().default(false).description('Allow creation of an owned Agent; otherwise use existing agent_session_id and never dispose it.'),
  bounded_fixture_effects: z.boolean().default(false).description('Test-only: verify a registered synthetic fixture write, never general provider side effects. Disabled by default.'),
  delegation_tools: z.union(['unsupported', 'scoped_fixture']).default('unsupported').description('Test-only child Agent with independently verified immutable source. Default refuses delegated ArtifactInput.'),
  delegation_project_root: z.string().default('').description('Test-only exact ProjectBinding root; never authorizes another path by prefix or cwd.'),
  agent_session_id: z.string().default('').description('Optional existing DSH Session id; resume failures are reported, not faked.'),
  profile_id: z.string().default('isolated').description('Loom worker-scope label, not a source of host authorization.'),
  project_roots: z.any().default({}).description('Explicit host-declared projectId to absolute synthetic/project root mapping; no implicit authorization.'),
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
      let delegationAgentSetup
      if (config.delegation_tools === 'scoped_fixture') {
        const module = await import('@loom/dsh-fixture-stub-provider/delegation').catch((error) => {
          throw new Error('Scoped delegation was requested without its declared Fixture tool package', { cause: error })
        })
        if (typeof module.registerScopedDelegationTool !== 'function') throw new Error('Fixture does not expose its explicit scoped delegation tool installer')
        delegationAgentSetup = ({ ctx: agentCtx, scene }) => module.registerScopedDelegationTool(agentCtx, scene)
      }
      const adapter = new DshAdapter(ctx, { allowCreation: config.allow_dsh_agent_creation,
        agentSessionId: config.agent_session_id, snapshotDir: config.artifact_dir,
        sessionMapPath: `${config.state_dir}/dsh-session-map.json`,
        allowBoundedFixtureEffects: config.bounded_fixture_effects,
        delegationAgentSetup })
      const startWorker = async (credentials) => {
        let broker
        if (config.credential_broker_tasks === 'dsh_records') {
          const keyFn = await loadCredentialKey()
          broker = new HostCredentialBroker(credentials, keyFn)
          if (!broker.available) throw new Error('dsh_records requires the active public credentials describeRecord/deleteRecord service')
        }
        // Project roots are explicitly host declarations, never implicit execution Grants.
        loop = await runLocalDshPlugin(config, {
          createClient: undefined,
          localDispatcher: (conf, runner) => new DshDispatcher(runner, adapter, conf, new LocalFileDispatcher(runner), { broker }),
        })
      }
      if (config.credential_broker_tasks === 'dsh_records') {
        // The optional injection is scoped to the broker. Other normal Local
        // Node modes never require, discover, or inspect the Host credential service.
        ctx.inject(['credentials'], (credentialContext) => credentialContext.effect(() => startWorker(credentialContext.credentials)))
      } else await startWorker()
      return async () => { if (loop) await loop.dispose() }
    } else throw new Error('executor must remain unsupported or select local/dsh explicitly')
    return async () => { if (loop) await loop.dispose() }
  })
}
