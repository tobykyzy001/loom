'use strict'
// Opt-in test fixture: no spawn, registry, npm, installation, or tarball.
if (process.argv.includes('--bad')) {
  process.stderr.write('synthetic pack failure; paths are not reported by the harness')
  process.exitCode = 501 & 0xff
} else if (process.argv.includes('--invalid')) {
  process.stdout.write('{not json')
} else {
  const { readdirSync, statSync } = require('node:fs')
  const { join } = require('node:path')
  const paths = []
  function walk(path) {
    for (const name of readdirSync(path)) {
      if (name === 'node_modules' || process.argv.includes('--extra-unlisted-file')) continue
      const absolute = join(path, name)
      if (statSync(absolute).isDirectory()) walk(absolute)
      else paths.push(join(path, name).slice(process.cwd().length + 1).replaceAll('\\', '/'))
    }
  }
  if (!process.argv.includes('--extra-unlisted-file')) walk(process.cwd())
  process.stdout.write(JSON.stringify([{ files: paths.sort().map((path) => ({ path })) }]))
}
