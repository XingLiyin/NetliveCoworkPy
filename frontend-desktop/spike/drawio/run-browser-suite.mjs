/** Draw.io 预览综合浏览器套件（任务 4.3 / 5.1 / 5.2 / 5.3-跨源）。
 *
 *  覆盖：
 *   4.3 恶意 fixture：远程图片/脚本/链接在 Draw.io iframe 内零外部请求尝试、点击不导航；
 *       请求观察器按"非本地即失败"硬断网（比 frame/initiator 过滤更严）。
 *   5.1 格式矩阵：压缩 / 未压缩多页多图层中文 / 内嵌图片 / 未知 stencil（非阻塞警告）/
 *       非法 XML（可恢复错误）。
 *   5.2 刷新保状态：切页 + 缩放后 refresh，页面/缩放保留，新内容可见。
 *   5.3 跨源回归：父页面加载另一 origin（不同端口）的图片不受 Draw.io 隔离影响。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SPIKE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(SPIKE, '..', '..', 'public')
const PORT = 4180, PORT2 = 4181          // 两个端口 = 两个 origin（5.3 跨源回归用）

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.drawio': 'application/xml', '.png': 'image/png' }
const serve = dir => createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0]
    const base = url.startsWith('/vendor/') || url.startsWith('/drawio-preview/') ? PUBLIC_DIR : SPIKE
    const data = await readFile(path.join(base, url === '/' ? 'index.html' : url))
    res.writeHead(200, { 'content-type': MIME[path.extname(url)] || 'application/octet-stream' })
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
const s1 = serve()
const s2 = createServer(async (req, res) => {
  // 跨源资源带 ACAO：证明"别的 origin 仍可用"，而不是被 Draw.io 的隔离株连。
  try {
    const data = await readFile(path.join(SPIKE, 'cross-origin.png'))
    res.writeHead(200, { 'content-type': 'image/png', 'Access-Control-Allow-Origin': '*' })
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await Promise.all([
  new Promise(r => s1.listen(PORT, '127.0.0.1', r)),
  new Promise(r => s2.listen(PORT2, '127.0.0.1', r)),
])

const PARENT = fixturePath => `<!doctype html><body style="margin:0">
<img id="cross" src="http://127.0.0.1:${PORT2}/cross.png" style="display:none">
<iframe id="frame" sandbox="allow-scripts" src="/drawio-preview/bootstrap.html"
        style="width:900px;height:600px;border:1px solid #ccc"></iframe>
<script>
(function () {
  var iframe = document.getElementById('frame');
  var token = null;
  window.__events = []; window.__state = null;
  window.addEventListener('message', function (ev) {
    if (ev.source !== iframe.contentWindow) return;
    var m = ev.data;
    if (!m || (m.token !== token && m.type !== 'ready')) return;
    if (m.type === 'ready') {
      token = m.token;
      fetch(${JSON.stringify(fixturePath)})
        .then(r => r.arrayBuffer())
        .then(buf => iframe.contentWindow.postMessage({ type: 'render', token: token, buf: buf }, '*', [buf]));
      return;
    }
    if (m.type === 'rendered' || m.type === 'snapshot') { window.__state = m.state; window.__events.push(m.type); }
    else window.__events.push(m.type + (m.code ? ':' + m.code : '') + (m.message ? ':' + m.message : ''));
  });
  window.__send = function (buf, kind) { iframe.contentWindow.postMessage({ type: kind || 'refresh', token: token, buf: buf }, '*', [buf]); };
  window.__cmd = function (cmd) { iframe.contentWindow.postMessage(Object.assign({ token: token }, cmd), '*'); };
})();
</script></body>`

const { chromium } = await import('@playwright/test')
let browser
const launchArgs = { headless: true, args: [
  // Edge 的跟踪防护会把跨站 <img> 当跟踪器拦掉（"Permission was denied"），与本套件要验证的
  // "Draw.io 隔离不株连其他 origin"是两回事——禁用后才能测真实的 CSP/沙箱边界。
  '--disable-features=msTrackingProtection,TrackingProtection,msSmartScreenProtection',
] }
try { browser = await chromium.launch({ channel: process.env.CAPTURE_BROWSER_CHANNEL || 'msedge', ...launchArgs }) }
catch { browser = await chromium.launch(launchArgs) }
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
const attempts = []
// 本地请求显式 fetch+fulfill 转发（continue/fallback 在这个 Edge 上会破坏跨源请求的
// CORS 判定——那是测试设施问题，不是被测物问题）；非本地一律 abort 且计入 attempts。
await context.route('**/*', async route => {
  const u = route.request().url()
  const local = u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith(`http://127.0.0.1:${PORT2}`)
  if (local) {
    const resp = await route.fetch()
    return route.fulfill({ response: resp })
  }
  attempts.push(u)
  return route.abort()
})

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`) }

const frameOf = p => p.frames().find(f => f.url().includes('bootstrap.html'))

async function openFixture(name) {
  const page = await context.newPage()
  page.on('console', m => { if (m.type() === 'error') console.log('[console-err]', m.text().slice(0, 160)) })
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)))
  await page.route(`http://127.0.0.1:${PORT}/`, r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: PARENT(name) }))
  await page.goto(`http://127.0.0.1:${PORT}/`)
  return page
}
// 谓词用字符串（Playwright 的 waitForFunction 不接受跨边界的函数参数）。
const waitState = (page, cond, ms = 12000) => page.waitForFunction(cond, undefined, { timeout: ms })

try {
  // ── 5.1 格式矩阵 ─────────────────────────────────────────────
  {
    const p = await openFixture('/drawio-preview/fixtures/compressed.drawio')
    try { await waitState(p, '!!(window.__state && window.__state.svg)') }
    catch (e) {
      console.log('[diag] events =', JSON.stringify(await p.evaluate(() => window.__events)))
      console.log('[diag] state =', JSON.stringify(await p.evaluate(() => window.__state)))
      const f = p.frames().find(fr => fr.url().includes('bootstrap'))
      if (f) console.log('[diag] frame errors =', await f.evaluate(() => window.__err || 'n/a').catch(() => 'n/a'))
      throw e
    }
    const st = await p.evaluate(() => window.__state)
    check('5.1 压缩 <diagram>（base64+raw-deflate）可渲染', st.svg === true && st.pages[0].name === '压缩页', JSON.stringify(st.pages))
    await p.close()
  }
  {
    const p = await openFixture('/drawio-preview/fixtures/embedded-image.drawio')
    await waitState(p, '!!(window.__state && window.__state.svg)')
    const n = await frameOf(p).evaluate(() => document.querySelectorAll('#graph image, #graph img').length)
    check('5.1 内嵌图片（data: URI）渲染', n > 0, `image nodes=${n}`)
    await p.close()
  }
  {
    const p = await openFixture('/drawio-preview/fixtures/unknown-stencil.drawio')
    await waitState(p, '!!(window.__state && window.__state.svg)')
    const evs = await p.evaluate(() => window.__events)
    const svgText = await frameOf(p).evaluate(() => (document.querySelector('#graph svg') || { textContent: '' }).textContent)
    check('5.1 未知 stencil → 非阻塞警告且其余内容保留',
      evs.some(e => String(e).startsWith('warning:missing-stencils:mxgraph.fake.notexist')) && svgText.includes('正常节点'),
      `events=${JSON.stringify(evs)}`)
    await p.close()
  }
  {
    const p = await openFixture('/drawio-preview/fixtures/invalid.drawio')
    await p.waitForFunction(() => window.__events.some(e => String(e).startsWith('error')), null, { timeout: 12000 })
    const evs = await p.evaluate(() => window.__events)
    check('5.1 非法 XML → 可恢复错误（无在线 fallback）', evs.some(e => String(e).startsWith('error')), JSON.stringify(evs))
    await p.close()
  }
  {
    // 未压缩多页多图层中文（1.4 已验过基础，这里补中文内容可见）
    const p = await openFixture('/spike-fixture.drawio')
    await waitState(p, '!!(window.__state && window.__state.svg)')
    const txt = await frameOf(p).evaluate(() => (document.querySelector('#graph svg') || { textContent: '' }).textContent)
    if (!txt.includes('中文节点')) {
      console.log('[diag-cn] state =', JSON.stringify(await p.evaluate(() => window.__state)))
      console.log('[diag-cn] events =', JSON.stringify(await p.evaluate(() => window.__events)))
    }
    check('5.1 未压缩多页 + 中文内容可见', txt.includes('中文节点'), txt.slice(0, 60))
    await p.close()
  }

  // ── 4.3 恶意 fixture ─────────────────────────────────────────
  {
    const p = await openFixture('/drawio-preview/fixtures/malicious.drawio')
    await waitState(p, '!!(window.__state && window.__state.svg)')
    const st = await p.evaluate(() => window.__state)
    check('4.3 恶意图表仍渲染出正常节点', st.svg === true)
    // 点击 iframe 内链接（若有渲染出的 <a>）→ 不导航
    const frame = p.frames().find(f => f.url().includes('bootstrap.html'))
    if (frame) {
      const before = frame.url()
      await frame.evaluate(() => { const a = document.querySelector('a'); if (a) a.click(); return !!a })
      await p.waitForTimeout(400)
      check('4.3 恶意链接点击不导航', frame.url() === before, `anchor clicked, url=${frame.url().slice(-30)}`)
    } else {
      check('4.3 恶意链接点击不导航（frame 不可达，跳过点击）', false, 'frame not found')
    }
    const evil = attempts.filter(u => u.includes('evil.example'))
    check('4.3 零外部请求尝试（远程图/脚本/字体全被 CSP+存根挡在尝试之外）', evil.length === 0, evil.length ? evil.join(',') : '无')
    await p.close()
  }

  // ── 5.2 刷新保状态 ───────────────────────────────────────────
  {
    const p = await openFixture('/spike-fixture.drawio')
    await waitState(p, '!!(window.__state && window.__state.svg)')
    await p.evaluate(() => window.__cmd({ type: 'setPage', index: 1 }))
    await waitState(p, 'window.__state && window.__state.page === 1')
    await p.evaluate(() => window.__cmd({ type: 'zoom', factor: 2 }))
    await waitState(p, 'window.__state && Math.abs(window.__state.scale - 2) < 1e-6')
    // 改内容（第 2 页加一个新节点）后 refresh
    const edited = await readFile(path.join(SPIKE, 'spike-fixture.drawio'), 'utf-8')
      .then(t => t.replace('</root></mxGraphModel></diagram><diagram id="page-2"', '') // no-op 保护
        .replace('name="第二页·多图层">', 'name="第二页·多图层">'))
    const modified = edited.replace(
      '<mxCell id="p2-b1"',
      '<mxCell id="p2-new" value="刷新新增节点" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="p2-layerA"><mxGeometry x="380" y="90" width="140" height="40" as="geometry"/></mxCell><mxCell id="p2-b1"')
    const b64 = Buffer.from(modified, 'utf-8').toString('base64')
    await p.evaluate(b => {
      const bin = atob(b); const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      window.__send(u8.buffer, 'refresh')
    }, b64)
    await waitState(p, 'window.__state && window.__state.svg && window.__state.page === 1 && Math.abs(window.__state.scale - 2) < 1e-6')
    const svgText2 = await frameOf(p).evaluate(() => (document.querySelector('#graph svg') || { textContent: '' }).textContent)
    const st = await p.evaluate(() => window.__state)
    st.svgText = svgText2
    check('5.2 刷新后保留页面与缩放，且新内容可见',
      st.page === 1 && Math.abs(st.scale - 2) < 1e-6 && st.svgText.includes('刷新新增节点'),
      `page=${st.page} scale=${st.scale}`)
    await p.close()
  }

  // ── 5.3 跨源回归：父页面加载另一 origin 的资源不受影响 ─────────
  {
    const p = await openFixture('/drawio-preview/fixtures/compressed.drawio')
    try { await waitState(p, '!!(window.__state && window.__state.svg)') }
    catch (e) {
      console.log('[diag] events =', JSON.stringify(await p.evaluate(() => window.__events)))
      console.log('[diag] state =', JSON.stringify(await p.evaluate(() => window.__state)))
      const f = p.frames().find(fr => fr.url().includes('bootstrap'))
      if (f) console.log('[diag] frame errors =', await f.evaluate(() => window.__err || 'n/a').catch(() => 'n/a'))
      throw e
    }
    // 用 CORS fetch 验证跨源通路（4181 与 4180 不同 origin）：ORB 会静默丢弃跨源 no-cors
    // <img> 的嗅探失败响应（1x1 微图被误伤），那是素材问题；fetch+ACAO 才是对
    // "Draw.io 隔离不株连其他 origin"的直接证明。
    const cross = await p.evaluate(async () => {
      try {
        const r = await fetch(document.getElementById('cross').src, { mode: 'cors' })
        const b = await r.arrayBuffer()
        return r.ok && b.byteLength > 0
      } catch { return false }
    })
    check('5.3 父页面跨源资源仍可访问（隔离只在 Draw.io iframe 内）', cross === true)
    await p.close()
  }

  check('全程零外部请求（含所有 fixture）', attempts.length === 0, attempts.length ? attempts.slice(0, 3).join(',') : `无任何非本地尝试`)
} catch (e) {
  check('套件执行本身', false, String(e && e.message || e).slice(0, 300))
} finally {
  await browser.close(); s1.close(); s2.close()
}

const failed = results.filter(r => !r.ok)
console.log(`\n===== 浏览器套件: ${results.length - failed.length}/${results.length} 通过 =====`)
process.exit(failed.length ? 1 : 0)
