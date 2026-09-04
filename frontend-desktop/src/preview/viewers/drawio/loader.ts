/** Draw.io 文档 loader（任务 3.1–3.3）。
 *
 *  三道大小检查（stat.size → 正文 Content-Length → 实际字节），任何一道超限都不把
 *  正文交给渲染路径；正文走二进制 /file/raw（不进 JSON /file——40MB XML 经 JSON 转义
 *  会翻倍），以 ArrayBuffer 原样 transferable 送入 iframe。
 *
 *  双 base：数据 URL 一律用 workspaceBase（该会话所属后端，云端会话即远端）；
 *  viewer 静态资源（bootstrap/viewer.min.js）一律从本地 SPA base 构造——云端会话时
 *  "数据走远端、壳走本地"，两者绝不混用（见 drawioBootstrapUrl）。
 */

export const DRAWIO_MAX_BYTES = 40 * 1024 * 1024

export type DrawioLoad =
  | { kind: 'ok'; buf: ArrayBuffer }
  | { kind: 'too-large'; size?: number }
  | { kind: 'error'; code: 'stat-failed' | 'invalid-size' | 'read-failed' }

function statUrl(path: string, base: string): string {
  return `${base}/workspace/file/stat?path=${encodeURIComponent(path)}`
}
function rawUrl(path: string, base: string): string {
  return `${base}/workspace/file/raw?path=${encodeURIComponent(path)}`
}

export async function loadDrawioDocument(path: string, workspaceBase: string): Promise<DrawioLoad> {
  let stat: Response
  try {
    stat = await fetch(statUrl(path, workspaceBase), { cache: 'no-store' })
  } catch {
    return { kind: 'error', code: 'stat-failed' }
  }
  if (!stat.ok) return { kind: 'error', code: 'stat-failed' }

  let size: unknown
  try { size = (await stat.json())?.size } catch { return { kind: 'error', code: 'stat-failed' } }
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return { kind: 'error', code: 'invalid-size' }
  }
  if (size > DRAWIO_MAX_BYTES) return { kind: 'too-large', size }

  let body: Response
  try {
    body = await fetch(rawUrl(path, workspaceBase), { cache: 'no-store' })
  } catch {
    return { kind: 'error', code: 'read-failed' }
  }
  if (!body.ok) return { kind: 'error', code: 'read-failed' }

  // 第二道：声明长度超限 → 直接取消流（字节都不进内存）。
  const declared = Number(body.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > DRAWIO_MAX_BYTES) {
    try { await body.body?.cancel() } catch { /* best-effort：连接已断也无妨 */ }
    return { kind: 'too-large', size: declared }
  }

  const buf = await body.arrayBuffer()
  // 第三道：stat 与读取之间文件可能被换掉，实际字节超限同样拒绝。
  if (buf.byteLength > DRAWIO_MAX_BYTES) return { kind: 'too-large', size: buf.byteLength }
  return { kind: 'ok', buf }
}

/** viewer 壳（bootstrap.html）的地址：永远从**本地 SPA base** 构造。
 *  云端会话时数据走 workspaceBase，但壳与官方 viewer 资产在本机——双 base 分离
 *  （任务 3.3 的契约）。缺省从当前文档 baseURI 推导（打包态 SPA 挂本地后端 / 下）。 */
export function drawioBootstrapUrl(assetBase?: string): string {
  const base = assetBase ?? new URL(import.meta.env.BASE_URL, document.baseURI).toString()
  return new URL('drawio-preview/bootstrap.html', base).toString()
}
