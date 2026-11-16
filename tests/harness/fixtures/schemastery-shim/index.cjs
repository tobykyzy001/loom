'use strict'
// Created per disposable fixture with its DSH anchor. No internet package or private source copy.
const anchor = process.env.LOOM_DSH_INSTALL_DIR
if (!anchor || !anchor.includes('/dsh/node_modules/@deepseek-ai/dsh')) {
  throw new Error('Schemastery test shim requires a verified isolated DSH installation anchor')
}
const { createRequire } = require('node:module')
const installed = createRequire(anchor + '/package.json')
const manifest = installed('@deepseek-ai/schemastery/package.json')
if (manifest.name !== '@deepseek-ai/schemastery' || manifest.version !== '3.19.0') {
  throw new Error('Test shim would forward to an unexpected Schemastery package')
}
module.exports = installed('@deepseek-ai/schemastery')
