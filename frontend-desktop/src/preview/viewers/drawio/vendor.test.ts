/** vendor/drawio 资源完整性（任务 1.3）。
 *
 * 钉三件事：
 *   1. manifest 里的每个文件都存在、SHA-256 与清单一致——上游 viewer 是逐字节固定的
 *      黑盒，改动必须以"显式换版本 + 改清单"的方式过审，不许悄悄漂移。
 *   2. 版本目录名与 manifest.version 一致——升级 = 换目录 + 改清单 + 重跑本测试。
 *   3. 无 CDN fallback：vendor 内文件的引用一律相对路径，不出现绝对 http(s) 源址；
 *      viewer.min.js 本体按校验和锁定（它内部存在的文档 URL 字符串不构成加载行为，
 *      由 bootstrap 的 CSP 与 MathJax 存根兜底，见 spike 报告）。
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'

// vitest 的 cwd 即 frontend-desktop（jsdom 环境下 import.meta.url 不是 file: 协议，不可用）。
const VENDOR_ROOT = path.join(process.cwd(), 'public/vendor/drawio')

describe('vendor/drawio 固定资源', () => {
  const manifestPath = findManifest()
  const manifest = manifestPath
    ? JSON.parse(readFileSync(manifestPath, 'utf-8'))
    : null

  function findManifest(): string | null {
    // manifest 在版本目录里；版本目录名必须与 manifest.version 一致（下面会钉）。
    if (!existsSync(VENDOR_ROOT)) return null
    for (const d of readdirSync(VENDOR_ROOT)) {
      const p = path.join(VENDOR_ROOT, d, 'manifest.json')
      if (statSync(path.join(VENDOR_ROOT, d)).isDirectory() && existsSync(p)) return p
    }
    return null
  }

  it('存在版本目录与 manifest', () => {
    expect(manifest, 'public/vendor/drawio/<version>/manifest.json 缺失').not.toBeNull()
    expect(manifest!.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest!.source).toMatch(/^https:/)
  })

  it('版本目录名与 manifest.version 一致', () => {
    const dirName = path.basename(path.dirname(manifestPath!))
    expect(dirName).toBe(manifest!.version)
  })

  it('清单内每个文件存在且 SHA-256 一致', () => {
    const dir = path.dirname(manifestPath!)
    for (const f of manifest!.files as { path: string; sha256: string; bytes?: number }[]) {
      const p = path.join(dir, f.path)
      expect(existsSync(p), `${f.path} 缺失`).toBe(true)
      const buf = readFileSync(p)
      expect(createHash('sha256').update(buf).digest('hex'), `${f.path} 校验和不符（上游文件被改动？）`)
        .toBe(f.sha256)
      if (f.bytes) expect(buf.length, `${f.path} 字节数不符`).toBe(f.bytes)
    }
  })

  it('viewer.min.js 在清单中且体积为 MB 级（防意外提交了截断文件）', () => {
    const entry = (manifest!.files as { path: string }[]).find(f => f.path === 'viewer.min.js')
    expect(entry, '清单缺 viewer.min.js').toBeDefined()
    const p = path.join(path.dirname(manifestPath!), 'viewer.min.js')
    expect(statSync(p).size).toBeGreaterThan(2_000_000)
  })

  it('LICENSE 与 NOTICE 随包（Apache-2.0 归属要求）', () => {
    const dir = path.dirname(manifestPath!)
    expect(existsSync(path.join(dir, 'LICENSE')), 'LICENSE 缺失').toBe(true)
    const license = readFileSync(path.join(dir, 'LICENSE'), 'utf-8')
    expect(license).toContain('Apache License')
    expect(existsSync(path.join(dir, 'NOTICE')), 'NOTICE 缺失').toBe(true)
  })

  it('manifest 记录三类升级触发条件（安全公告/格式兼容/Chromium 兼容）', () => {
    const t = manifest!.upgradeTriggers as Record<string, string>
    for (const key of ['security', 'formatCompatibility', 'chromiumCompatibility']) {
      expect(t?.[key], `upgradeTriggers.${key} 缺失`).toBeTruthy()
    }
  })

  it('无 CDN fallback：自有的加载文件只含相对引用', () => {
    const dir = path.dirname(manifestPath!)
    for (const f of manifest!.files as { path: string; origin?: string }[]) {
      if (!/\.(html|js)$/.test(f.path)) continue
      // viewer.min.js 是逐字节校验和锁定的上游黑盒：内部的 https 字符串是文档/帮助链接
      // （如 editBlankUrl），不是加载行为——加载隔离由 spike 验证过（MathJax 存根 + CSP，
      // 零外部请求）。本检查只管我们自己写的胶水文件。
      if (f.origin === 'upstream') continue
      const text = readFileSync(path.join(dir, f.path), 'utf-8')
      const absRefs = text.match(/(src|href)\s*=\s*["']https?:\/\//g) ?? []
      expect(absRefs, `${f.path} 含绝对源址引用（CDN fallback？）`).toEqual([])
    }
  })
})
