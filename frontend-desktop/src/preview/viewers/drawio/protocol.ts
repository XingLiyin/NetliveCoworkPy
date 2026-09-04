/** Draw.io 预览父子消息协议（任务 4.2 的纯逻辑部分）。
 *
 *  opaque origin（sandbox 无 allow-same-origin）下 event.origin 是字符串 "null"，
 *  身份只能靠「父生成随机 token → URL 片段传给子（#token，不进网络请求）→ 子在每条
 *  消息里回显」+ 父侧 event.source === iframe.contentWindow 双验。
 *  消息一律纯数据：图表字节只作为 ArrayBuffer 载荷传递，绝不拼进可执行 HTML。
 */

export type DrawioPageInfo = { id: string; name: string }
export type DrawioLayerInfo = { id: string; name: string; visible: boolean }

export interface DrawioSnapshot {
  page: number
  pageCount: number
  pages: DrawioPageInfo[]
  scale: number
  layers: DrawioLayerInfo[]
  svg: boolean
}

export type ParentCommand =
  | { type: 'render'; buf: ArrayBuffer }
  | { type: 'refresh'; buf: ArrayBuffer }
  | { type: 'setPage'; index: number }
  | { type: 'setLayerVisible'; layerId: string; visible: boolean }
  | { type: 'zoom'; factor: number }
  | { type: 'fit' }
  | { type: 'snapshot' }

export type ChildEvent =
  | { type: 'ready' }
  | { type: 'rendered'; state: DrawioSnapshot }
  | { type: 'snapshot'; state: DrawioSnapshot }
  | { type: 'warning'; message: string }
  | { type: 'error'; code: string; message?: string }

export interface Wire { token: string }

/** 父侧生成的一次性实例 token（每帧 128bit 随机）。 */
export function makeToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 严格 schema：认不出的形状一律拒收（防止图表内容伪装成消息）。 */
export function parseChildEvent(v: unknown): (ChildEvent & Wire) | null {
  if (!isObj(v) || typeof v.token !== 'string' || !v.token) return null
  const t = v.type
  if (t === 'ready') return { type: 'ready', token: v.token }
  if (t === 'warning') return typeof v.message === 'string' ? { type: 'warning', token: v.token, message: v.message } : null
  if (t === 'error')
    return typeof v.code === 'string'
      ? { type: 'error', token: v.token, code: v.code, message: typeof v.message === 'string' ? v.message : undefined }
      : null
  if (t === 'rendered' || t === 'snapshot') {
    const s = v.state
    if (!isObj(s)) return null
    if (typeof s.page !== 'number' || typeof s.pageCount !== 'number' || typeof s.scale !== 'number' || typeof s.svg !== 'boolean') return null
    if (!Array.isArray(s.pages) || !s.pages.every(p => isObj(p) && typeof p.id === 'string' && typeof p.name === 'string')) return null
    if (!Array.isArray(s.layers) || !s.layers.every(l => isObj(l) && typeof l.id === 'string' && typeof l.name === 'string' && typeof l.visible === 'boolean')) return null
    return { type: t, token: v.token, state: s as unknown as DrawioSnapshot }
  }
  return null
}

/** iframe src：bootstrap 地址 + #token（片段不会随请求发出）。 */
export function bootstrapUrlWithToken(bootstrapUrl: string, token: string): string {
  return `${bootstrapUrl}#${encodeURIComponent(token)}`
}
