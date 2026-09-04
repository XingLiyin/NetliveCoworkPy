/** PR #29 文件行行为特征测试（Draw.io 预览将以它为权威基线，不另立状态机）。
 *
 * 四条契约：
 *   1. 本地文件单击 → 250ms 后才预览（预览要切 tab，会把文件列表藏掉，
 *      原生 dblclick 判不到第二下，只能手动计时）。
 *   2. 250ms 内第二击 → 交给系统默认程序打开（onOpenLocal），且不再预览。
 *   3. 云端/无 electronAPI → 没有"双击"这回事，单击立即预览。
 *   4. 下载按钮只在给了 onDownload（云端）时渲染。
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }) }))

import { FileRow } from './WorkspacePanel'

const row = (over: Partial<Parameters<typeof FileRow>[0]> = {}) => {
  const onOpen = vi.fn()
  const onOpenLocal = vi.fn()
  const onNavigate = vi.fn()
  const props = {
    name: 'demo.drawio', isDir: false, size: 12,
    onNavigate, onOpen, onOpenLocal,
    ...over,
  }
  const view = render(<FileRow {...props} />)
  return { onOpen, onOpenLocal, onNavigate, view }
}

const clickRow = (name = 'demo.drawio') =>
  fireEvent.click(screen.getByText(name).closest('.group') as HTMLElement)

describe('FileRow 单击/双击状态机（PR #29 基线）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('本地文件：单击在 250ms 后触发预览', () => {
    const { onOpen, onOpenLocal } = row()
    clickRow()
    expect(onOpen).not.toHaveBeenCalled()      // 先攒着等第二下
    vi.advanceTimersByTime(250)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpenLocal).not.toHaveBeenCalled()
  })

  test('本地文件：250ms 内第二击交给系统默认程序，且不预览', () => {
    const { onOpen, onOpenLocal } = row()
    clickRow()
    clickRow()
    vi.advanceTimersByTime(500)
    expect(onOpenLocal).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()      // 预览被取消，没有"又预览又打开"
  })

  test('第二击之后再次单击重新开始一轮（预览 ← 新单击）', () => {
    const { onOpen, onOpenLocal } = row()
    clickRow(); clickRow()                     // 双击 → 本地打开
    clickRow()                                 // 新的一轮单击
    vi.advanceTimersByTime(250)
    expect(onOpenLocal).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('云端文件（无 onOpenLocal）：单击立即预览，连点也只是预览', () => {
    const { onOpen, onOpenLocal } = row({ onOpenLocal: undefined })
    clickRow()
    expect(onOpen).toHaveBeenCalledTimes(1)    // 不等 250ms
    clickRow()
    vi.advanceTimersByTime(500)
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpenLocal).not.toHaveBeenCalled()
  })

  test('目录行照旧直接导航，不进计时器', () => {
    const { onNavigate, onOpen } = row({ isDir: true })
    clickRow()
    expect(onNavigate).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(500)
    expect(onOpen).not.toHaveBeenCalled()
  })

  test('下载按钮只在给了 onDownload 时渲染', () => {
    const { view } = row({ onDownload: undefined })
    expect(view.container.querySelector('button')).toBeNull()
    const withDl = row({ onDownload: () => {} })
    expect(withDl.view.container.querySelectorAll('button').length).toBe(1)  // 只有下载这一个动作钮
  })
})
