/** Draw.io 只读预览 viewer（骨架，任务 3.x/4.x 填充 loader 与隔离 iframe）。
 *
 *  设计定位（design 决策 2/3/5）：按重型文档处理——上层用 heavyKey 重挂；
 *  先 stat 门控再取字节，经 transferable postMessage 送入 sandbox iframe；
 *  这里只负责生命周期编排与只读控件，真正的渲染在 public/drawio-preview/bootstrap.js。
 */
import { useI18n } from '@/i18n'
import { Loading } from './common'

interface Props {
  path: string
  filename: string
  reloadToken: number
}

export function DrawioViewer({ path, filename, reloadToken }: Props) {
  const { t } = useI18n()
  void path; void filename; void reloadToken   // 任务 3.x 接入 loader 前先占位
  return (
    <div className="h-full w-full" data-testid="drawio-viewer-root">
      <Loading />
      <span className="sr-only">{t('common.loading')}</span>
    </div>
  )
}
