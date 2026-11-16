import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

async function path(file) { return fileURLToPath(new URL(file, import.meta.url)) }
test('Host-only bundle has matching metadata, manifest exports and safe defaults', async () => {
  const manifest = JSON.parse(await readFile(await path('../package.json'), 'utf8'))
  assert.equal(manifest.type, 'module'); assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['.'], './index.js'); assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.deepEqual(Object.keys(manifest.dependencies), ['@deepseek-ai/schemastery'])
  for (const locale of ['en', 'zh']) {
    const text = JSON.parse(await readFile(await path(`../locale/${locale}.json`), 'utf8'))
    assert.equal(typeof text.meta.title, 'string'); assert.ok(text.meta.description.length > 40)
    assert.doesNotMatch(text.meta.description, /token=.*|api[_-]?key|installed successfully/i)
  }
  const patch = await readFile(await path('../cordis.patch.yml'), 'utf8')
  assert.match(patch, /enabled: false/); assert.match(patch, /allow_workers: false/); assert.match(patch, /executor: 'unsupported'/)
  const svg = await readFile(await path('../icon.svg'), 'utf8')
  assert.match(svg, /viewBox="0 0 36 36"/); assert.doesNotMatch(svg, /<(?:script|style|image|foreignObject)|\son\w+=/)
  const index = await readFile(await path('../index.js'), 'utf8')
  assert.doesNotMatch(index, /appendPluginRecord|session\.append/)
  assert.equal((await readFile(await path('../README.md'), 'utf8')).includes('not installed by this repository'), true)
})
