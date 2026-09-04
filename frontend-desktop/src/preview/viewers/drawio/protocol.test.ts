/** 任务 4.2（纯逻辑部分）：消息协议的 schema 与 token。 */
import { describe, it, expect } from 'vitest'
import { makeToken, parseChildEvent, bootstrapUrlWithToken, type DrawioSnapshot } from './protocol'

const state: DrawioSnapshot = {
  page: 0, pageCount: 2, scale: 1, svg: true,
  pages: [{ id: 'p1', name: '一' }, { id: 'p2', name: '二' }],
  layers: [{ id: 'l1', name: '图层A', visible: true }],
}

describe('makeToken', () => {
  it('每次不同且为 32 位 hex（128bit）', () => {
    const a = makeToken(), b = makeToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('parseChildEvent 严格 schema', () => {
  it('认得合法的 ready/rendered/snapshot/warning/error', () => {
    expect(parseChildEvent({ type: 'ready', token: 'T' })?.type).toBe('ready')
    expect(parseChildEvent({ type: 'rendered', token: 'T', state })?.type).toBe('rendered')
    expect(parseChildEvent({ type: 'snapshot', token: 'T', state })?.type).toBe('snapshot')
    expect(parseChildEvent({ type: 'warning', token: 'T', message: 'm' })?.type).toBe('warning')
    expect(parseChildEvent({ type: 'error', token: 'T', code: 'render-failed' })?.type).toBe('error')
  })
  it('拒收畸形形状（图表内容不得伪装成消息）', () => {
    for (const bad of [
      null, 'string', 42, {}, { type: 'ready' },                       // 缺 token
      { type: 'unknown', token: 'T' },
      { type: 'rendered', token: 'T' },                                 // 缺 state
      { type: 'rendered', token: 'T', state: { page: 'x' } },           // 字段类型错
      { type: 'rendered', token: 'T', state: { ...state, pages: [{ id: 1 }] } },
      { type: 'rendered', token: 'T', state: { ...state, layers: [{ id: 'l' }] } },
      { type: 'error', token: 'T' },                                    // 缺 code
    ]) expect(parseChildEvent(bad)).toBeNull()
  })
})

describe('bootstrapUrlWithToken', () => {
  it('token 走 URL 片段（不随 HTTP 请求发出）', () => {
    const u = new URL(bootstrapUrlWithToken('http://127.0.0.1:8000/drawio-preview/bootstrap.html', 'abc123'))
    expect(u.hash).toBe('#abc123')
    expect(u.pathname).toBe('/drawio-preview/bootstrap.html')
  })
})
