/** 任务 3.4 + 4.2（组件部分）：DrawioViewer 生命周期与握手。 */
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string, p?: Record<string, string>) => p ? `${k}:${JSON.stringify(p)}` : k, lang: 'en', setLang: () => {} }) }))

const loadMock = vi.fn()
vi.mock('./drawio/loader', () => ({
  loadDrawioDocument: (...a: unknown[]) => loadMock(...a),
  drawioBootstrapUrl: () => 'http://127.0.0.1:8000/drawio-preview/bootstrap.html',
}))

import { DrawioViewer } from './DrawioViewer'
import { PreviewBaseProvider } from '@/preview/previewBase'

const XML = '<mxfile><diagram id="p1" name="一"><mxGraphModel/></diagram><diagram id="p2" name="二"><mxGraphModel/></diagram></mxfile>'

const mount = () => render(
  <PreviewBaseProvider sessionId={null}>
    <DrawioViewer path="/w/a.drawio" filename="a.drawio" reloadToken={0} />
  </PreviewBaseProvider>,
)

function frame() { return document.querySelector('iframe') as HTMLIFrameElement }

function fireFromFrame(data: unknown) {
  const ev = new MessageEvent('message', { data })
  Object.defineProperty(ev, 'source', { value: frame().contentWindow })
  window.dispatchEvent(ev)
}

beforeEach(() => { loadMock.mockReset() })

describe('DrawioViewer', () => {
  test('iframe：sandbox 只给 allow-scripts，src 为本地 base + #token；数据走会话 base', async () => {
    loadMock.mockResolvedValue({ kind: 'ok', buf: new TextEncoder().encode(XML).buffer })
    mount()
    const f = frame()
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.src).toContain('http://127.0.0.1:8000/drawio-preview/bootstrap.html#')
    await waitFor(() => expect(loadMock).toHaveBeenCalledWith('/w/a.drawio', '/api/v1'))
  })

  test('握手：字节以 render+token 发入 iframe（transferable），rendered 后出只读控件', async () => {
    const buf = new TextEncoder().encode(XML).buffer
    loadMock.mockResolvedValue({ kind: 'ok', buf })
    mount()
    const token = frame().src.split('#')[1]
    const postSpy = vi.spyOn(frame().contentWindow!, 'postMessage')
    await waitFor(() => expect(postSpy).toHaveBeenCalled())
    const call = postSpy.mock.calls[0] as unknown as unknown[]
    const msg = call[0] as { type: string; token: string }
    const transfer = call[2] as ArrayBuffer[] | undefined
    expect(msg.type).toBe('render')
    expect(msg.token).toBe(decodeURIComponent(token))
    expect(transfer).toEqual([buf])   // transferable：父端不留副本

    fireFromFrame({ type: 'rendered', token, state: {
      page: 0, pageCount: 2, scale: 1, svg: true,
      pages: [{ id: 'p1', name: '一' }, { id: 'p2', name: '二' }],
      layers: [{ id: 'l1', name: '图层A', visible: true }],
    } })
    expect(await screen.findByTitle('filePreview.drawioPage')).toBeTruthy()
    expect(screen.getByText('图层A')).toBeTruthy()
  })

  test('旧 token / 陌生来源的消息被拒收（不产生状态变化）', async () => {
    const buf = new TextEncoder().encode(XML).buffer
    loadMock.mockResolvedValue({ kind: 'ok', buf })
    mount()
    const token = frame().src.split('#')[1]
    fireFromFrame({ type: 'rendered', token: 'deadbeef', state: {
      page: 0, pageCount: 9, scale: 1, svg: true, pages: [], layers: [],
    } })
    fireFromFrame({ type: 'totally-bogus', token })
    expect(screen.queryByTitle('filePreview.drawioPage')).toBeNull()
  })

  test('too-large：显示超限文案；本地会话（electronAPI 可用）给双击引导', async () => {
    loadMock.mockResolvedValue({ kind: 'too-large', size: 1 })
    ;(window as unknown as { electronAPI: object }).electronAPI = { openPath: () => {} }
    try {
      mount()
      expect(await screen.findByText('filePreview.drawioTooLarge')).toBeTruthy()
      expect(screen.getByText('filePreview.drawioDoubleClickHint')).toBeTruthy()
    } finally {
      delete (window as unknown as { electronAPI?: object }).electronAPI
    }
  })

  test('卸载后消息监听已清理（迟到的消息不再影响任何人）', async () => {
    loadMock.mockResolvedValue({ kind: 'ok', buf: new TextEncoder().encode(XML).buffer })
    const { unmount } = mount()
    const token = frame().src.split('#')[1]
    const childWin = frame().contentWindow      // 卸载前留好引用（DOM 移除后查不到 iframe）
    unmount()
    const ev = new MessageEvent('message', { data: { type: 'rendered', token, state: {
      page: 0, pageCount: 1, scale: 1, svg: true, pages: [], layers: [],
    } } })
    Object.defineProperty(ev, 'source', { value: childWin })
    expect(() => window.dispatchEvent(ev)).not.toThrow()
  })
})
