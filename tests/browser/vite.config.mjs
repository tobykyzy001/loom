// Test-owned Vite server; never modifies or attaches to the DSH Web GUI.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '../../apps/web/node_modules/vite/dist/node/index.js'
import vue from '../../apps/web/node_modules/@vitejs/plugin-vue/dist/index.mjs'

const root = fileURLToPath(new URL('../../apps/web/', import.meta.url))
const targetValue = process.env.LOOM_TEST_CONCIERGE_URL
if (!targetValue) throw new Error('LOOM_TEST_CONCIERGE_URL must explicitly name this test Concierge')
const target = new URL(targetValue)
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/' || target.username || target.password) {
  throw new Error('The browser fixture may only proxy to an owned loopback Concierge')
}

export default defineConfig({
  root,
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': { target: target.origin, changeOrigin: true } },
    fs: { allow: [resolve(root, '..')] },
  },
})
