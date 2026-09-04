/** 任务 3.1–3.3：Draw.io 文档 loader。
 *
 *  契约：
 *   - 先 stat（会话 base）后正文：size ≤ 40MiB 才取 raw（JSON /file 不用，二进制直传 iframe）；
 *   - 超限（stat / Content-Length / 实际字节三道检查）不读正文 / 取消流；
 *   - stat 失败或 size 无效 → 安全停止，无任何在线 fallback；
 *   - 返回的 ArrayBuffer 可 transferable 交接（父端 detach、iframe 端 fatal UTF-8 解码）；
 *   - 双 base：数据永远走 workspaceBase（会话），viewer 静态资源永远走本地 SPA base。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadDrawioDocument, drawioBootstrapUrl, DRAWIO_MAX_BYTES } from './loader'

const MAX = 40 * 1024 * 1024

function statResponse(size: number | string | null) {
  return new Response(JSON.stringify(size === null ? {} : { mtime: 1, size }), { status: 200 })
}
function rawResponse(bytes: number, opts: { contentLength?: number | false } = {}) {
  const body = new Uint8Array(bytes)
  const headers = new Headers()
  if (opts.contentLength !== false) headers.set('content-length', String(opts.contentLength ?? bytes))
  return new Response(body, { status: 200, headers })
}

const fetchMock = vi.fn()
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset() })
afterEach(() => { vi.unstubAllGlobals() })

describe('40 MiB 门控（任务 3.1）', () => {
  it('size 等于边界 → 允许继续请求正文', async () => {
    fetchMock.mockResolvedValueOnce(statResponse(MAX)).mockResolvedValueOnce(rawResponse(16))
    const r = await loadDrawioDocument('/w/a.drawio', 'http://sess/api/v1')
    expect(r.kind).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toContain('/workspace/file/raw')
  })

  it('size 大于边界 → 不请求正文', async () => {
    fetchMock.mockResolvedValueOnce(statResponse(MAX + 1))
    const r = await loadDrawioDocument('/w/a.drawio', 'http://sess/api/v1')
    expect(r).toMatchObject({ kind: 'too-large' })
    expect(fetchMock).toHaveBeenCalledTimes(1)   // 只有 stat
  })

  it('stat 失败 → 安全停止', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    const r = await loadDrawioDocument('/w/a.drawio', 'http://sess/api/v1')
    expect(r).toMatchObject({ kind: 'error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('size 无效（字符串/负数/缺失）→ 安全停止', async () => {
    for (const bad of ['999' as const, -1 as const, null]) {
      fetchMock.mockReset()
      fetchMock.mockResolvedValueOnce(statResponse(bad))
      const r = await loadDrawioDocument('/w/a.drawio', 'http://sess/api/v1')
      expect(r).toMatchObject({ kind: 'error' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('stat 请求打到会话 base（云端会话走远端）', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    await loadDrawioDocument('/w/a.drawio', 'http://cloud-9/api/v1')
    expect(fetchMock.mock.calls[0][0]).toContain('http://cloud-9/api/v1/workspace/file/stat')
  })
})

describe('raw 传输（任务 3.2）', () => {
  it('正文 Content-Length 超限 → 取消流并判 too-large', async () => {
    const cancel = vi.fn()
    const res = rawResponse(16, { contentLength: MAX + 100 })
    Object.defineProperty(res, 'body', { value: { cancel } })   // Response.body 只读，用 defineProperty 换掉
    fetchMock.mockResolvedValueOnce(statResponse(16)).mockResolvedValueOnce(res)
    const r = await loadDrawioDocument('/w/a.drawio', 'http://sess/api/v1')
    expect(r).toMatchObject({ kind: 'too-large' })
    expect(cancel).toHaveBeenCalled()
  })

  it('无 Content-Length 时按实际字节二次检查 → too-large', async () => {
    fetchMock.mockResolvedValueOnce(statResponse(MAX)).mockResolvedValueOnce(rawResponse(MAX + 1, { contentLength: false }))
    const r = await loadDrawioDocument('/w/a.drawio', 'http://sess/api/v1')
    expect(r).toMatchObject({ kind: 'too-large' })
  })

  it('正文读取失败 → 错误态（无在线 fallback）', async () => {
    fetchMock.mockResolvedValueOnce(statResponse(16)).mockResolvedValueOnce(new Response('x', { status: 403 }))
    const r = await loadDrawioDocument('/w/a.drawio', 'http://sess/api/v1')
    expect(r).toMatchObject({ kind: 'error' })
  })

  it('返回的 ArrayBuffer 可 transferable 交接（父端 detach）', async () => {
    const xml = '<mxfile><diagram id="p" name="n"><mxGraphModel/></diagram></mxfile>'
    fetchMock.mockResolvedValueOnce(statResponse(8))
      .mockResolvedValueOnce(new Response(xml, { status: 200 }))
    const r = await loadDrawioDocument('/w/a.drawio', 'http://sess/api/v1')
    if (r.kind !== 'ok') throw new Error('expected ok')
    expect(r.buf).toBeInstanceOf(ArrayBuffer)
    const transferred = structuredClone(r.buf, { transfer: [r.buf] })
    expect(r.buf.byteLength).toBe(0)                       // 原引用已 detach（父端不留副本）
    expect(new TextDecoder('utf-8', { fatal: true }).decode(transferred))
      .toContain('<mxfile>')                               // iframe 端 fatal 解码可行
  })

  it('非法字节会让 fatal UTF-8 解码抛错（iframe 端错误路径的前提）', () => {
    const bad = new Uint8Array([0xff, 0xfe, 0xff]).buffer
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bad)).toThrow()
  })
})

describe('双 base（任务 3.3）', () => {
  it('viewer 静态资源从本地 SPA base 构造，与会话 base 无关', () => {
    // jsdom 的 baseURI 由测试环境决定；显式传 assetBase 模拟打包态（SPA 挂在后端 / 下）
    expect(drawioBootstrapUrl('http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8000/drawio-preview/bootstrap.html')
    expect(drawioBootstrapUrl('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/drawio-preview/bootstrap.html')
  })

  it('缺省时从当前文档 baseURI 推导（云端会话下仍指向本地页面）', () => {
    const u = new URL(drawioBootstrapUrl())
    expect(u.pathname.endsWith('/drawio-preview/bootstrap.html')).toBe(true)
    expect(u.origin).toBe(new URL(document.baseURI).origin)
  })

  it('DRAWIO_MAX_BYTES 恒为 40 MiB（契约锁定）', () => {
    expect(DRAWIO_MAX_BYTES).toBe(41943040)
  })
})
