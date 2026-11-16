// Optional read-only import smoke against installed DSH's shipped Schemastery.
// Run with the verified Desktop executable and ELECTRON_RUN_AS_NODE=1, never installs/activates.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
const require = createRequire(resolve(process.env.DSH_INSTALL_DIR, 'package.json'))
const schemaPackage = dirname(require.resolve('@deepseek-ai/schemastery/package.json'))
const manifest = require('@deepseek-ai/schemastery/package.json')
const schemaEntry = require.resolve('@deepseek-ai/schemastery')
if (!process.versions.electron) throw new Error('This smoke requires ASAR-aware DSH_NODE_EXECUTABLE')
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/schemastery') {
      return { url: pathToFileURL(schemaEntry).href, format: 'commonjs', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const plugin = await import('../index.js')
assert.equal(typeof plugin.apply, 'function')
const config = plugin.Config({})
assert.equal(config.enabled, false)
assert.equal(config.allow_workers, false)
assert.equal(config.executor, 'unsupported')
assert.equal(config.max_active_workers, 1)
await plugin.apply({}, config) // safe default is no context effects, HTTP, registration, DSH creation
console.log(JSON.stringify({ installed_schema_import: 'PASS', disabled_apply: 'PASS', real_host_mounted: false, installation_performed: false }))
