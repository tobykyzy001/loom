#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { runRealIntegration } from './real-integration.mjs'

const outputDirectory = process.env.LOOM_REAL_OUTPUT_DIR || await mkdtemp(join(tmpdir(), 'loom-real-integration-result-'))
await mkdir(outputDirectory, { recursive: true })
const startedAt = new Date().toISOString()
const result = await runRealIntegration()
result.started_at = startedAt
result.finished_at = new Date().toISOString()
const file = join(outputDirectory, 'real-integration-result.json')
await writeFile(file, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
console.log(`Real integration result: ${file}`)
if (result.overall !== 'PASS') process.exitCode = 1
