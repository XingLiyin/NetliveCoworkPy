import { useState } from 'react'
import { XIcon, FileIcon, RefreshCwIcon } from 'lucide-react'
import { useI18n } from '@/i18n'
import { getExt, fileType, CODE_LANGS } from '@/preview/fileType'
import { usePageActive, useAutoRefresh } from '@/preview/viewers/common'
import { PreviewToolbarProvider } from '@/preview/toolbar/PreviewToolbarContext'
import { PreviewToolbar } from '@/preview/toolbar/PreviewToolbar'
import { TocSidebar } from '@/preview/toolbar/TocSidebar'
import { ImageViewer } from '@/preview/viewers/ImageViewer'
import { MarkdownViewer } from '@/preview/viewers/MarkdownViewer'
import { CodeViewer } from '@/preview/viewers/CodeViewer'
import { TextViewer } from '@/preview/viewers/TextViewer'
import { DocxViewer } from '@/preview/viewers/DocxViewer'
import { ExcelViewer } from '@/preview/viewers/ExcelViewer'
import { PdfViewer } from '@/preview/viewers/PdfViewer'
import { PptxViewer } from '@/preview/viewers/PptxViewer'
import { HtmlViewer } from '@/preview/viewers/HtmlViewer'
import { DrawioViewer } from '@/preview/viewers/DrawioViewer'
import { PreviewBaseProvider } from '@/preview/previewBase'

interface Props {
  /** 文件属于哪个会话 → 决定向哪个后端取（云端会话的文件在云上那个实例里）。 */
  sessionId: string | null
  path: string
  onClose?: () => void
  // 预览内跳转到工作区其它文档（markdown 内链）。
  onNavigate?: (path: string) => void
  // 本预览面板是否为当前可见 tab；仅可见时才轮询自动刷新（默认 true，兼容独立使用）。
  active?: boolean
}

/**
 * 文件预览内容 —— 可停靠版（右侧面板「预览」tab 用），不再是浮动模态。
 * 填满容器（h-full），复用原预览工具栏 + 各类型 viewer。
 *
 * 外壳只负责把「该找哪个后端要文件」注入子树：定址必须在 Provider **之下**才生效，
 * 而 useAutoRefresh 等 hook 就跑在正文里，所以正文单独拆成 PreviewBody。
 */
export function FilePreviewContent({ sessionId, ...rest }: Props) {
  return (
    <PreviewBaseProvider sessionId={sessionId}>
      <PreviewBody {...rest} />
    </PreviewBaseProvider>
  )
}

function PreviewBody({ path, onClose, onNavigate, active = true }: Omit<Props, 'sessionId'>) {
  const { t } = useI18n()
  const ext = getExt(path)
  const type = fileType(ext)
  const name = path.split(/[/\\]/).pop() ?? path

  // 自动刷新：仅当本面板是当前可见 tab（active）且应用窗口活跃时轮询文件 mtime；手动刷新按钮叠加一个
  // bump。reloadToken 变 → 文本类 viewer 后台重取、原地平滑替换；重型文档用 key 重挂刷新。
  const pageActive = usePageActive()
  const [manualBump, setManualBump] = useState(0)
  const autoToken = useAutoRefresh(path, active && pageActive)
  const reloadToken = autoToken + manualBump
  const heavyKey = `${path}::${reloadToken}`

  return (
    <div className="flex h-full flex-col">
      <PreviewToolbarProvider>
        {/* Header：文件名 + 关闭 */}
        <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <FileIcon size={14} className="flex-shrink-0" style={{ color: 'var(--t3)' }} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium" style={{ color: 'var(--t2)' }}>{name}</span>
          <button
            onClick={() => setManualBump((b) => b + 1)}
            title={t('filePreview.refresh')}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors"
            style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
            onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
            onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
          >
            <RefreshCwIcon size={13} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              title={t('common.close')}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors"
              style={{ color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}
              onMouseEnter={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' }}
              onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = 'var(--t3)' }}
            >
              <XIcon size={14} />
            </button>
          )}
        </div>

        {/* Toolbar（当前 viewer 无能力则渲染空） */}
        <PreviewToolbar />

        {/* 内容行：可选 TOC 侧栏 + 主内容 */}
        <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
          <TocSidebar />
          <div className="flex-1 overflow-auto">
            {/* 文本类 viewer 接 reloadToken → 后台重取、原地平滑替换（不闪 loading、保留滚动）。 */}
            {type === 'image' && <ImageViewer path={path} filename={name} reloadToken={reloadToken} />}
            {type === 'markdown' && <MarkdownViewer path={path} filename={name} onNavigate={onNavigate} reloadToken={reloadToken} />}
            {type === 'code' && <CodeViewer path={path} lang={CODE_LANGS[ext]} filename={name} reloadToken={reloadToken} />}
            {type === 'text' && <TextViewer path={path} filename={name} reloadToken={reloadToken} />}
            {type === 'html' && <HtmlViewer path={path} filename={name} reloadToken={reloadToken} />}
            {/* 重型文档用 key 重挂刷新（重新解析）；reloadToken 同时进 fetch URL（?v=）→ 确定性拿新字节，
                不依赖浏览器缓存重校验。 */}
            {type === 'docx' && <DocxViewer key={heavyKey} path={path} filename={name} reloadToken={reloadToken} />}
            {type === 'excel' && <ExcelViewer key={heavyKey} path={path} filename={name} reloadToken={reloadToken} />}
            {type === 'pdf' && <PdfViewer key={heavyKey} path={path} filename={name} reloadToken={reloadToken} />}
            {type === 'pptx' && <PptxViewer key={heavyKey} path={path} filename={name} reloadToken={reloadToken} />}
            {/* Draw.io：重型隔离上下文——重挂重建（旧 viewer 状态不残留），reloadToken 同时透传。 */}
            {type === 'drawio' && <DrawioViewer key={heavyKey} path={path} filename={name} reloadToken={reloadToken} />}
            {type === 'binary' && (
              <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--t3)' }}>
                {t('filePreview.unsupported', { ext: ext || t('filePreview.unknownExt') })}
              </div>
            )}
          </div>
        </div>
      </PreviewToolbarProvider>
    </div>
  )
}
