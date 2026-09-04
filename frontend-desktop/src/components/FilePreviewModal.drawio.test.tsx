/** 任务 2.2：FilePreviewModal 的 Draw.io 分发。
 *  契约：.drawio/.dio → DrawioViewer（按重型文档用 heavyKey 重挂，reloadToken 透传）；
 *  .xml → CodeViewer 照旧；其余分支不受影响。
 */
import { describe, test, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }) }))
vi.mock('@/preview/viewers/DrawioViewer', () => ({
  DrawioViewer: (p: { path: string; reloadToken: number }) =>
    <div data-testid="drawio-viewer" data-path={p.path} data-token={p.reloadToken} />,
}))
vi.mock('@/preview/viewers/CodeViewer', () => ({
  CodeViewer: (p: { path: string }) => <div data-testid="code-viewer" data-path={p.path} />,
}))

import { FilePreviewContent } from './FilePreviewModal'

describe('FilePreviewModal × Draw.io 分发', () => {
  test('.drawio → DrawioViewer，reloadToken 透传到 viewer', () => {
    render(<FilePreviewContent sessionId={null} path="架构/demo.drawio" />)
    const v = screen.getByTestId('drawio-viewer')
    expect(v.dataset.path).toBe('架构/demo.drawio')
    expect(v.dataset.token).toBe('0')
    expect(screen.queryByTestId('code-viewer')).toBeNull()
  })

  test('.dio 同样进 DrawioViewer', () => {
    render(<FilePreviewContent sessionId={null} path="old.DiO" />)
    expect(screen.getByTestId('drawio-viewer').dataset.path).toBe('old.DiO')
  })

  test('.xml 仍是代码预览，不被接管', () => {
    render(<FilePreviewContent sessionId={null} path="pom.xml" />)
    expect(screen.getByTestId('code-viewer').dataset.path).toBe('pom.xml')
    expect(screen.queryByTestId('drawio-viewer')).toBeNull()
  })
})
