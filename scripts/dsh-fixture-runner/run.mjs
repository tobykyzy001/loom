#!/usr/bin/env node
import { runRealLifecycle } from '../../tests/harness/real-lifecycle.mjs'

const result = await runRealLifecycle()
console.log(JSON.stringify(result, null, 2))
if (result.overall !== 'PASS') process.exitCode = 1
