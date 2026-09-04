/** Draw.io 只读预览 viewer（任务 3.4 + 4.x）。
 *
 *  数据流：stat 门控 → raw 字节（transferable，父端不留守副本）→ sandbox iframe 里的
 *  隔离壳渲染（public/drawio-preview/）。双 base：数据走会话 base，壳走本地 SPA base。
 *  身份：父生成随机 token 经 URL 片段传入；消息校验 event.source + token，旧 token 拒收。
 *  自动/手动刷新：同一文件发 refresh（iframe 侧保持页面/缩放/图层，任务 5.2）。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { ZoomInIcon, ZoomOutIcon, MaximizeIcon } from 'lucide-react'
import { useI18n } from '@/i18n'
import { LOCAL_BASE } from '@/api/backends'
import { usePreviewBase } from '@/preview/previewBase'
import { Loading } from './common'
import { loadDrawioDocument, drawioBootstrapUrl } from './drawio/loader'
import {
  makeToken, parseChildEvent, bootstrapUrlWithToken,
  type ParentCommand, type DrawioSnapshot,
} from './drawio/protocol'

const INIT_TIMEOUT_MS = 15_000

type Phase =
  | { kind: 'loading' }
  | { kind: 'ok' }
  | { kind: 'too-large' }
  | { kind: 'error'; code: string }

interface Props {
  path: string
  filename: string
  reloadToken: number
}

export function DrawioViewer({ path, reloadToken }: Props) {
  const { t } = useI18n()
  const workspaceBase = usePreviewBase()
  // 双击引导只给"数据就在本机"的会话：云端路径交给本机程序毫无意义。
  const canOpenLocal = workspaceBase === LOCAL_BASE && !!window.electronAPI?.openPath

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [snapshot, setSnapshot] = useState<DrawioSnapshot | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const tokenRef = useRef(makeToken())
  const renderedOnceRef = useRef(false)
  const seqRef = useRef(0)

  const postToChild = useCallback((cmd: ParentCommand) => {
    iframeRef.current?.contentWindow?.postMessage({ ...cmd, token: tokenRef.current }, '*', cmd.type === 'render' || cmd.type === 'refresh' ? [cmd.buf] : undefined)
  }, [])

  // 握手与状态回流：event.source + token 双验；旧 token 的消息一律拒收。
  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return
      const msg = parseChildEvent(ev.data)
      if (!msg || msg.token !== tokenRef.current) return
      if (msg.type === 'ready') {
        // ready 到了但字节还没到：loader 完成后由 send 发送（见下方的时序护栏）。
        return
      }
      if (msg.type === 'rendered' || msg.type === 'snapshot') {
        setSnapshot(msg.state)
        renderedOnceRef.current = true
        setPhase(p => (p.kind === 'loading' ? { kind: 'ok' } : p))
        return
      }
      if (msg.type === 'error') {
        setPhase({ kind: 'error', code: msg.code })
      }
      // warning（如未随包 stencil）：不阻塞渲染，保留其余内容（任务 5.1 语义）。
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // 加载生命周期：path 换 → 新 token 新实例；reloadToken 变 → 同实例 refresh。
  // seq 护栏：路径切换后，旧路径的异步结果不得覆盖当前状态。
  useEffect(() => {
    tokenRef.current = makeToken()
    renderedOnceRef.current = false
    setSnapshot(null)
    setPhase({ kind: 'loading' })
  }, [path])

  useEffect(() => {
    let cancelled = false
    const seq = ++seqRef.current
    const timer = setTimeout(() => {
      if (!cancelled && !renderedOnceRef.current) setPhase(p => (p.kind === 'loading' ? { kind: 'error', code: 'init-timeout' } : p))
    }, INIT_TIMEOUT_MS)

    loadDrawioDocument(path, workspaceBase).then(result => {
      if (cancelled || seq !== seqRef.current) return
      if (result.kind === 'ok') {
        const send = () => {
          if (cancelled || seq !== seqRef.current) return
          postToChild({ type: renderedOnceRef.current ? 'refresh' : 'render', buf: result.buf })
        }
        // iframe 可能尚未发 ready：轮询到 contentWindow 可发为止（jsdom/真实环境皆可用的朴素护栏）。
        const wait = () => {
          if (cancelled || seq !== seqRef.current) return
          if (iframeRef.current?.contentWindow) send()
          else setTimeout(wait, 50)
        }
        wait()
      } else if (result.kind === 'too-large') {
        clearTimeout(timer); setPhase({ kind: 'too-large' })
      } else {
        clearTimeout(timer); setPhase({ kind: 'error', code: result.code })
      }
    })
    return () => { cancelled = true; clearTimeout(timer) }
  }, [path, reloadToken, workspaceBase, postToChild])

  const cmd = (c: ParentCommand) => postToChild(c)

  return (
    <div className="flex h-full w-full flex-col">
      {phase.kind === 'ok' && snapshot && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 px-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
          {snapshot.pageCount > 1 && (
            <select
              className="rounded border px-1 py-0.5 text-xs"
              style={{ background: 'var(--bg2)', color: 'var(--t2)', borderColor: 'var(--border)' }}
              value={snapshot.page}
              onChange={e => cmd({ type: 'setPage', index: Number(e.target.value) })}
              title={t('filePreview.drawioPage')}
            >
              {snapshot.pages.map((p, i) => <option key={p.id || i} value={i}>{p.name || `#${i + 1}`}</option>)}
            </select>
          )}
          {snapshot.layers.map(l => (
            <label key={l.id} className="flex items-center gap-1 text-xs" style={{ color: 'var(--t2)' }}>
              <input type="checkbox" checked={l.visible} onChange={e => cmd({ type: 'setLayerVisible', layerId: l.id, visible: e.target.checked })} />
              {l.name}
            </label>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <button title={t('filePreview.drawioZoomOut')} onClick={() => cmd({ type: 'zoom', factor: 0.8 })} className="rounded p-1" style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}><ZoomOutIcon size={13} /></button>
            <button title={t('filePreview.drawioZoomIn')} onClick={() => cmd({ type: 'zoom', factor: 1.25 })} className="rounded p-1" style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}><ZoomInIcon size={13} /></button>
            <button title={t('filePreview.drawioFit')} onClick={() => cmd({ type: 'fit' })} className="rounded p-1" style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}><MaximizeIcon size={13} /></button>
          </div>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts"
          src={bootstrapUrlWithToken(drawioBootstrapUrl(), tokenRef.current)}
          title={t('filePreview.drawioPreviewTitle')}
          className="h-full w-full border-0 bg-white"
        />
        {phase.kind === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80"><Loading /></div>
        )}
        {phase.kind === 'too-large' && (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm" style={{ color: 'var(--t3)' }}>
            <div>
              <p>{t('filePreview.drawioTooLarge')}</p>
              {canOpenLocal && <p className="mt-1">{t('filePreview.drawioDoubleClickHint')}</p>}
            </div>
          </div>
        )}
        {phase.kind === 'error' && (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm" style={{ color: 'var(--t3)' }}>
            <div>
              <p>{t('filePreview.drawioError', { code: phase.code })}</p>
              {canOpenLocal && phase.code !== 'init-timeout' && <p className="mt-1">{t('filePreview.drawioDoubleClickHint')}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
