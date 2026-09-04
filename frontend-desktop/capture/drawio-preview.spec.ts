/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Draw.io 只读预览 —— 端到端（真后端 + 真前端 + 真 viewer 资产，零 mock 渲染路径）。
 *
 * 与 src/** 的 vitest（组件/协议/loader）和 spike 浏览器套件（合成父页面）不同：
 * 这里走完整产品链路——文件面板单击 → FilePreviewModal 分发 → DrawioViewer →
 * sandbox iframe 里的生产 bootstrap + vendored viewer → 只读控件交互；
 * 再验 PR #29 的双击 → electronAPI.openPath（stub 记录调用）。
 *
 * 自带隔离后端（NLC_DATA_DIR 指向临时目录，不碰用户 AppData；端口约定同 _backend.ts）。
 * 会话经 API 直建（空 user_prompt，不依赖 LLM），title 用 PUT /sessions/{id}/title 起名定位。
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prep } from './_setup'
import { createSession, dropSessions, TEST_WS } from './_cowork'
import { startBackend, stopBackend } from './_backend'

const SESSION_TITLE = 'DrawIO-E2E-预览演示'
const FILE_NAME = 'drawio-e2e-演示.drawio'
const WS_FILE = join(TEST_WS, FILE_NAME)
const FIXTURE = join(process.cwd(), 'spike', 'drawio', 'spike-fixture.drawio')
const E2E_DATA_DIR = join(tmpdir(), 'nlc-e2e-drawio')

const bin: string[] = []

/** 建会话 + 起名 + 登记 bin 等删（不走 UI，也就不依赖 LLM）。 */
async function makeSession(request: APIRequestContext, title: string): Promise<string> {
  const created = await createSession(request, bin, {})
  expect(created.status, 'API 建会话失败').toBe(200)
  await request.put(`/api/v1/sessions/${created.id}/title`, { data: { title } })
  return created.id!
}

test.describe.serial('drawio 预览端到端', () => {
  test.beforeAll(async () => {
    // 工作区放 fixture（两页、第二页双图层、中文标签——复用 spike 的验证素材）
    mkdirSync(TEST_WS, { recursive: true })
    copyFileSync(FIXTURE, WS_FILE)
    // 隔离数据目录：会话/引用库都落在临时目录，跑完删净，不碰用户数据
    await startBackend({ NLC_DATA_DIR: E2E_DATA_DIR })
  })

  test.afterAll(async () => {
    await stopBackend()               // 先停后端再删数据目录：SQLite 句柄还开着时删必 EPERM
    rmSync(E2E_DATA_DIR, { recursive: true, force: true })
    rmSync(WS_FILE, { force: true })
  })

  test('单击预览：分发 → 隔离渲染 → 页面/图层只读控件', async ({ page, request }) => {
    await prep(page)
    try {
      await makeSession(request, SESSION_TITLE)

      await page.goto('/')
      await page.getByText(SESSION_TITLE, { exact: false }).first().click()

      // 文件面板列出 fixture（等列表轮询拿到）
      const row = page.getByText(FILE_NAME, { exact: true })
      await row.waitFor({ timeout: 20_000 })

      // 单击（PR #29：250ms 内无第二击才预览）→ 预览 tab + 隔离 iframe
      await row.click()
      const iframe = page.locator('iframe[sandbox="allow-scripts"]')
      await iframe.waitFor({ timeout: 20_000 })
      await expect(iframe).toHaveAttribute('src', /drawio-preview\/bootstrap\.html#/)

      // 页面下拉出现（握手完成、渲染成功——控件只挂在 ok 态上）
      const pageSelect = page.getByTitle('页面')
      await pageSelect.waitFor({ timeout: 20_000 })

      // 初始第一页：中文节点可见（iframe 是 opaque origin，断言必须走 frame 上下文）
      await expect.poll(() => svgText(page), { timeout: 15_000 }).toContain('中文节点')

      // 切到第二页：底图出现 + 该页的两个图层 checkbox 可见（图层属于第二页）
      await pageSelect.selectOption({ label: '第二页·多图层' })
      await expect.poll(() => svgText(page), { timeout: 15_000 }).toContain('底图设备框')
      await expect(page.locator('label:has-text("图层A·底图")')).toBeVisible()
      await expect(page.locator('label:has-text("图层B·标注")')).toBeVisible()

      // 关掉图层B → 标注从图上消失（图层可见性走 model.setVisible）
      await page.locator('label:has-text("图层B·标注") input').uncheck()
      await expect.poll(() => svgText(page), { timeout: 15_000 }).not.toContain('仅图层B可见')

      await page.screenshot({ path: 'capture/test-results/drawio-e2e-preview.png' })
    } finally {
      await dropSessions(request, bin)
    }
  })

  test('双击文件 → 交给系统默认程序（openPath），不再进预览', async ({ page, request }) => {
    await prep(page)
    // openPath 记录桩必须在 prep **之后**注册：addInitScript 按注册顺序执行，
    // prep 的脚本会整体重建 electronAPI，先注册的补丁会被冲掉。
    await page.addInitScript(() => {
      ;(window as any).__openPathCalls = [] as string[]
      ;(window as any).electronAPI.openPath = (p: string) => {
        ;(window as any).__openPathCalls.push(p)
      }
    })

    try {
      const title = SESSION_TITLE + '-双击'
      await makeSession(request, title)

      await page.goto('/')
      await page.getByText(title, { exact: false }).first().click()
      const row = page.getByText(FILE_NAME, { exact: true })
      await row.waitFor({ timeout: 20_000 })

      // 250ms 内两击 = 双击 → openPath 被调用（绝对路径），且预览 iframe 不出现
      await row.click({ clickCount: 2, delay: 60 })
      await expect.poll(() => page.evaluate(() => (window as any).__openPathCalls ?? []),
        { timeout: 10_000 }).toEqual([WS_FILE])
      await page.waitForTimeout(600)   // 超过 250ms 判定窗，确认预览确实被取消而非迟到
      await expect(page.locator('iframe[sandbox="allow-scripts"]')).toHaveCount(0)
    } finally {
      await dropSessions(request, bin)
    }
  })
})

/** frame 内取 SVG 文本（沙箱 iframe 走 Playwright frame 上下文，父页面摸不到）。 */
async function svgText(page: Page): Promise<string> {
  const f = page.frames().find(fr => fr.url().includes('bootstrap.html'))
  if (!f) return ''
  return f.evaluate(() => (document.querySelector('#graph svg') as SVGElement | null)?.textContent ?? '')
}
