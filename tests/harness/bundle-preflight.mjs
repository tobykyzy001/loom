import assert from 'node:assert/strict'
import { chmod, cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseFixedPatch, parseJsonStrict, pathError, runBundlePreflight } from './bundle-preflight-lib.mjs'

const executable = process.execPath
const source = fileURLToPath(new URL('../../plugins/dsh-loom/', import.meta.url))
const fixture = await mkdtemp(join(tmpdir(), 'loom-preflight-suite-'))
const syntheticDependency = join(fixture, 'dependencies')
let failures = 0; let passed = 0

async function prepareDependency() {
  const root = join(syntheticDependency, '@deepseek-ai/schemastery')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version: '3.19.0', type: 'module', exports: './index.js' }))
  await cp(fileURLToPath(new URL('./fixtures/preflight-schema-stub.mjs', import.meta.url)), join(root, 'index.js'))
}
async function clone(modify) {
  const root = await mkdtemp(join(fixture, 'input-'))
  await cp(source, root, { recursive: true, filter: (path) => !/\/(?:test|node_modules)(?:\/|$)/.test(path) && !/\/node_modules$/.test(path) })
  await modify?.(root)
  return root
}
async function test(name, body) {
  try { await body(); passed++; console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error?.message || error}`) }
}
async function preflight(name, modify, options = {}) {
  const root = await clone(modify)
  const report = await runBundlePreflight({ rawRoot: root, expected: { name: '@loom/dsh-loom', version: '0.0.0', inject: ['tools', 'sessionPersistence', 'agents'] }, ...options })
  assert.equal(Object.isFrozen(report), true, `${name}: frozen report`)
  assert.equal(JSON.stringify(report).includes(root), false, `${name}: no absolute root leak`)
  return report
}
async function rejects(name, modify, code, options = {}) {
  await test(name, async () => {
    const report = await preflight(name, modify, options)
    assert.equal(report.outcome, 'fail', JSON.stringify(report.checks))
    assert.ok(report.checks.some((item) => item.status === 'fail' && String(item.detail).includes(code)), `expected ${code}: ${JSON.stringify(report.checks)}`)
    assert.equal(report.checks.some((item) => item.id === 'module.dynamic_import' && item.status === 'pass'), false, 'rejection preceded import')
  })
}
try {
  await prepareDependency()
  await cp(fileURLToPath(new URL('./pack-stub.cjs', import.meta.url)), join(fixture, 'pack-stub.cjs'))
  await mkdir(join(fixture, 'input-copy'), { recursive: true })
  await cp(source, join(fixture, 'input-copy'), { recursive: true, filter: (path) => !/\/(?:test|node_modules)(?:\/|$)/.test(path) && !/\/node_modules$/.test(path) })
  const sourceDigest = createHash('sha256').update(await readFile(join(source, 'README.md'))).digest('hex')

  await test('real source passes static structure and reports missing runtime dependency NOT RUN', async () => {
    const report = await preflight('actual-source', null)
    assert.equal(report.outcome, 'static_pass_runtime_not_run')
    assert.equal(report.manifest_id, '@loom/dsh-loom@0.0.0')
    assert.equal(report.provenance.kind, 'synthetic fixture source declared')
    assert.equal(report.activation.apply_invoked, false)
    assert.deepEqual(report.config_defaults.enabled, false)
    assert.equal(report.checks.find((item) => item.id === 'module.dynamic_import').status, 'not_run')
    assert.equal(report.files.find((file) => file.path === 'README.md').sha256, sourceDigest)
  })
  await test('test-owned copy imports native apply with an explicitly supplied public-schema fixture', async () => {
    const report = await preflight('declared-fixture-dependency', null, { dependencyRoot: syntheticDependency })
    assert.equal(report.outcome, 'static_pass_runtime_not_run', JSON.stringify(report.checks))
    assert.equal(report.checks.find((item) => item.id === 'module.dynamic_import').status, 'pass')
    assert.match(report.checks.find((item) => item.id === 'module.external_dependency').detail.resolution, /explicit fixture dependency root/)
    assert.equal(report.checks.find((item) => item.id === 'apply.activation').status, 'not_run')
  })
  await test('filesystem root and caller-supplied incorrect roots fail closed', async () => {
    for (const rawRoot of [sep, 'relative/plugins/dsh-loom', join(fixture, 'credentials')]) {
      const report = await runBundlePreflight({ rawRoot })
      assert.equal(report.outcome, 'fail'); assert.doesNotMatch(JSON.stringify(report), new RegExp(rawRoot.replaceAll('/', '\\/')))
    }
  })
  await test('root normalization and path guards', async () => {
    for (const rawRoot of ['/', fixture, 'relative/plugins/dsh-loom', join(fixture, 'credentials')]) {
      const report = await runBundlePreflight({ rawRoot })
      assert.equal(report.outcome, 'fail'); assert.doesNotMatch(JSON.stringify(report), new RegExp(rawRoot.replaceAll('/', '\\/')))
    }
    for (const path of ['../secret', '/secret', 'C:/secret', 'https://example.invalid/a', 'lib\\x.js', 'lib//x.js']) assert.equal(pathError(path), true)
    assert.equal(pathError('./locale/en.json'), false)
    assert.throws(() => parseJsonStrict('{"exports":{},"exports":{}}'), /duplicate_json_key/)
    assert.throws(() => parseFixedPatch('- insert:\n    - id: loom-local-node\n      name: \'@loom/dsh-loom\'\n      config:\n        enabled: true\n        allow_workers: false\n        executor: unsupported\n', '@loom/dsh-loom'), /unsafe_default/)
  })
  await rejects('symlink escape rejected before reading target', async (root) => {
    await symlink(fixture, join(root, 'lib/escape'), 'dir')
  }, 'symlink_or_non_regular_input')
  await rejects('secret-looking name rejected before payload read', async (root) => {
    await writeFile(join(root, 'lib/credentials.json'), '{"secret":"RAW_TEST_SECRET_NEVER_REPORT"}')
  }, 'secret_named_input_rejected', { secrets: ['RAW_TEST_SECRET_NEVER_REPORT'] })
  await rejects('hard linked payload cannot escape the declared source root', async (root) => {
    await link(join(root, 'README.md'), join(fixture, 'outside-of-declared-bundle.md'))
  }, 'unsafe_file_or_size:README.md')
  await rejects('duplicate exports keys rejected', async (root) => {
    await writeFile(join(root, 'package.json'), (await readFile(join(root, 'package.json'), 'utf8')).replace('"./icon": "./icon.svg"', '"./icon": "./icon.svg", "./icon": "./other.svg"'))
  }, 'duplicate_json_key:./icon')
  await rejects('missing package entrypoint and wrong identity are distinct failures', async (root) => {
    await rm(join(root, 'index.js'))
  }, 'root_is_not_exact_plugin_root')
  await rejects('wrong exact package version rejected', async (root) => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); pkg.version = '1.0.0'
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg))
  }, 'package_identity_mismatch')
  await rejects('absolute and traversal exports and file paths rejected', async (root) => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); pkg.exports['./icon'] = '/icon.svg'
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg))
  }, 'unsafe_relative_path')
  await rejects('missing declared source rejected without fallback export filter', async (root) => {
    await rm(join(root, 'lib/coordinator.js'))
  }, 'missing_relative_import:lib/coordinator.js')
  await rejects('duplicate patch ids rejected before import', async (root) => {
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    await writeFile(join(root, 'cordis.patch.yml'), patch.replace(/^(?=- insert:)/m, '# synthetic duplicate\n').replace('id: loom-local-node', 'id: loom-local-node-and-second-block'))
    await writeFile(join(root, 'cordis.patch.yml'), patch + patch.replace('- insert:', '  # second inserted lane\n- insert:'))
  }, 'unsupported_patch_shape')
  await rejects('name double colon is not silently read as plugin name', async (root) => {
    await writeFile(join(root, 'cordis.patch.yml'), (await readFile(join(root, 'cordis.patch.yml'), 'utf8')).replace('name:', 'name::'))
  }, 'invalid_patch_name_separator')
  await rejects('enabled true cannot be assigned by patch defaults', async (root) => {
    await writeFile(join(root, 'cordis.patch.yml'), (await readFile(join(root, 'cordis.patch.yml'), 'utf8')).replace('enabled: false', 'enabled: true'))
  }, 'unsafe_default:enabled')
  await rejects('allow_workers true cannot be flipped by prefight', async (root) => {
    await writeFile(join(root, 'cordis.patch.yml'), (await readFile(join(root, 'cordis.patch.yml'), 'utf8')).replace('allow_workers: false', 'allow_workers: true'))
  }, 'unsafe_default:allow_workers')
  await rejects('executor cannot become enabled implicitly', async (root) => {
    await writeFile(join(root, 'cordis.patch.yml'), (await readFile(join(root, 'cordis.patch.yml'), 'utf8')).replace("executor: 'unsupported'", "executor: 'dsh'"))
  }, 'unsafe_default:executor')
  await rejects('unsafe detail traversal and missing doc rejected', async (root) => {
    const locale = JSON.parse(await readFile(join(root, 'locale/en.json'), 'utf8')); locale.meta.detail = '../outside.md'
    await writeFile(join(root, 'locale/en.json'), JSON.stringify(locale))
  }, 'unsafe_detail_path')
  await rejects('missing detail is an error not README fallback', async (root) => {
    for (const name of ['en', 'zh']) {
      const locale = JSON.parse(await readFile(join(root, `locale/${name}.json`), 'utf8')); locale.meta.detail = 'docs/MISSING.md'
      await writeFile(join(root, `locale/${name}.json`), JSON.stringify(locale))
    }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); pkg.files.push('docs')
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg))
  }, 'missing_declared_path')
  await rejects('missing required meta.description fails', async (root) => {
    const locale = JSON.parse(await readFile(join(root, 'locale/zh.json'), 'utf8')); delete locale.meta.description
    await writeFile(join(root, 'locale/zh.json'), JSON.stringify(locale))
  }, 'locale_metadata_required')
  await rejects('missing icon rejected', async (root) => { await rm(join(root, 'icon.svg')) }, 'missing_declared_path')
  await rejects('invalid SVG bytes rejected', async (root) => { await writeFile(join(root, 'icon.svg'), '<html><script>not an icon</script></html>') }, 'icon_bytes_do_not_match_declared_format')
  await rejects('invalid UTF-8 manifest rejected', async (root) => { await writeFile(join(root, 'locale/en.json'), Buffer.from([0xff, 0xfe])) }, 'invalid_utf8')
  await rejects('oversize package manifest rejected', async (root) => { await writeFile(join(root, 'package.json'), Buffer.alloc(64 * 1024 + 1, 32)) }, 'unsafe_file_or_size:package.json')
  await rejects('oversize payload source >32KiB fixture tested at defined 256KiB limit', async (root) => { await writeFile(join(root, 'lib/oversize.js'), 'a'.repeat(256 * 1024 + 1)) }, 'unsafe_file_or_size:lib/oversize.js')
  await test('absent bundled dependency never falls back to global resolution', async () => {
    const report = await preflight('missing-dependency')
    assert.equal(report.outcome, 'static_pass_runtime_not_run')
    assert.equal(report.checks.find((item) => item.id === 'apply.activation').detail.includes('apply and mock ctx were never invoked'), true)
  })
  await test('optional local pack success is inventory evidence, not registration', async () => {
    const report = await preflight('pack-success', null, { pack: true, npmCommand: executable, packArgs: [join(fixture, 'pack-stub.cjs')], dependencyRoot: syntheticDependency })
    const check = report.checks.find((item) => item.id === 'package.dry_run')
    assert.equal(check.status, 'pass', JSON.stringify(check)); assert.equal(check.detail.registered, false); assert.equal(check.detail.tarball_created, false)
  })
  await test('optional pack missing file fails closed, no export filter fallback', async () => {
    const report = await preflight('real-inventory-missing-source', async (root) => { await rm(join(root, 'src/util.js')) }, { pack: true, npmCommand: executable, packArgs: [join(fixture, 'pack-stub.cjs')], dependencyRoot: syntheticDependency })
    assert.equal(report.outcome, 'fail'); assert.equal(report.checks.some((item) => item.id === 'module.dynamic_import' || item.id === 'package.dry_run'), false)
    const packReport = await runBundlePreflight({ rawRoot: await clone(null), pack: true, npmCommand: executable, packArgs: [join(fixture, 'pack-stub.cjs'), '--extra-unlisted-file'], dependencyRoot: syntheticDependency })
    assert.equal(packReport.checks.find((item) => item.id === 'package.dry_run').status, 'fail')
  })
  await test('opt-in stub pack failure preserves observed errno/exit without raw stderr', async () => {
    const report = await preflight('pack-failure', null, { pack: true, npmCommand: join(fixture, 'missing-npm-binary'), dependencyRoot: syntheticDependency })
    const check = report.checks.find((item) => item.id === 'package.dry_run')
    assert.equal(check.status, 'not_run'); assert.equal(check.detail.errno, 'ENOENT'); assert.equal(typeof check.detail.stderr, 'undefined')
  })
  await test('preserves observed POSIX exit for synthetic pack exitCode 501', async () => {
    const command = join(fixture, 'pack-exit-501.cjs')
    await writeFile(command, 'process.exitCode=501\n')
    const report = await preflight('pack-exit-501', null, { pack: true, npmCommand: executable, packArgs: [command], dependencyRoot: syntheticDependency })
    assert.equal(report.checks.find((item) => item.id === 'package.dry_run').detail.exit_code, 245) // POSIX: 501 & 0xff; do not claim a raw 501 exit.
  })
  await test('no secret, URL or prompt content leaks into bounded report', async () => {
    const secret = 'RAW_FIXTURE_TOKEN_DO_NOT_DISCLOSE'
    const report = await preflight('redaction', async (root) => { await writeFile(join(root, 'lib/credentials.txt'), secret) }, { secrets: [secret] })
    assert.doesNotMatch(JSON.stringify(report), new RegExp(`${secret}|https?://|/Users/|BEGIN .*PRIVATE KEY`))
  })
  console.log(JSON.stringify({ suite: 'loom.bundle-preflight.selftest.v1', passed, failures, source_manifest: '@loom/dsh-loom@0.0.0', profiles_touched: false, network_used: false }, null, 2))
  process.exitCode = failures ? 1 : 0
} finally {
  if (process.platform !== 'win32') await chmod(fixture, 0o700)
  await rm(fixture, { recursive: true, force: true })
}
