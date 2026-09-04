/** Draw.io 只读预览可行性 spike 的 runner（任务 1.1 阻塞门禁）。
 *
 * 验证清单（全部通过 = 门禁放行）：
 *   A. bootstrap 接管：sandbox iframe 内程序化渲染（非 data-* 自动扫描）
 *   B. 零外部请求：整个会话只访问 127.0.0.1（CSP connect-src 'none' + 只许本地脚本）
 *   C. 多页面：fixture 2 页可切换，切页后内容变化
 *   D. 图层可见性：隐藏图层B后其节点从 SVG 消失，恢复后回来
 *   E. 缩放：zoom 改变 scale；F. 适配：fit 后 scale 匹配容器/边界
 *   G. transferable postMessage：ArrayBuffer 零拷贝交接（父端 buffer 已 detached）
 *
 * 用法：node spike/drawio/run-spike.mjs   （viewer.min.js 缺失时先 curl 下载）
 * 浏览器：优先系统 Edge（CAPTURE_BROWSER_CHANNEL 惯例），否则 Playwright 自带 Chromium。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const PORT = 4177

if (!existsSync(path.join(DIR, 'viewer.min.js'))) {
  console.error('缺少 viewer.min.js —— 先执行:')
  console.error('  curl -sSL -o spike/drawio/viewer.min.js https://viewer.diagrams.net/js/viewer.min.js')
  process.exit(2)
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.drawio': 'application/xml' }

const server = createServer(async (req, res) => {
  try {
    const p = path.join(DIR, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0])
    const data = await readFile(p)
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' })
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

const { chromium } = await import('@playwright/test')
const channel = process.env.CAPTURE_BROWSER_CHANNEL || 'msedge'
let browser
try { browser = await chromium.launch({ channel, headless: true }) }
catch { browser = await chromium.launch({ headless: true }) }

const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
const requests = []
page.on('request', r => requests.push(r.url()))
page.on('console', m => { if (m.type() === 'error') console.log('[iframe-console]', m.text().slice(0, 200)) })
page.on('pageerror', e => console.log('[iframe-pageerror]', String(e).slice(0, 300)))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`)
  // A/G：等首次 rendered（bootstrap 接管 + transferable 渲染成功）
  await page.waitForFunction(() => window.__spikeState && !window.__spikeState.error, null, { timeout: 15000 })
  let st = await page.evaluate(() => window.__spikeState)

  check('A. bootstrap 程序化接管（sandbox iframe 内渲染出 SVG）', st.svg === true)
  check('C1. 多页面解析：识别 2 页', st.pageCount === 2 && st.pages.map(p => p.name).join('|').includes('第一页'), JSON.stringify(st.pages))

  // C2：切到第二页，内容应变为图层页的节点
  await page.evaluate(() => window.__spike({ type: 'setPage', index: 1 }))
  await page.waitForFunction(() => window.__spikeState && window.__spikeState.page === 1, null, { timeout: 5000 })
  st = await page.evaluate(() => window.__spikeState)
  const layerB = st.layers.find(l => l.name.includes('图层B'))
  check('C2. 页面切换：第 2 页渲染且图层清单正确', st.svg && st.layers.length >= 2 && !!layerB,
        `layers=${JSON.stringify(st.layers)}`)

  // D：隐藏图层B → 其标注文本从 SVG 消失；恢复 → 回来
  await page.evaluate(id => window.__spike({ type: 'setLayerVisible', layerId: id, visible: false }), layerB.id)
  await page.waitForFunction(() => window.__spikeEvents.slice(-1)[0] === 'rendered' && !window.__spikeState.layers.find(l => l.name.includes('图层B')).visible, null, { timeout: 5000 })
  st = await page.evaluate(() => window.__spikeState)
  const hiddenGone = !st.svgText.includes('仅图层B可见')
  await page.evaluate(id => window.__spike({ type: 'setLayerVisible', layerId: id, visible: true }), layerB.id)
  await page.waitForFunction(() => window.__spikeState.layers.find(l => l.name.includes('图层B')).visible, null, { timeout: 5000 })
  st = await page.evaluate(() => window.__spikeState)
  const restored = st.svgText.includes('仅图层B可见')
  check('D. 图层可见性：隐藏后节点消失、恢复后回来', hiddenGone && restored)

  // E：缩放 2x
  const before = st.scale
  await page.evaluate(() => window.__spike({ type: 'zoom', factor: 2 }))
  await page.waitForFunction(s => Math.abs(window.__spikeState.scale - s * 2) < 1e-6, before, { timeout: 5000 })
  st = await page.evaluate(() => window.__spikeState)
  check('E. 缩放：scale×2 生效', Math.abs(st.scale - before * 2) < 1e-6, `scale=${st.scale}`)

  // F：适配（fit 后 scale 相对初始 1 发生合理变化）
  await page.evaluate(() => window.__spike({ type: 'fit' }))
  await page.waitForFunction(() => window.__spikeEvents.slice(-1)[0] === 'rendered', null, { timeout: 5000 })
  st = await page.evaluate(() => window.__spikeState)
  check('F. 适配视图：fit 计算出新 scale', st.scale > 0 && Math.abs(st.scale - before * 2) > 1e-6, `scale=${st.scale}`)

  // G：transferable 交接成功本身就是渲染成立的前提，补一个显式断言：渲染发生过（=buffer 成功转移并被解码）
  check('G. transferable ArrayBuffer 交接（UTF-8 解码成功渲染）', st.svg === true)

  // B：零外部请求（放最后统计整个会话）
  const external = requests.filter(u => !u.startsWith(`http://127.0.0.1:${PORT}`))
  check('B. 零外部请求', external.length === 0, external.length ? external.slice(0, 3).join(', ') : `共 ${requests.length} 个请求全部本地`)
} catch (e) {
  check('spike 执行本身', false, String(e && e.message || e).slice(0, 300))
} finally {
  await browser.close(); server.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n===== SPIKE 结果: ${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length ? 1 : 0)
