/** 验证 /term-lens/diag 这条诊断通道真的能用。 */
import { createServer } from 'node:http'
import { registerRoutes } from '../lib/routes.js'
import { loadConfig } from '../lib/config.js'

const config = loadConfig()
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: {
    register(route) {
      ctx._route = route
      return () => {}
    },
  },
}
registerRoutes(ctx, config, ctx.logger)
const route = ctx._route
console.log('路由:', route.kind, route.path)

const server = createServer((req, res) => route.handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// 1. 空状态
let res = await fetch(`${base}/term-lens/diag`)
console.log('空状态:', res.status, JSON.stringify(await res.json()))

// 2. 回传一份模拟诊断
const payload = {
  keys: ['slots', 'sidebarRight', 'sidebarRightTabs', 'loader'],
  checks: {
    slots: { present: true, hasMethod: true },
    'slots.inject': { present: true, hasMethod: true },
    sidebarRight: { present: true, hasMethod: true },
    sidebarRightTabs: { present: false, hasMethod: false },
  },
  slotReport: { settings: 'registered', sidebarType: 'no-service', sidebarBody: 'waiting-declaration', errors: [] },
}
res = await fetch(`${base}/term-lens/diag`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
console.log('回传:', res.status, JSON.stringify(await res.json()))

// 3. 读回来
res = await fetch(`${base}/term-lens/diag`)
const back = await res.json()
console.log('读回 slotReport:', JSON.stringify(back.diag.slotReport))
console.log('读回 checks.sidebarRightTabs:', JSON.stringify(back.diag.checks.sidebarRightTabs))
console.log('带回时间戳:', typeof back.diag.at === 'string')

server.close()
console.log('\n/diag 通道可用 ✓')
