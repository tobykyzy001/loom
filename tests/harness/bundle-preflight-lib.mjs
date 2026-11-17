import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXPECTED = Object.freeze({ name: '@loom/dsh-loom', version: '0.0.0', inject: ['tools', 'sessionPersistence', 'agents'] })
export const LIMITS = Object.freeze({ manifest: 64 * 1024, patch: 64 * 1024, readme: 1024 * 1024, locale: 1024 * 1024, icon: 256 * 1024, source: 256 * 1024, files: 512, total: 8 * 1024 * 1024 })
const REQUIRED_EXPORTS = ['.', './lib/*', './locale/*.json', './icon']
const SAFE_CONFIG = Object.freeze({ enabled: false, allow_workers: false, executor: 'unsupported' })
const PATCH_CONFIG_KEYS = new Set(['enabled', 'allow_workers', 'executor', 'base_url', 'state_dir', 'artifact_dir', 'enrollment_code', 'model_text_tasks', 'model_descriptor_tasks', 'credential_broker_tasks', 'allow_dsh_agent_creation', 'bounded_fixture_effects', 'delegation_tools', 'delegation_project_root', 'agent_session_id', 'profile_id', 'project_roots', 'provider', 'model', 'reasoning_effort', 'max_tokens', 'max_active_workers', 'heartbeat_ms', 'poll_seconds', 'request_timeout_ms'])
const SAFE_EXTENSION = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.markdown', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.txt'])
const SECRET_FILE = /^(?:credentials?|\.env(?:\..*)?|id_(?:rsa|ed25519))(?:\.[^/]*)?$|\.(?:pem|key|p12|pfx|keystore)$/i
const FORBIDDEN_ROOT_PART = /^(?:\.dsh|dsh|profiles?|cordis|credentials?|\.config|application support|appdata)$/i

export class PreflightError extends Error {
  constructor(code, fields = {}) { super(code); this.code = code; this.fields = fields }
}
const fail = (code, fields) => { throw new PreflightError(code, fields) }
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
function strictUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { fail('invalid_utf8') }
}
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}
export function pathError(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return true
  const parts = value.replace(/^\.\//, '').split('/')
  return parts.some((part) => !part || part === '.' || part === '..') || !parts.length
}
function localPath(value, allowBare = false) {
  if (pathError(value) || (!allowBare && !value.startsWith('./')) || value.replace(/^\.\//, '').split('/').includes('..')) fail('unsafe_relative_path')
  return value.replace(/^\.\//, '')
}
function secretName(path) {
  return String(path).split('/').some((part) => SECRET_FILE.test(part))
}
function redact(value, secrets = []) {
  let result = String(value).slice(0, 300)
  for (const secret of secrets || []) if (typeof secret === 'string' && secret.length >= 6) result = result.replaceAll(secret, '[redacted]')
  return result.replace(/[a-z+.-]+:\/\/\S+/gi, '<url>').replace(/(?:[A-Za-z]:[\\/]|\/)\S+/g, '<path>')
}

/** JSON.parse does not detect duplicate keys. This small strict parser does. */
export function parseJsonStrict(text) {
  let at = 0
  const space = () => { while (/\s/.test(text[at] || '')) at++ }
  function value() {
    space()
    if (text[at] === '{') {
      at++; const result = {}; const names = new Set(); space()
      if (text[at] === '}') { at++; return result }
      for (;;) {
        space(); if (text[at] !== '"') fail('invalid_json')
        const key = string(); if (names.has(key)) fail(`duplicate_json_key:${key}`); names.add(key)
        space(); if (text[at++] !== ':') fail('invalid_json')
        result[key] = value(); space()
        if (text[at] === '}') { at++; return result }
        if (text[at++] !== ',') fail('invalid_json')
      }
    }
    if (text[at] === '[') {
      at++; const result = []; space(); if (text[at] === ']') { at++; return result }
      for (;;) {
        result.push(value()); space()
        if (text[at] === ']') { at++; return result }
        if (text[at++] !== ',') fail('invalid_json')
      }
    }
    if (text[at] === '"') return string()
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))
    if (!match) fail('invalid_json'); at += match[0].length
    return match[0] === 'true' ? true : match[0] === 'false' ? false : match[0] === 'null' ? null : Number(match[0])
  }
  function string() {
    const start = ++at
    for (;;) {
      const char = text[at++]
      if (char === '"') break
      if (!char || char === '\n' || char === '\r') fail('invalid_json_string')
      if (char === '\\') {
        const escaped = text[at++]
        if (escaped === 'u') { if (!/^[\da-f]{4}$/i.test(text.slice(at, at + 4))) fail('invalid_json_escape'); at += 4 }
        else if (!'"\\/bfnrt'.includes(escaped || '')) fail('invalid_json_escape')
      }
    }
    try { return JSON.parse(text.slice(start - 1, at)) } catch { fail('invalid_json_string') }
  }
  const result = value(); space(); if (at !== text.length) fail('invalid_json_trailing_data')
  return result
}

/** Deliberately parses only the literal, fixed `insert: [{id,name,config}]` subset. */
export function parseFixedPatch(text, expectedName) {
  if (text.includes('\t') || text.includes('!!') || /^\s*(?:---|&|\*)/m.test(text)) fail('unsafe_or_unsupported_patch')
  const lines = text.split('\n').map((raw, index) => ({ raw, index: index + 1, indent: /^ */.exec(raw)[0].length, text: raw.trim() })).filter(({ text }) => text && !text.startsWith('#'))
  if (!lines.length || lines[0].raw !== '- insert:') fail('patch_must_be_insert_list')
  let cursor = 1; const rows = []; const ids = new Set()
  while (cursor < lines.length) {
    const header = lines[cursor++]
    if (header.indent !== 4 || !header.text.startsWith('- ')) fail('unsupported_patch_shape')
    const rowText = header.text.slice(2)
    const match = /^([A-Za-z_][\w.-]*):(?:\s*(.*))?$/.exec(rowText)
    if (!match) fail('invalid_patch_key')
    const row = { config: {}, _keys: new Set() }
    if (match[1]) row[match[1]] = rowText.includes('::') ? fail('invalid_patch_name_separator') : parseYamlScalar(match[2] || '')
    row._keys.add(match[1])
    while (cursor < lines.length && lines[cursor].indent >= 6) {
      const line = lines[cursor++]
      if (line.indent === 6) {
        if (line.text === 'config:') { if (row._keys.has('config')) fail('duplicate_patch_config'); row._keys.add('config'); continue }
        const entry = /^([A-Za-z_][\w.-]*):(?:\s*(.*))?$/.exec(line.text)
        if (!entry || row._keys.has(entry[1])) fail('duplicate_or_invalid_patch_field')
        if (entry[1] === 'name' && line.text.includes('::')) fail('invalid_patch_name_separator')
        row._keys.add(entry[1]); row[entry[1]] = parseYamlScalar(entry[2] || '')
      } else if (line.indent === 8) {
        if (!row._keys.has('config')) fail('patch_value_outside_config')
        const entry = /^([A-Za-z_][\w.-]*):(?:\s*(.*))?$/.exec(line.text)
        if (!entry || !PATCH_CONFIG_KEYS.has(entry[1]) || Object.hasOwn(row.config, entry[1])) fail('unknown_or_duplicate_patch_config')
        row.config[entry[1]] = parseYamlScalar(entry[2] || '')
      } else fail('unsupported_patch_indentation')
    }
    if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) fail('missing_or_duplicate_patch_id'); ids.add(row.id)
    if (row.name !== expectedName) fail('patch_name_mismatch')
    if ([...row._keys].some((key) => !['id', 'name', 'config'].includes(key))) fail('unknown_patch_field')
    if (row.enabled !== undefined || row.allow_workers !== undefined) fail('activation_fields_belong_in_config')
    rows.push(frozen({ id: row.id, name: row.name, config: row.config }))
  }
  if (rows.length !== 1) fail('patch_must_insert_exactly_one_plugin')
  const row = rows[0]
  for (const [key, value] of Object.entries(SAFE_CONFIG)) if (row.config[key] !== value) fail(`unsafe_default:${key}`)
  for (const key of ['enabled', 'allow_workers', 'allow_dsh_agent_creation', 'model_text_tasks', 'model_descriptor_tasks', 'bounded_fixture_effects']) if (row.config[key] !== undefined && typeof row.config[key] !== 'boolean') fail(`non_boolean_config:${key}`)
  return rows
}
function parseYamlScalar(value) {
  if (!value) return ''
  if (value[0] === "'") { if (!/^'(?:[^']|'')*'$/.test(value)) fail('unsupported_yaml_scalar'); return value.slice(1, -1).replaceAll("''", "'") }
  if (value[0] === '"') { try { return JSON.parse(value) } catch { fail('unsupported_yaml_scalar') } }
  if (/^(?:true|false)$/.test(value)) return value === 'true'
  if (/^-?\d+$/.test(value)) { const result = Number(value); if (!Number.isSafeInteger(result)) fail('unsafe_yaml_number'); return result }
  if (/^(?:null|~|\{|\[|>|&|\*)/.test(value)) fail('unsupported_yaml_scalar')
  return value
}

function check(id, status, detail) { return { id, status, ...(detail === undefined ? {} : { detail }) } }
async function inputRoot(rawRoot) {
  if (typeof rawRoot !== 'string' || !isAbsolute(rawRoot)) fail('explicit_absolute_plugin_root_required')
  const candidate = await realpath(resolve(rawRoot)).catch(() => fail('plugin_root_missing'))
  const canonical = candidate
  const info = await lstat(candidate).catch(() => fail('plugin_root_missing'))
  if (!info.isDirectory() || info.isSymbolicLink()) fail('plugin_root_must_be_real_non_symlink_directory')
  if (candidate === sep || candidate === resolve(homedir()) || candidate === dirname(candidate)) fail('unsafe_plugin_root')
  if (secretName(basename(candidate))) fail('unsafe_plugin_root_name')
  if (await stat(join(candidate, 'cordis.patch.yml')).catch(() => null) && candidate.split(sep).some((part) => FORBIDDEN_ROOT_PART.test(part))) fail('unsafe_plugin_root')
  for (const file of ['package.json', 'index.js']) {
    const state = await lstat(join(candidate, file)).catch(() => fail('root_is_not_exact_plugin_root'))
    if (!state.isFile() || state.isSymbolicLink() || state.nlink > 1) fail('root_is_not_exact_plugin_root')
  }
  if ((await stat(join(candidate, 'plugins/dsh-loom/package.json')).catch(() => null))) fail('repository_wrapper_not_plugin_root')
  if ((await stat(join(candidate, 'cordis.patch.yml')).catch(() => null)) === null) fail('patch_declared_but_root_not_exact_plugin')
  return canonical
}
async function readSafe(root, relative, limit) {
  if (secretName(relative)) fail('secret_named_input_rejected')
  const absolute = join(root, ...relative.split('/'))
  const info = await lstat(absolute).catch(() => fail(`missing_file:${relative}`))
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > limit) fail(`unsafe_file_or_size:${relative}`)
  return await readFile(absolute)
}
async function walk(root, relative, out) {
  if (secretName(relative)) fail('secret_named_input_rejected')
  const info = await lstat(join(root, ...relative.split('/'))).catch(() => fail(`missing_declared_path:${relative}`))
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail(`symlink_or_non_regular_input:${relative}`)
  if (info.isFile()) { out.add(relative); return }
  const children = await readdir(join(root, ...relative.split('/')), { withFileTypes: true })
  for (const child of children) {
    if (SECRET_FILE.test(child.name)) fail('secret_named_input_rejected')
    if (child.isSymbolicLink()) fail(`symlink_or_non_regular_input:${relative}/${child.name}`)
    if (!SAFE_EXTENSION.has(child.name.slice(child.name.lastIndexOf('.'))) && !child.isDirectory()) fail(`unsupported_payload_file:${relative}/${child.name}`)
    if (out.size >= LIMITS.files) fail('too_many_payload_files')
    await walk(root, `${relative}/${child.name}`, out)
  }
}

export async function inspectBundle({ rawRoot, expected = EXPECTED, secrets = [], pack = false, dependencyRoot, npmCommand = 'npm' } = {}) {
  const root = await inputRoot(rawRoot)
  const records = []; const files = new Map(); const add = async (relative, bytes) => {
    if (files.has(relative)) return
    if (files.size >= LIMITS.files) fail('too_many_payload_files')
    if ([...files.values()].reduce((total, item) => total + item.size, 0) + bytes.length > LIMITS.total) fail('payload_too_large')
    files.set(relative, { path: relative, size: bytes.length, sha256: digest(bytes) })
  }
  const manifestBytes = await readSafe(root, 'package.json', LIMITS.manifest)
  const manifest = parseJsonStrict(strictUtf8(manifestBytes)); await add('package.json', manifestBytes)
  const packageId = manifest && typeof manifest.name === 'string' && typeof manifest.version === 'string' ? `${manifest.name}@${manifest.version}` : 'unverified'
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('invalid_manifest')
  if (manifest.name !== expected.name || manifest.version !== expected.version) fail('package_identity_mismatch', { manifest_id: packageId, export_ids: [] })
  if (!/^@?[a-z0-9][a-z0-9._/-]*$/.test(manifest.name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) fail('invalid_package_identity_shape')
  if (manifest.private !== true || manifest.type !== 'module') fail('private_module_manifest_required')
  if (localPath(manifest.dsh?.bundle?.patch) !== 'cordis.patch.yml') fail('exact_patch_declaration_required')
  if (!manifest.exports || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)) fail('exports_object_required')
  for (const id of REQUIRED_EXPORTS) if (manifest.exports[id] === undefined) fail(`missing_export:${id}`)
  for (const [id, value] of Object.entries(manifest.exports)) {
    if ((id !== '.' && pathError(id)) || typeof value !== 'string') fail('unsupported_export_shape')
    const target = localPath(value)
    if (id === '.') { if (target !== 'index.js') fail('unexpected_entrypoint') }
    else if (id === './lib/*') { if (target !== 'lib/*') fail('unexpected_library_export') }
    else if (id === './locale/*.json') { if (target !== 'locale/*.json') fail('unexpected_locale_export') }
    else if (id === './icon') { if (!/^icon\.(?:svg|png|jpe?g|webp)$/.test(target)) fail('unexpected_icon_export') }
    else fail('unrecognized_export')
  }
  records.push(check('manifest.exports', 'pass', 'Verified exact package id, ESM, local export targets and patch basename. private=true is not a trust grant.'))
  const patchPath = localPath(manifest.dsh.bundle.patch); const patchBytes = await readSafe(root, patchPath, LIMITS.patch)
  const patch = parseFixedPatch(strictUtf8(patchBytes), expected.name); await add(patchPath, patchBytes)
  records.push(check('patch.insert', 'pass', { insert_ids: patch.map((row) => row.id), config_defaults: SAFE_CONFIG, activation: 'not performed', capabilities: 'protocol declarations, not grants' }))
  if (!Array.isArray(manifest.files) || new Set(manifest.files).size !== manifest.files.length) fail('files_array_and_unique_paths_required')
  const selected = new Set(['index.js', patchPath, 'README.md', localPath(manifest.exports['./icon'])])
  for (const entry of manifest.files) {
    const relative = localPath(entry, true)
    if (relative.includes('*')) {
      if (pathError(relative) || !/^locale\/\*\.json$/.test(relative)) fail(`unsafe_or_unsupported_files_pattern:${relative}`)
      const directory = dirname(join(root, relative)); const info = await lstat(directory).catch(() => fail('missing_locale_directory'))
      if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_locale_directory')
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (child.isSymbolicLink()) fail('symlink_locale_rejected')
        if (child.isFile() && child.name.endsWith('.json')) selected.add(`locale/${child.name}`)
      }
    } else await walk(root, relative, selected)
  }
  for (const relative of ['locale/en.json', 'locale/zh.json']) if (!selected.has(relative)) fail(`missing_required_locale:${relative}`)
  const sorted = [...selected].sort(); let readmeText = ''
  for (const relative of sorted) {
    const limit = relative === 'README.md' ? LIMITS.readme : relative.startsWith('locale/') ? LIMITS.locale : relative.endsWith('.svg') ? LIMITS.icon : relative.endsWith('.md') || relative.endsWith('.markdown') ? LIMITS.readme : LIMITS.source
    const bytes = await readSafe(root, relative, limit); await add(relative, bytes)
    const text = /\.(?:js|json|md|markdown|svg)$/.test(relative) ? strictUtf8(bytes) : null
    if (relative.endsWith('.json') && relative !== 'package.json' && !relative.startsWith('locale/')) parseJsonStrict(text)
    if (relative.startsWith('locale/') && relative.endsWith('.json')) {
      const locale = parseJsonStrict(text)
      if (!locale.meta || typeof locale.meta.title !== 'string' || !locale.meta.title.trim() || typeof locale.meta.description !== 'string' || locale.meta.description.trim().length < 40) fail(`locale_metadata_required:${relative}`)
      if (/my decoration|draws a badge under the composer|installed successfully/i.test(`${locale.meta.title} ${locale.meta.description}`)) fail(`stale_locale_metadata:${relative}`)
      if (locale.meta.detail !== undefined) {
        if (typeof locale.meta.detail !== 'string' || !/\.(?:md|markdown)$/.test(locale.meta.detail) || pathError(locale.meta.detail)) fail(`unsafe_detail_path:${relative}`)
        const detail = localPath(`./${locale.meta.detail}`)
        if (!manifest.files.some((entry) => entry === 'docs' || entry.startsWith('docs/'))) fail(`detail_directory_not_in_files:${relative}`)
        const detailBytes = await readSafe(root, detail, LIMITS.readme); strictUtf8(detailBytes); await add(detail, detailBytes)
      }
    }
    if (relative === 'README.md') readmeText = text
    if (relative === localPath(manifest.exports['./icon'])) {
      const extension = relative.slice(relative.lastIndexOf('.') + 1)
      const valid = extension === 'svg' ? /^\s*<svg(?:\s|>)[^]*<\/svg>\s*$/i.test(text) && !/<(?:html|script|foreignObject)(?:\s|>)|\son\w+\s*=|<!DOCTYPE/i.test(text)
        : extension === 'png' ? bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString('ascii') === 'IHDR'
        : extension === 'jpg' || extension === 'jpeg' ? bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
        : bytes.length >= 16 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      if (!valid) fail('icon_bytes_do_not_match_declared_format')
    }
  }
  if (!/node --check plugins\/dsh-loom\/index\.js/.test(readmeText) || !/not installed by this repository/.test(readmeText)) fail('readme_entrypoints_or_limits_missing')
  records.push(check('payload.metadata', 'pass', { file_count: files.size, total_bytes: [...files.values()].reduce((n, file) => n + file.size, 0), locales: sorted.filter((path) => path.startsWith('locale/')), icon: localPath(manifest.exports['./icon']) }))

  const staticImports = new Set()
  const dependencies = Object.entries(manifest.dependencies || {})
  const declared = new Set(dependencies.map(([name]) => name))
  for (const file of files.values()) if (/\.(?:js|mjs|cjs)$/.test(file.path)) {
    const source = strictUtf8(await readSafe(root, file.path, LIMITS.source))
    const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]; staticImports.add(specifier)
      if (!specifier.startsWith('.')) continue
      const target = resolve(root, dirname(file.path), specifier)
      if (specifier.includes('\\')) fail('relative_import_escapes_root')
      if (!target.startsWith(root + sep)) fail('relative_import_escapes_root')
      const relative = target.slice(root.length + 1).split(sep).join('/')
      const info = await lstat(target).catch(() => fail(`missing_relative_import:${relative}`))
      if (info.isSymbolicLink() || !info.isFile() || !files.has(relative)) fail(`unincluded_relative_import:${relative}`)
    }
    for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) staticImports.add(match[1])
  }
  for (const specifier of staticImports) {
    if (specifier.startsWith('node:') || specifier.startsWith('.')) continue
    const parts = specifier.split('/'); const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (packageName === '@loom/dsh-fixture-stub-provider' && specifier === '@loom/dsh-fixture-stub-provider/delegation') continue
    if (specifier.includes('\\') || !declared.has(packageName)) fail(`undeclared_external_import:${packageName}`)
  }
  for (const [name, version] of dependencies) if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`external_dependency_must_be_exact:${name}`)
  records.push(check('source.import_contract', 'pass', { dependency_declarations: dependencies.map(([name, version]) => `${name}@${version}`), profile_or_network_scan: false }))
  return frozen({ root, manifest, patch, checks: records, files: [...files.values()], dependencyRoot, pack, npmCommand, packageId, exportIds: Object.keys(manifest.exports).sort() })
}

export async function runBundlePreflight(options = {}) {
  const checks = []
  let inspected
  try {
    inspected = options.inspected || await inspectBundle(options)
  } catch (error) {
    const code = error instanceof PreflightError ? error.code : 'preflight_internal_error'
    const fields = inspected ? { manifest_id: inspected.packageId, export_ids: inspected.exportIds, files: inspected.files, dependencies: Object.entries(inspected.manifest.dependencies || {}).map(([name, version]) => ({ name, version, resolution: 'rejected before import' })) } : error instanceof PreflightError && error.fields ? { ...error.fields, files: [], dependencies: [] } : { manifest_id: 'unverified', export_ids: [], files: [], dependencies: [] }
    const report = { schema: 'loom.bundle-preflight.v1', generated_at: new Date().toISOString(), ...fields, provenance: { kind: 'synthetic fixture source declared', trust: 'unverified input; not installed, registered, enabled, granted, or signed' }, checks: [{ id: 'input.validation', status: 'fail', detail: code }, { id: 'apply.activation', status: 'not_run', detail: 'apply was not invoked.' }], outcome: 'fail' }
    return frozen(report)
  }
  const { root, manifest, files, patch } = inspected; checks.push(...inspected.checks)
  let workspace
  try {
    workspace = await mkdtemp(join(tmpdir(), 'loom-bundle-preflight-'))
    const bundleRoot = join(workspace, 'bundle'); await mkdir(bundleRoot, { mode: 0o700 })
    for (const file of files) {
      const target = join(bundleRoot, ...file.path.split('/')); await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await cp(join(root, ...file.path.split('/')), target); if (process.platform !== 'win32') await (await import('node:fs/promises')).chmod(target, 0o600)
    }
    const syntax = await boundedProcess(process.execPath, ['--check', 'index.js'], { cwd: bundleRoot, home: workspace })
    checks.push(check('source.node_check', syntax.code === 0 ? 'pass' : 'fail', { executable: 'process.execPath', exit_code: syntax.code, timed_out: syntax.timedOut, output_bytes: syntax.stdoutBytes + syntax.stderrBytes }))
    if (syntax.code !== 0) throw new PreflightError('node_syntax_check_failed')
    const imports = await boundedImport(bundleRoot, workspace, manifest, options.dependencyRoot ?? inspected.dependencyRoot)
    checks.push(...imports)
    if (options.dependencyRoot !== undefined) checks.push(check('module.host_dependency_compatibility', 'not_run', 'Explicit fixture schema was used only to inspect exports; real Host dependency compatibility was not tested.'))
    if (inspected.pack) checks.push(await packInventory(bundleRoot, workspace, inspected.npmCommand, files, options.packArgs))
  } catch (error) {
    checks.push(check('verification.stage', 'fail', error instanceof PreflightError ? error.code : 'verification_internal_error'))
  }
  checks.push(check('input.isolated', 'pass', 'Ephemeral test-owned copy is removed after every check. No Profile, credential store, registry or network used.'))
  if (workspace && process.platform !== 'win32') { const { chmod } = await import('node:fs/promises'); await chmod(workspace, 0o700).catch(() => {}) }
  if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => {})
  const failed = checks.some((item) => item.status === 'fail')
  const report = {
    schema: 'loom.bundle-preflight.v1', generated_at: new Date().toISOString(), manifest_id: `${manifest.name}@${manifest.version}`,
    provenance: { kind: 'synthetic fixture source declared', root: 'derived from provided input root; not a verified installed profile path', trust: 'unverified input; not installed, registered, enabled, granted, or signed', evaluated_copy: 'ephemeral test-owned copy, removed after checking' },
    export_ids: Object.keys(manifest.exports).sort(),
    checks, files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
    dependencies: Object.entries(manifest.dependencies || {}).map(([name, version]) => ({ name, version, resolution: checks.find((item) => item.id === 'module.dynamic_import')?.status === 'not_run' ? 'required package-local dependency absent; import not run' : 'resolved only in controlled test copy' })),
    config_defaults: { ...SAFE_CONFIG },
    activation: { apply_invoked: false, registration_performed: false, configuration_mutated: false, capability_is_grant: false },
    outcome: failed ? 'fail' : 'static_pass_runtime_not_run',
  }
  return frozen(report)
}

async function boundedImport(root, workspace, manifest, dependencyRoot) {
  const checks = []; const missing = []
  for (const [name, version] of Object.entries(manifest.dependencies || {})) {
    const dependency = join(root, 'node_modules', ...name.split('/'))
    if (dependencyRoot !== undefined) {
      if (typeof dependencyRoot !== 'string' || !isAbsolute(dependencyRoot)) fail('explicit_absolute_dependency_root_required')
      const source = join(await realpath(dependencyRoot).catch(() => fail('dependency_root_missing')), ...name.split('/'))
      const packageBytes = await readFile(join(source, 'package.json')).catch(() => fail('explicit_dependency_missing'))
      const pkg = parseJsonStrict(strictUtf8(packageBytes))
      if (pkg.name !== name || pkg.version !== version) fail('explicit_dependency_identity_mismatch')
      await mkdir(dirname(dependency), { recursive: true, mode: 0o700 }); await cp(source, dependency, { recursive: true, dereference: true, force: false })
      checks.push(check('module.external_dependency', 'pass', { name, version, resolution: 'explicit fixture dependency root copied; not host compatibility certification' }))
    } else {
      const info = await lstat(dependency).catch(() => null)
      if (!info) { missing.push(name); continue }
      if (info.isSymbolicLink()) fail('symlink_dependency_rejected')
      const pkg = parseJsonStrict(strictUtf8(await readFile(join(dependency, 'package.json'))))
      if (pkg.name !== name || pkg.version !== version) fail('local_dependency_identity_mismatch')
      checks.push(check('module.external_dependency', 'pass', { name, version, resolution: 'package-local node_modules; runtime compatibility remains unverified' }))
    }
  }
  if (missing.length) return [...checks, check('module.dynamic_import', 'not_run', { reason: 'required declared external dependency absent from package-local node_modules', dependency_count: missing.length }), check('apply.activation', 'not_run', 'Import shape not verified; apply and mock ctx were never invoked.')]
  const runner = join(workspace, 'import-probe.mjs')
  await writeFile(runner, `const module = await import(${JSON.stringify(pathToFileURL(join(root, 'index.js')).href)})\ntry {\n process.stdout.write(JSON.stringify({apply_type:typeof module.apply,arity:module.apply.length,inject:module.inject,config_type:typeof module.Config,config_shape:module.Config?.shape}))\n} catch { process.exitCode=2 }`, { mode: 0o600 })
  const result = await boundedProcess(process.execPath, [runner], { cwd: root, home: workspace })
  if (result.code === 0) {
    try {
      const value = JSON.parse(result.stdout)
      if (value.apply_type !== 'function' || value.arity !== 2 || !Array.isArray(value.inject) || value.inject.some((name) => typeof name !== 'string') || !EXPECTED.inject.every((name) => value.inject.includes(name)) || !value.inject.includes('llm') || value.config_type !== 'object' || !value.config_shape) fail('host_export_shape_mismatch')
      if (value.config_shape.enabled?.defaultValue !== false || value.config_shape.allow_workers?.defaultValue !== false || value.config_shape.executor?.defaultValue !== 'unsupported') fail('schema_default_mismatch')
      checks.push(check('module.dynamic_import', 'pass', 'Copied index.js imported without calling apply: native apply(ctx, config), Config schema object and required inject names observed.'))
      checks.push(check('apply.activation', 'not_run', 'Import-only structural probe; no ctx/effect, registration, scheduler, UI, credentials, or Host activation.'))
    } catch (error) { checks.push(check('module.dynamic_import', 'fail', error instanceof PreflightError ? error.code : 'invalid_import_probe_response')) }
  } else {
    checks.push(check('module.dynamic_import', 'fail', { reason: result.timedOut ? 'bounded_import_timeout' : 'bounded_import_failed', exit_code: result.code, output_bytes: result.stdoutBytes + result.stderrBytes }))
  }
  return checks
}

async function boundedProcess(executable, args, { cwd, home, pack = false }) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, shell: false, timeout: 15_000, env: { HOME: join(home, 'home'), PATH: process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin', ...(pack ? { npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let stderrBytes = 0; let stdoutBytes = 0; let overflow = false
    child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes <= 32768) stdout += chunk.toString('utf8'); else overflow = true })
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes <= 8192) stderr += chunk.toString('utf8'); else overflow = true })
    child.once('error', (error) => resolve({ code: null, errno: error.code || 'SPAWN_ERROR', stdout, stdoutBytes, stderrBytes, timedOut: false }))
    child.once('close', (code, signal) => resolve({ code, signal: signal || null, stdout, stderr, stdoutBytes, stderrBytes, timedOut: signal === 'SIGTERM', overflow }))
  })
}
async function packInventory(root, home, npmCommand, sourceFiles, extraArgs = []) {
  if (typeof npmCommand !== 'string' || !npmCommand || !Array.isArray(extraArgs)) return check('package.dry_run', 'not_run', 'npm unavailable or explicitly not supplied; nothing downloaded, installed, or written as a tarball.')
  if (extraArgs.some((arg) => typeof arg !== 'string' || arg.length > 1024)) return check('package.dry_run', 'fail', 'unsafe_pack_fixture_arguments')
  const result = await boundedProcess(npmCommand, [...extraArgs, 'pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], { cwd: root, home, pack: true })
  if (result.code !== 0) return check('package.dry_run', result.code === null ? 'not_run' : 'fail', { reason: result.code === null ? 'npm_spawn_failed' : 'npm_pack_failed', exit_code: result.code, errno: result.errno || null, output_bytes: result.stdoutBytes + result.stderrBytes })
  if (result.overflow) return check('package.dry_run', 'fail', 'bounded_pack_output_exceeded')
  try {
    const value = JSON.parse(result.stdout)
    if (!Array.isArray(value) || value.length !== 1) fail('unexpected_pack_json')
    const packed = value[0].files.map((file) => file.path)
    const missing = sourceFiles.filter((file) => file.path !== 'package.json' && !packed.includes(file.path)).map((file) => file.path)
    if (missing.length) return check('package.dry_run', 'fail', { missing_count: missing.length, missing: missing.slice(0, 16) })
    return check('package.dry_run', 'pass', { packed_file_count: packed.length, verified_source_payload_bytes: sourceFiles.reduce((sum, file) => sum + file.size, 0), tarball_created: false, registered: false })
  } catch { return check('package.dry_run', 'fail', 'invalid_npm_json') }
}
