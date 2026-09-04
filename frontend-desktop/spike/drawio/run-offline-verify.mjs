/** 任务 1.4：对 vendored 官方 viewer 做断网验证。
 *
 *  与 spike 的区别：加载的是 public/vendor/drawio/31.4.2/ 的正式固化副本 +
 *  public/drawio-preview/ 的生产 bootstrap；并用 Playwright 路由拦截把
 *  一切非 127.0.0.1 请求直接 abort（比"断网"更硬：连 DNS/握手都不发生）。
 *
 *  断言：
 *    1. 渲染出 SVG（viewer/标准 shapes/系统字体在 connect-src 'none' 下可用）
 *    2. 多页面解析正常
 *    3. 零外部请求【尝试】（被 abort 的也计入失败——CSP+存根应当让尝试根本不发生）
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SPIKE = path.join(path.dirname(fileURLToPath(import.meta.url)))
const PUBLIC_DIR = path.join(SPIKE, '..', '..', 'public')
const PORT = 4179

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.drawio': 'application/xml', '.json': 'application/json', '.txt': 'text/plain',
}

const server = createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0]
    const base = url.startsWith('/vendor/') || url.startsWith('/drawio-preview/') ? PUBLIC_DIR : SPIKE
    const p = path.join(base, url === '/' ? 'index.html' : url)
    const data = await readFile(p)
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' })
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

const PARENT_HTML = `<!doctype html><body style="margin:0">
<iframe id="frame" sandbox="allow-scripts" src="/drawio-preview/bootstrap.html"
        style="width:900px;height:600px;border:1px solid #ccc"></iframe>
<script>
(function () {
  var iframe = document.getElementById('frame');
  var token = null;
  window.__spikeEvents = [];
  window.__spikeState = null;
  window.addEventListener('message', function (ev) {
    if (ev.source !== iframe.contentWindow) return;
    var msg = ev.data;
    if (!msg || (msg.token !== token && msg.type !== 'ready')) return;
    if (msg.type === 'ready') {
      token = msg.token;
      fetch('/spike-fixture.drawio')
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { iframe.contentWindow.postMessage({ type: 'render', token: token, buf: buf }, '*', [buf]); });
      return;
    }
    if (msg.type === 'rendered') { window.__spikeState = msg.state; window.__spikeEvents.push(msg.type); }
    if (msg.type === 'error') { window.__spikeState = { error: msg.code, message: msg.message }; window.__spikeEvents.push(msg.type); }
  });
  window.__spike = function (cmd) { iframe.contentWindow.postMessage(Object.assign({ token: token }, cmd), '*'); };
})();
</script></body>`

const { chromium } = await import('@playwright/test')
let browser
try { browser = await chromium.launch({ channel: process.env.CAPTURE_BROWSER_CHANNEL || 'msedge', headless: true }) }
catch { browser = await chromium.launch({ headless: true }) }

const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
const attempts = []
await context.route('**/*', route => {
  const url = route.request().url()
  if (url.startsWith(`http://127.0.0.1:${PORT}`)) return route.continue()
  attempts.push(url)
  return route.abort()      // 硬断网：非本地一律拒绝，且把"尝试"记下来当失败证据
})

const page = await context.newPage()
page.on('console', m => { if (m.type() === 'error') console.log('[console-err]', m.text().slice(0, 160)) })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

try {
  await page.route(`http://127.0.0.1:${PORT}/`, route =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: PARENT_HTML }))
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await page.waitForFunction(() => window.__spikeState && !window.__spikeState.error, null, { timeout: 15000 })
  const st = await page.evaluate(() => window.__spikeState)

  check('1. vendored viewer + 生产 bootstrap 断网渲染出 SVG（viewer/shapes/系统字体无需 XHR）', st.svg === true)
  check('2. 多页面解析正常', st.pageCount === 2, JSON.stringify(st.pages && st.pages.map(p => p.name)))
  check('3. 零外部请求尝试（CSP + MathJax 存根兜底）', attempts.length === 0,
        attempts.length ? attempts.slice(0, 3).join(', ') : '无任何非本地请求')
} catch (e) {
  check('断网验证执行本身', false, String(e && e.message || e).slice(0, 250))
} finally {
  await browser.close(); server.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n===== 1.4 断网验证: ${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length ? 1 : 0)
