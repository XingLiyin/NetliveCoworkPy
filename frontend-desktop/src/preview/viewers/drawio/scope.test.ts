/** 任务 5.3（静态扫描部分）：Draw.io 隔离不越界。
 *  动态部分（.xml 照旧代码预览 / 非 Draw.io 双击仍走 PR #29 / 跨源资源不受株连）
 *  分别在 fileType.test.ts、WorkspacePanel.fileRow.test.tsx 与浏览器套件 5.3 覆盖；
 *  这里钉"生产代码里不存在本功能新增的全局拦截面"。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const FE = path.join(process.cwd())
const REPO = path.join(FE, '..')
const ELEC = path.join(REPO, 'electron')

function listJs(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory() && !f.includes('node_modules')) listJs(p, acc)
    else if (f.endsWith('.js')) acc.push(p)
  }
  return acc
}

describe('Draw.io 隔离范围不越界', () => {
  it('SPA 入口没有全局 CSP（隔离只在 Draw.io iframe 自己的文档里）', () => {
    const html = readFileSync(path.join(FE, 'index.html'), 'utf-8')
    expect(html.includes('Content-Security-Policy')).toBe(false)
  })

  it('Electron 的 webRequest 使用（存量 auth 流程）与 Draw.io 无关', () => {
    // auth.js 里本就有 webRequest.onBeforeRequest（登录跳转拦截，存量）。本功能的隔离
    // 手段是 iframe sandbox + 文档级 CSP，不碰 Electron session——这里钉住"两者不相交"。
    const files = [path.join(ELEC, 'main.js'), ...listJs(path.join(ELEC, 'lib'))]
    for (const f of files) {
      const text = readFileSync(f, 'utf-8')
      if (text.includes('webRequest')) {
        expect(text.toLowerCase().includes('drawio'), `${f} 的 webRequest 拦截涉及 drawio`).toBe(false)
      }
    }
  })

  it('没有 Draw.io 专用 IPC / 可执行文件探测（electron 目录零 drawio 引用）', () => {
    for (const f of listJs(ELEC)) {
      expect(readFileSync(f, 'utf-8').toLowerCase().includes('drawio'), `${f} 引用 drawio`).toBe(false)
    }
  })

  it('预览分发没有接管 drawio/dio 之外的扩展名（xml 回归在 fileType.test 另行锁定）', () => {
    const modal = readFileSync(path.join(FE, 'src/components/FilePreviewModal.tsx'), 'utf-8')
    expect((modal.match(/type === 'drawio'/g) ?? []).length).toBe(1)   // 只有一处分支
  })
})
