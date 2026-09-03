import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useContext, useImperativeHandle, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUp, Square, Brain, Terminal, FolderIcon, CloudIcon,
  Copy, Check, PanelRightIcon, PanelRightCloseIcon,
  ChevronUpIcon, ChevronDownIcon, XIcon, ZapIcon, HistoryIcon, RotateCcwIcon, ClockIcon, LockIcon,
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import remarkFixAutolink from '@/lib/remarkFixAutolink'

// 共享的 markdown 插件：GFM 表格/删除线 + LaTeX 数学($…$ 行内、$$…$$ 块级，rehype-katex 渲染)。
// katex CSS 在 main.tsx 全局引入。所有 <Markdown> 用它，避免各处重复且遗漏数学渲染。
// remarkFixAutolink 放最后：在 GFM autolink 解析完后，修复「URL 紧跟 **/中文」的过度吞并。
const MD_REMARK_PLUGINS = [remarkGfm, remarkMath, remarkFixAutolink]
// react-markdown 默认 urlTransform 会把 file: 协议清空（安全白名单不含 file）。这里放行
// http(s)/file/mailto/tel 与相对/锚点，仍拦掉 javascript:/data: 等危险协议。
const MD_URL_TRANSFORM = (url: string) =>
  (/^(https?|file|mailto|tel):/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url)) ? url : ''
const MD_REHYPE_PLUGINS = [rehypeKatex]
// 新建会话首条消息输入框的最大高度（px）；超过则内部滚动，避免长文本看不全。
const PENDING_MAX_H = 320
// 排队待发送列表的最大高度（px）：整条消息完整显示（不截断），条目多了整块内部滚动，
// 避免把输入框顶出视口。
const QUEUE_MAX_H = 220
import type { SSEHandle, ChatItem, ChatMessage, ChatToolCall, ChatWaitingInput, ChatImageData, AskQuestion, ChatHitlAnswer, RewindRecord, TaskInfo } from '@/hooks/useSessionSSE'
import { isTaskDone } from '@/hooks/useSessionSSE'
import { sessionsApi, type MessageContent, type BashReviewMode } from '@/api/sessions'
import { rewindApi } from '@/api/rewind'
import { AgentEmptyState } from '@/components/AgentHome'
import { useCurrentAgent } from '@/agents/useCurrentAgent'
import { isSessionReadOnly, useLineupState } from '@/agents/lineup'
import { agentById, agentIdFromTemplate, agentOfSession, templateIdOf, type Agent } from '@/agents/registry'
import { skillsApi, type LocalSkill } from '@/api/skills'
import { parseSkillCommand, pickSkillByName } from '@/lib/skillCommand'
import { detectAbuse } from '@/lib/profanity'
import { canReportAbuse, markAbuseReported } from '@/lib/abuseReport'
import { hitlApi } from '@/api/hitl'
import { llmsApi } from '@/api/llms'
import type { PendingSession, Session } from '@/types'
import type { AuthUser } from '@/types'
import { NewSessionDialog } from '@/components/NewSessionDialog'
import { PoopRain } from '@/components/PoopRain'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ModelPickerButton } from '@/components/ui/ModelPickerButton'
import { WorkModeButton } from '@/components/ui/WorkModeButton'
import { LLMErrorModal } from '@/components/LLMErrorModal'
import { SessionNoticeBar } from './SessionNoticeBar'
import { ReportSessionButton } from '@/components/ReportSessionButton'
import { EditableSessionTitle } from '@/components/EditableSessionTitle'
import { WebSources } from '@/components/WebSources'
import { activityLabel, formatDuration } from '@/lib/activity'
import type { ActivityState } from '@/lib/activity'
import { useI18n } from '@/i18n'
import { CloudBadge } from '@/components/ui/LocationBadge'
import { isCloudSession } from '@/api/backends'
import { checkInput, MAX_INPUT_TOKENS } from '@/lib/inputLimit'
import { useUpdateNagPoke } from '@/hooks/useUpdateNag'
import branding from '@branding'   // 品牌显示名唯一来源，见 electron/branding.json
import { resolveHitlId } from '@/lib/hitlTarget'
import { enqueue, getQueue, setQueue, subscribeQueues, pausedReplyText } from '@/lib/messageQueue'
import { requestDrain } from '@/hooks/useQueueDrainer'

function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

// 回滚记录的操作时间：带年月日（记录可能来自历史重放、隔天，光有时:分会有歧义）。
function fmtDateTime(ms: number) {
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch { return '' }
}

// ── Copy button — icon only, hidden until row hover, tooltip on button hover ──

function CopyButton({ text, alignEnd }: { text: string; alignEnd?: boolean }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  async function doCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={doCopy}
      className="copy-btn"
      style={{
        position: 'relative',
        marginTop: 4, padding: '4px 7px', borderRadius: 5, cursor: 'pointer',
        border: `1px solid ${copied ? 'var(--teal)' : 'var(--border)'}`,
        background: copied ? 'rgba(8,145,178,.08)' : 'var(--bg2)',
        color: copied ? 'var(--teal)' : 'var(--t3)',
        display: 'inline-flex', alignItems: 'center',
        alignSelf: alignEnd ? 'flex-end' : 'flex-start',
        transition: 'color var(--tr), background var(--tr), border-color var(--tr)',
      }}
      onMouseEnter={e => {
        const btn = e.currentTarget as HTMLElement
        if (!copied) { btn.style.background = 'var(--bg3)'; btn.style.borderColor = 'var(--border2)'; btn.style.color = 'var(--t2)' }
        const tip = btn.querySelector('.copy-tip') as HTMLElement | null
        if (tip) tip.style.opacity = '1'
      }}
      onMouseLeave={e => {
        const btn = e.currentTarget as HTMLElement
        if (!copied) { btn.style.background = 'var(--bg2)'; btn.style.borderColor = 'var(--border)'; btn.style.color = 'var(--t3)' }
        const tip = btn.querySelector('.copy-tip') as HTMLElement | null
        if (tip) tip.style.opacity = '0'
      }}
    >
      {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
      {/* Tooltip */}
      <span className="copy-tip" style={{
        position: 'absolute', bottom: 'calc(100% + 6px)', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(15,23,42,.85)', color: '#fff',
        fontSize: 11, padding: '3px 7px', borderRadius: 4,
        whiteSpace: 'nowrap', pointerEvents: 'none',
        opacity: 0, transition: 'opacity .15s',
      }}>
        {copied ? t('chat.copied') : t('chat.copy')}
      </span>
    </button>
  )
}

interface Props {
  sessionId: string | null
  sse: SSEHandle
  pendingSession: PendingSession | null
  user?: AuthUser | null | undefined
  onSessionCreated: (id: string) => void
  onNewSession: (pending: PendingSession) => void
  nextProvider: string
  nextModel: string
  onNextLLMChange: (provider: string, model: string) => void
  canShowWorkspace?: boolean
  workspaceOpen?: boolean
  onToggleWorkspace?: () => void
  onOpenUrl?: (url: string) => void   // 点 chat 链接 → 在应用内浏览器打开
}

// 把 openUrl 下发给 markdown 的 <a> 渲染器（mdComponents 是模块级常量，用 context 递进去）。
const OpenUrlContext = React.createContext<((url: string) => void) | null>(null)

// 会话区 AI 气泡的署名 —— 是**这条会话所属 agent** 的名字，不是产品外壳名。
// branding.productName 是外壳（NetLIVE Cowork），branding.json 自己的注释就写着「外壳本身
// 不参与对话」；用户对话的对象永远是某一个 cowork。气泡组件是模块级的、拿不到会话对象，
// 故用 context 从 ChatPanel 传下去（与 OpenUrlContext 同款）。
const AgentNameContext = React.createContext<string>('')
// rewind：把会话 id / 回滚动作 / 各回合的回滚记录透给模块级的 MessageRow / HitlAnswerRow。
interface RewindCtxValue {
  sessionId: string | null
  rewind: (turnSeq: number) => void                 // 触发回滚（异步；结果走 toast + 记录）
  undo: (turnSeq: number, safetyId: string) => void // 撤销最近一次回滚（恢复到回滚前的安全档）
  records: Record<number, RewindRecord[]>           // turnSeq → 该回合成功回滚的记录（可多条）
  rewindableTurns: Set<number>                      // 仍有检查点、可回滚的回合；超上限被 GC 的回合不在内
  undoableRewind: { turnSeq: number; safetyId: string } | null  // 当前可撤销的回滚（最近一次、窗口未关）
}
const RewindContext = React.createContext<RewindCtxValue | null>(null)

// 输入长度指示：接近上限时灰字提示，超限时标红。三处输入框共用。
function TokenCounter({ tokens }: { tokens: number }) {
  const { t } = useI18n()
  if (tokens <= MAX_INPUT_TOKENS * 0.8) return null
  const over = tokens > MAX_INPUT_TOKENS
  return (
    <span style={{ fontSize: 11, color: over ? 'var(--red)' : 'var(--t3)', whiteSpace: 'nowrap' }}>
      {over
        ? t('chat.inputOverLimit', { over: String(tokens - MAX_INPUT_TOKENS) })
        : t('chat.inputTokens', { tokens: String(tokens), max: String(MAX_INPUT_TOKENS) })}
    </span>
  )
}

// 查找栏的小图标按钮
function FindBtn({ onClick, title, disabled, children }: {
  onClick: () => void; title?: string; disabled?: boolean; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors"
      style={{ color: disabled ? 'var(--border2)' : 'var(--t3)', background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer' }}
      onMouseEnter={e => { if (!disabled) { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' } }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; el.style.background = 'none'; el.style.color = disabled ? 'var(--border2)' : 'var(--t3)' }}
    >
      {children}
    </button>
  )
}

// /skill 补全的共享逻辑：解析"正在敲的 skill 名"、过滤+去重、键盘导航、选中回填。
// input/setInput/textareaRef 由调用方（Composer 或新会话输入框）提供，两处复用。
function useSkillMenu(opts: {
  input: string
  setInput: (v: string) => void
  skills: LocalSkill[]
  enabled: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const { input, setInput, skills, enabled, textareaRef } = opts
  const [activeIdx, setActiveIdx] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  // 用户刚从下拉里点中的那条——同名（本地 + 云端引用）时，只有这一刻知道他要的是哪个，
  // 发送时据此决定 provider 前缀。名字对不上了自然失效（见 pickSkillByName）。
  const [picked, setPicked] = useState<LocalSkill | null>(null)
  // 正在敲 skill 名：/ 后还没空格时才认（有空格＝已在写正文）。
  const query = useMemo(() => {
    if (!enabled) return null
    const m = /^\/([^\s/]*)$/.exec(input)
    return m ? m[1] : null
  }, [input, enabled])
  const items = useMemo(() => {
    if (query == null) return []
    const q = query.toLowerCase()
    const matched = skills.filter(s => s.name.toLowerCase().includes(q) || (s.triggers || []).some(tr => tr.toLowerCase().includes(q)))
    // 同名（本地+云端引用）去重：优先保留有描述的那条（有的 skill 本地元数据缺失、描述为空）。
    const byName = new Map<string, LocalSkill>()
    for (const s of matched) {
      const k = s.name.toLowerCase()
      const prev = byName.get(k)
      if (!prev || (!prev.description && s.description)) byName.set(k, s)
    }
    // 上限放宽（原来截 8 条，skill 一多后面的就不显示，如 xlsx 排第 9 被截掉）：
    // 下拉本身可滚动、键盘导航会把选中项滚入可视区，超出部分可正常翻阅。
    return [...byName.values()].slice(0, 50)
  }, [skills, query])
  const open = items.length > 0 && !dismissed
  useEffect(() => { setActiveIdx(0); setDismissed(false) }, [query])
  // 已绑定的合法 skill（/name 后带空格）——徽标提示用。
  const bound = useMemo(() => {
    const m = /^\/([^\s/]+)\s/.exec(input)
    if (!m) return null
    return pickSkillByName(skills, m[1], picked)
  }, [input, skills, picked])
  const accept = useCallback((skill: LocalSkill) => {
    setPicked(skill)
    const v = `/${skill.name} `
    setInput(v)
    const el = textareaRef.current
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(v.length, v.length) } })
  }, [setInput, textareaRef])
  // 返回 true = 该按键已被下拉消费，调用方应就此 return（不再触发发送）。
  const onKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => (i + 1) % items.length); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => (i - 1 + items.length) % items.length); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(items[activeIdx]); return true }
    if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return true }
    return false
  }, [open, items, activeIdx, accept])
  return { open, items, activeIdx, setActiveIdx, bound, picked, accept, onKeyDown }
}

// /skill 补全下拉（浮在输入框上方）。父容器需 position:relative。
function SkillMenu({ items, activeIdx, onPick, onHover }: {
  items: LocalSkill[]; activeIdx: number; onPick: (skill: LocalSkill) => void; onHover: (i: number) => void
}) {
  const activeRef = useRef<HTMLButtonElement>(null)
  // 键盘上下切换时，把选中项滚进可视区（超出下拉高度也能跟随）。
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }) }, [activeIdx])
  return (
    <div style={{
      position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0,
      maxHeight: 268, overflowY: 'auto', zIndex: 30,
      background: 'var(--bg1)', border: '1px solid var(--border)',
      borderRadius: 'var(--r)', boxShadow: '0 8px 24px rgba(15,31,61,.16)', padding: 4,
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--t3)', padding: '4px 8px 6px' }}>Skill</div>
      {items.map((s, i) => (
        <button
          key={s.skill_id}
          ref={i === activeIdx ? activeRef : undefined}
          onMouseDown={e => { e.preventDefault(); onPick(s) }}
          onMouseEnter={() => onHover(i)}
          style={{
            display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px',
            borderRadius: 4, border: 'none', cursor: 'pointer',
            background: i === activeIdx ? 'var(--blue-dim)' : 'transparent',
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 600, color: i === activeIdx ? 'var(--blue)' : 'var(--t1)' }}>/{s.name}</span>
          {s.description && (
            <span style={{ display: 'block', marginTop: 1, fontSize: 11, color: 'var(--t3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</span>
          )}
        </button>
      ))}
    </div>
  )
}

// ── 输入历史（上/下箭头回溯已发送消息，跨会话持久化，仿 Claude Code / shell）──────
const INPUT_HISTORY_KEY = 'ipmc.inputHistory'
const INPUT_HISTORY_MAX = 100
function loadInputHistory(): string[] {
  try { const a = JSON.parse(localStorage.getItem(INPUT_HISTORY_KEY) || '[]'); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}

function useInputHistory(
  setInput: (v: string) => void,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  entries?: string[],   // 外部历史来源（如当前会话已发消息）。不传则用全局 localStorage。
) {
  const histRef = useRef<string[]>([])       // 最新在末尾
  const idxRef = useRef<number | null>(null)  // null = 未在回溯（显示实时草稿）
  const draftRef = useRef('')
  // onKeyDown 被 memo，用 ref 让它读到最新的 entries。
  const externalRef = useRef(false); externalRef.current = entries !== undefined
  const entriesRef = useRef<string[]>([]); entriesRef.current = entries ?? []

  // 发送成功时记一条（连续重复不入）。
  const commit = useCallback((text: string) => {
    idxRef.current = null
    const t = text.trim()
    if (!t) return
    const h = loadInputHistory()
    if (h[h.length - 1] === t) return
    h.push(t)
    if (h.length > INPUT_HISTORY_MAX) h.splice(0, h.length - INPUT_HISTORY_MAX)
    try { localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(h)) } catch { /* 配额满等，忽略 */ }
  }, [])

  const setToEnd = (v: string) => {
    setInput(v)
    const el = textareaRef.current
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(v.length, v.length) } })
  }

  // 手动改动输入 → 退出回溯（下次上箭头从最新重新开始）。
  const noteEdited = useCallback(() => { idxRef.current = null }, [])

  // 返回 true = 已消费该按键。
  const onKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
    if (e.nativeEvent.isComposing) return false
    const el = textareaRef.current
    if (!el) return false
    if (e.key === 'ArrowUp') {
      // 仅当光标在第一行才翻历史，否则让默认（多行内上移）。
      if ((el.value.slice(0, el.selectionStart ?? 0)).includes('\n')) return false
      if (idxRef.current === null) {
        // 优先用外部来源（当前会话已发消息）；否则退回全局 localStorage。快照一份，
        // 免得回溯途中来了新消息导致下标错位。
        histRef.current = (externalRef.current ? entriesRef.current : loadInputHistory()).slice()
        if (!histRef.current.length) return false
        draftRef.current = el.value
        idxRef.current = histRef.current.length - 1
      } else {
        idxRef.current = Math.max(0, idxRef.current - 1)
      }
      e.preventDefault()
      setToEnd(histRef.current[idxRef.current])
      return true
    }
    if (e.key === 'ArrowDown') {
      if (idxRef.current === null) return false   // 没在回溯 → 默认
      if ((el.value.slice(el.selectionEnd ?? 0)).includes('\n')) return false
      e.preventDefault()
      if (idxRef.current >= histRef.current.length - 1) { idxRef.current = null; setToEnd(draftRef.current) }
      else { idxRef.current += 1; setToEnd(histRef.current[idxRef.current]) }
      return true
    }
    return false
  }, [textareaRef])

  return { onKeyDown, commit, noteEdited }
}

// 可搜索历史面板（Ctrl+↑ 弹出）。浮在输入框上方，父容器需 position:relative。
// entries 旧→新；面板内最新在上。选中即回填输入框。
function HistoryPalette({ entries, onPick, onClose }: {
  entries: string[]; onPick: (text: string) => void; onClose: () => void
}) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { searchRef.current?.focus() }, [])
  const items = useMemo(() => {
    const list: string[] = []
    for (let i = entries.length - 1; i >= 0; i--) {   // 最新在前
      const s = entries[i]
      if (!s || !s.trim()) continue
      if (list[list.length - 1] === s) continue       // 连续重复去掉
      list.push(s)
    }
    const query = q.trim().toLowerCase()
    return query ? list.filter(s => s.toLowerCase().includes(query)) : list
  }, [entries, q])
  useEffect(() => { setIdx(0) }, [q])
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }) }, [idx, items.length])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(items.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx] != null) onPick(items[idx]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <div
      onKeyDown={onKeyDown}
      style={{
        position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, right: 0,
        maxHeight: 360, display: 'flex', flexDirection: 'column', zIndex: 30,
        background: 'var(--bg1)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', boxShadow: '0 8px 24px rgba(15,31,61,.16)', overflow: 'hidden',
      }}
    >
      <input
        ref={searchRef}
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={t('history.searchPlaceholder')}
        spellCheck={false}
        style={{ margin: 6, height: 28, padding: '0 10px', borderRadius: 'var(--r)', border: '1px solid var(--border)', background: 'var(--bg0)', color: 'var(--t1)', outline: 'none', fontSize: 12 }}
      />
      <div style={{ overflowY: 'auto', padding: '0 4px 4px' }}>
        {items.length === 0 && (
          <p style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: '14px 0' }}>{t('history.empty')}</p>
        )}
        {items.map((s, i) => (
          <button
            key={i}
            ref={i === idx ? activeRef : undefined}
            onMouseDown={e => { e.preventDefault(); onPick(s) }}
            onMouseEnter={() => setIdx(i)}
            title={s}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', marginBottom: 2,
              borderRadius: 4, border: 'none', cursor: 'pointer',
              background: i === idx ? 'var(--blue-dim)' : 'transparent',
              color: i === idx ? 'var(--blue)' : 'var(--t1)', fontSize: 12.5,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
          >
            {s.replace(/\s+/g, ' ').trim()}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Composer(输入框叶子组件)────────────────────────────────────────────────
// 自己持有 input 状态：敲键只重渲染本组件，不再牵连 ChatPanel/历史列表。
// 提交经 onSend(text) 上抛；父组件在发送成功后通过 ref.clear() 清空。
// 仅接受纯文本：不处理粘贴的图片/文件等非文本内容（纯 textarea 的浏览器默认行为即只收文本）。

export interface ComposerHandle { clear(): void }

const Composer = React.forwardRef<ComposerHandle, {
  providers: React.ComponentProps<typeof ModelPickerButton>['providers']
  selectedProvider: string
  selectedModel: string
  onModelChange: (provider: string, model: string) => void
  onSend: (text: string, picked: LocalSkill | null) => void   // picked=下拉里刚选中的 skill（同名消歧用）
  placeholder: string
  disabled?: boolean            // 输入禁用（创建中 / 运行中）
  disabledOpacity?: number      // textarea 禁用时的透明度
  busy?: boolean                // 发送按钮转圈
  autoFocus?: boolean
  showInterrupt?: boolean       // 运行中：显示中断按钮而非发送
  onInterrupt?: () => void
  error?: string
  skills?: LocalSkill[]         // /skill 补全用的已装 skill 列表
  enableSkillMenu?: boolean     // 是否启用 /skill 补全下拉
  sentHistory?: string[]        // 上/下箭头回溯：当前会话已发消息（旧→新）
  queued?: string | null        // 已排队待发送的文本（后端空闲前一直在此缓存）
  onRetractQueue?: () => void   // 撤回排队（空输入按 ↑ 时把队列取回输入框）
  workMode?: BashReviewMode                  // 工作模式；给了才在工具条渲染选择器
  onWorkModeChange?: (m: BashReviewMode) => void
  workModeDisabled?: boolean
}>(function Composer({
  providers, selectedProvider, selectedModel, onModelChange, onSend,
  placeholder, disabled = false, disabledOpacity = 0.5, busy = false,
  autoFocus = false, showInterrupt = false, onInterrupt, error,
  skills = [], enableSkillMenu = true, sentHistory,
  queued = null, onRetractQueue,
  workMode, onWorkModeChange, workModeDisabled = false,
}, ref) {
  const { t } = useI18n()
  const pokeUpdate = useUpdateNagPoke()
  const [input, setInput] = useState('')
  // 估算 token 数（中文 2/字、英文 4 字符/token、乱码 2 字符/token），超限禁止发送
  const [tokens, setTokens] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const retractedRef = useRef(false)   // 当前输入框内容是「刚从队列撤回的待发送消息」——供连续 ↑ 继续撤回
  const [inputAreaH, setInputAreaH] = useState<number | null>(() => {
    try { const n = Number(localStorage.getItem('ipmc.ui.inputH')); return n > 0 ? Math.min(400, Math.max(80, n)) : null } catch { return null }
  })
  useEffect(() => {
    if (inputAreaH != null) localStorage.setItem('ipmc.ui.inputH', String(inputAreaH))
    else localStorage.removeItem('ipmc.ui.inputH')
  }, [inputAreaH])
  const maxTaH = inputAreaH != null ? Math.max(80, inputAreaH - 62) : 160

  // 拖动手柄改变高度时，直接把 textarea 撑到 maxTaH，而不是等内容触发 auto-resize
  useEffect(() => {
    if (textareaRef.current && inputAreaH != null) {
      textareaRef.current.style.height = `${maxTaH}px`
    }
  }, [maxTaH, inputAreaH])

  useImperativeHandle(ref, () => ({
    clear() {
      setInput('')
      setTokens(0)
      // resize 模式下高度由手柄固定，清空不能塌回 auto，否则卡片底边脱离容器底部。
      if (textareaRef.current) {
        textareaRef.current.style.height = inputAreaH != null ? `${maxTaH}px` : 'auto'
      }
    },
  }), [inputAreaH, maxTaH])

  const overLimit = tokens > MAX_INPUT_TOKENS
  const canSend = !disabled && !overLimit && input.trim().length > 0

  // /skill 补全（逻辑抽到 useSkillMenu，新会话输入框复用同一套）
  const skillMenu = useSkillMenu({ input, setInput, skills, enabled: enableSkillMenu && !disabled, textareaRef })
  // 上/下箭头回溯已发送消息：来源=当前会话已发消息（旧→新）
  const history = useInputHistory(setInput, textareaRef, sentHistory ?? [])
  const [histOpen, setHistOpen] = useState(false)   // Ctrl+↑ 弹可搜索历史面板
  const histEntries = sentHistory ?? []

  // 把某条历史消息回填到输入框。
  function pickHistory(text: string) {
    setInput(text)
    setHistOpen(false)
    const el = textareaRef.current
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(text.length, text.length) } })
  }

  function submit() {
    if (!canSend) return
    history.commit(input)
    onSend(input, skillMenu.picked)
  }
  function onKeyDown(e: React.KeyboardEvent) {
    // Ctrl/Cmd+↑ 弹历史面板（与就地循环的裸 ↑ 分开）
    if ((e.ctrlKey || e.metaKey) && e.key === 'ArrowUp' && histEntries.length) { e.preventDefault(); setHistOpen(true); return }
    if (skillMenu.onKeyDown(e)) return   // 补全消费了该按键（方向键/Tab/Enter/Esc）
    // ↑ 先把队列里的待发送消息倒序（最新→最旧）逐条撤回到输入框，抽空后再进入真实发送历史。
    // 触发条件：有队列、光标在首行、且（输入框为空 或 当前正处于「撤回态」——即输入框里是上一条撤回来的）。
    if (queued && onRetractQueue && e.key === 'ArrowUp' && !e.nativeEvent.isComposing) {
      const el = textareaRef.current
      const atFirstLine = !(el?.value ?? '').slice(0, el?.selectionStart ?? 0).includes('\n')
      if (atFirstLine && (input.length === 0 || retractedRef.current)) {
        e.preventDefault()
        setInput(queued)
        retractedRef.current = true
        onRetractQueue()
        requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(queued.length, queued.length) } })
        return
      }
    }
    if (history.onKeyDown(e)) return      // 队列抽空后：上/下箭头回溯真实发送历史（光标在首/末行时）
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }
  // 从工作区拖入文件 → 在光标处插入文件名（元素级 onDrop 先于 main.tsx 的全局吞放监听执行）。
  function onDrop(e: React.DragEvent) {
    const dropped = e.dataTransfer.getData('text/plain')
    if (!dropped || disabled) return
    e.preventDefault()
    const el = textareaRef.current
    const start = el?.selectionStart ?? input.length
    const end = el?.selectionEnd ?? input.length
    const before = input.slice(0, start)
    const after = input.slice(end)
    // 前后按需补空格，避免和已有文字粘连
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    const trail = after && !/^\s/.test(after) ? ' ' : ''
    const r = checkInput(before + lead + dropped + trail + after)
    setInput(r.text)
    setTokens(r.tokens)
    history.noteEdited()
    const caret = (before + lead + dropped).length
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(caret, caret) } })
  }

  return (
    <>
      <HResizeHandle onStart={e => {
        const cur = containerRef.current?.offsetHeight ?? 120
        startVDrag(e, d => setInputAreaH(prev => Math.min(400, Math.max(80, (prev ?? cur) - d))))
      }} />
      <div ref={containerRef} style={{ padding: '4px 14px 14px', flexShrink: 0, ...(inputAreaH != null ? { minHeight: inputAreaH } : {}) }}>
      <div style={{
        position: 'relative',
        background: 'var(--bg1)', border: '1px solid var(--border)',
        borderRadius: 'var(--r2)', boxShadow: 'var(--shadow)',
        transition: 'border-color .15s, box-shadow .15s',
      }}
        onFocusCapture={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--blue)'; el.style.boxShadow = '0 0 0 3px var(--blue-dim)' }}
        onBlurCapture={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border)'; el.style.boxShadow = 'var(--shadow)' }}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--blue)'; el.style.boxShadow = '0 0 0 3px var(--blue-dim)' }}
        onDragLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border)'; el.style.boxShadow = 'var(--shadow)' }}
        onDrop={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border)'; el.style.boxShadow = 'var(--shadow)'; onDrop(e) }}
      >
        {/* /skill 补全下拉——浮在输入框上方 */}
        {skillMenu.open && (
          <SkillMenu items={skillMenu.items} activeIdx={skillMenu.activeIdx} onPick={skillMenu.accept} onHover={skillMenu.setActiveIdx} />
        )}
        {/* Ctrl+↑ 可搜索历史面板（点击外部关闭） */}
        {histOpen && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 29 }} onMouseDown={() => setHistOpen(false)} />
            <HistoryPalette entries={histEntries} onPick={pickHistory} onClose={() => { setHistOpen(false); textareaRef.current?.focus() }} />
          </>
        )}
        <textarea
          ref={textareaRef}
          className="ta-scroll"
          autoFocus={autoFocus}
          value={input}
          onFocus={() => pokeUpdate()}
          onChange={e => {
            const r = checkInput(e.target.value)
            if (r.text.length !== e.target.value.length) e.target.value = r.text  // 撞上字符兜底闸
            setInput(r.text)
            setTokens(r.tokens)
            history.noteEdited()   // 手动改动 → 退出历史回溯
            retractedRef.current = false   // 手动改动 → 退出「撤回态」，后续 ↑ 不再吞掉你打的草稿

            if (inputAreaH != null) {
              // resize 模式：固定高度，超出滚动
              e.target.style.height = `${maxTaH}px`
            } else {
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, maxTaH)}px`
            }
          }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          style={{
            width: '100%', padding: '11px 13px 4px', margin: 0,
            background: 'transparent', border: 'none', outline: 'none',
            color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13.5,
            resize: 'none', maxHeight: inputAreaH != null ? undefined : maxTaH,
            overflowY: inputAreaH != null ? 'auto' : 'hidden', lineHeight: 1.6,
            opacity: disabled ? disabledOpacity : 1,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 9px 8px' }}>
          <TokenCounter tokens={tokens} />
          {skillMenu.bound && (
            <span
              title={skillMenu.bound.description || skillMenu.bound.name}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600, color: 'var(--blue)', background: 'var(--blue-dim)', borderRadius: 6, padding: '2px 7px' }}
            >
              <ZapIcon size={11} />{skillMenu.bound.name}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {histEntries.length > 0 && (
            <button
              type="button"
              title={t('history.title')}
              onMouseDown={e => { e.preventDefault(); setHistOpen(v => !v) }}
              style={{
                flexShrink: 0, width: 26, height: 26, display: 'grid', placeItems: 'center',
                borderRadius: 6, border: 'none', cursor: 'pointer',
                background: histOpen ? 'var(--blue-dim)' : 'transparent',
                color: histOpen ? 'var(--blue)' : 'var(--t3)', transition: 'var(--tr)',
              }}
              onMouseEnter={e => { if (!histOpen) { const el = e.currentTarget as HTMLElement; el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' } }}
              onMouseLeave={e => { if (!histOpen) { const el = e.currentTarget as HTMLElement; el.style.background = 'transparent'; el.style.color = 'var(--t3)' } }}
            >
              <HistoryIcon size={14} />
            </button>
          )}
          {workMode && onWorkModeChange && (
            <WorkModeButton value={workMode} onChange={onWorkModeChange} disabled={workModeDisabled} />
          )}
          <ModelPickerButton
            providers={providers}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            onChange={onModelChange}
            disabled={disabled}
          />
          {showInterrupt ? (
            <>
              {/* 运行中有文字 → 排队发送键（浅蓝，区别于实心蓝的即时发送与红色停止） */}
              {canSend && (
                <button
                  onClick={submit}
                  title={t('chat.queueSend')}
                  style={{
                    width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--blue-dim)', border: '1px solid var(--blue)', color: 'var(--blue)',
                    display: 'grid', placeItems: 'center', cursor: 'pointer', transition: 'var(--tr)',
                  }}
                >
                  <ArrowUp size={14} strokeWidth={2.5} />
                </button>
              )}
              <button
                onClick={onInterrupt}
                title={t('chat.stop')}
                style={{
                  width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                  background: '#ef4444', border: 'none', color: '#fff',
                  display: 'grid', placeItems: 'center', cursor: 'pointer',
                  transition: 'background var(--tr)',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#dc2626' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#ef4444' }}
              >
                <Square size={13} />
              </button>
            </>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: canSend ? 'var(--blue)' : 'var(--bg3)',
                border: 'none', color: canSend ? '#fff' : 'var(--t3)',
                display: 'grid', placeItems: 'center', cursor: canSend ? 'pointer' : 'not-allowed',
                transition: 'background var(--tr)',
              }}
            >
              {busy ? <Spinner className="h-3 w-3" /> : <ArrowUp size={14} strokeWidth={2.5} />}
            </button>
          )}
        </div>
      </div>
      {error && <p style={{ marginTop: 4, fontSize: 11, color: 'var(--red)' }}>{error}</p>}
    </div>
    </>
  )
})

export function ChatPanel({ sessionId, sse, pendingSession, user, onSessionCreated, onNewSession, nextProvider, nextModel, onNextLLMChange, canShowWorkspace, workspaceOpen, onToggleWorkspace, onOpenUrl }: Props) {
  const qc = useQueryClient()
  const { t } = useI18n()
  // 右下角结果 toast。起初只给 rewind 用，现在工作模式切换、云端上传失败等都走它——
  // 名字因此改成通用的。回滚记录本身走后端持久化事件 → sse.rewindRecords（历史重放也带）。
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((ok: boolean, text: string) => {
    setToast({ ok, text })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }, [])
  // 只对「仍有检查点」的回合显示回滚按钮：检查点到上限后旧的被 GC，据此隐藏已失效的按钮
  // （否则点了必然 404）。检查点集合会在回合边界（拍新快照 / GC 旧的）和回滚后变化，故据 status 刷新。
  const { data: rewindCkpts } = useQuery({
    queryKey: ['rewind-checkpoints', sessionId],
    queryFn: () => sessionId ? rewindApi.listCheckpoints(sessionId) : Promise.resolve({ checkpoints: [] }),
    enabled: !!sessionId, retry: false, staleTime: 5_000,
  })
  const rewindableTurns = useMemo(
    () => new Set((rewindCkpts?.checkpoints ?? [])
      .map(c => c.turn).filter((n): n is number => typeof n === 'number')),
    [rewindCkpts],
  )
  useEffect(() => {
    if (sessionId) qc.invalidateQueries({ queryKey: ['rewind-checkpoints', sessionId] })
  }, [sse.session?.status, sessionId, qc])
  const doRewind = useCallback((turnSeq: number) => {
    if (!sessionId) return
    rewindApi.restoreToTurn(sessionId, turnSeq)
      .then((res) => {
        showToast(true, t('rewind.done'))
        qc.invalidateQueries({ queryKey: ['rewind-checkpoints', sessionId] })  // 回滚新增安全档 → 刷新集合
        // 终态回滚时 SSE 已关、收不到 live rewind_record（会话答完立即终态最易撞见）→ 据 HTTP 响应
        // 乐观补一条记录 + 开启撤销窗口，让对话里的回滚标记/撤销入口立刻显示，不必切会话。SSE 开着时 no-op。
        sse.addRewindRecord(turnSeq, { at: Date.now(), restored: res.restored, deleted: res.deleted, safetyId: res.safety_checkpoint_id ?? undefined })
      })
      .catch((e: Error) => showToast(false, e?.message || t('rewind.failed')))
  }, [sessionId, t, showToast, qc, sse.addRewindRecord])
  const doUndo = useCallback((turnSeq: number, safetyId: string) => {
    if (!sessionId) return
    rewindApi.undo(sessionId, safetyId, turnSeq)
      .then(() => {
        showToast(true, t('rewind.undoDone'))
        qc.invalidateQueries({ queryKey: ['rewind-checkpoints', sessionId] })  // 撤销新增安全档 → 刷新集合
        // 终态时 SSE 已关、收不到 live rewind_undone → 乐观标该回合记录已撤销 + 关窗。SSE 开着时 no-op。
        sse.markRewindUndone(turnSeq)
      })
      .catch((e: Error) => showToast(false, e?.message || t('rewind.undoFailed')))
  }, [sessionId, t, showToast, qc, sse.markRewindUndone])
  const rewindCtx = useMemo<RewindCtxValue>(() => ({
    sessionId, rewind: doRewind, undo: doUndo, records: sse.rewindRecords, rewindableTurns, undoableRewind: sse.undoableRewind,
  }), [sessionId, doRewind, doUndo, sse.rewindRecords, rewindableTurns, sse.undoableRewind])
  const pokeUpdate = useUpdateNagPoke()
  const composerRef = useRef<ComposerHandle>(null)
  const [showNewDialog, setShowNewDialog] = useState(false)
  // 空态里点中的 agent —— 带进新建对话框，决定这条会话的 template_id。
  const [pickedAgent, setPickedAgent] = useState<Agent | null>(null)
  const currentAgent = useCurrentAgent()
  // FAILED 框「继续对话」的本地关栏标记：不持久化；换会话或会话离开 FAILED 均复位
  // （离开不复位的话，同会话二次失败会被旧关栏吞掉）。render 期调整，非 effect。
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const [noticeSessionId, setNoticeSessionId] = useState(sessionId)
  if (noticeSessionId !== sessionId) {
    setNoticeSessionId(sessionId)
    setNoticeDismissed(false)
  }
  if (noticeDismissed && sse.session?.status !== 'FAILED') {
    setNoticeDismissed(false)
  }
  const [pendingInput, setPendingInput] = useState('')
  const [pendingTokens, setPendingTokens] = useState(0)
  // 新建会话时选的工作模式（还没 session_id，先存本地，create 时带给后端）。
  // 地端默认半自动；**云端默认全自动**——云端会话的卖点就是"关了电脑也照跑"，
  // 半自动会在第一个需要确认的动作上停下等人，而那时用户多半已经走了。
  // 云端的安全边界本来也不靠逐条确认：容器只读根文件系统、丢弃 capabilities、
  // 出口白名单、一人一实例一块卷（见 docs 云地协同 §4.3 / deploy/）。
  const [pendingMode, setPendingMode] = useState<BashReviewMode>(
    pendingSession?.location === 'cloud' ? 'strict-auto' : 'semiauto')
  // 草稿在本地/云端之间切换时跟着换默认值（用户手动选过就不再动它）。
  const modeTouched = useRef(false)
  const draftIsCloudRef = pendingSession?.location === 'cloud'
  useEffect(() => {
    if (!modeTouched.current) setPendingMode(draftIsCloudRef ? 'strict-auto' : 'semiauto')
  }, [draftIsCloudRef])
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const pendingTextareaRef = useRef<HTMLTextAreaElement>(null)
  // 账号按**这个会话所属的后端**取：云端实例自带一份账号库，和地端不是同一批。
  // 接错了会让用户在云端会话里选到一个云端没有的账号，建完一调模型就失败。
  const llmBackend = (pendingSession?.location === 'cloud' || isCloudSession(sessionId)) ? 'cloud' : 'local'
  // 再按 cowork 过滤（套件 llm.allow）：已有会话看**它自己**属于哪个 cowork，草稿看当前
  // agent。用会话自己的而不是当前 agent——用户可能已经切走了，而这条会话能用哪些账号该跟着
  // 它自己走，不该因为切了个界面就变。空 llm.allow = 不限（见 cowork_scope）。
  const llmCowork = (sse.session && agentOfSession(sse.session)?.id) || currentAgent?.id || null
  const { data: providers = [], isSuccess: providersLoaded } = useQuery({
    queryKey: ['llms', llmBackend, llmCowork],
    queryFn: () => llmsApi.listOn(llmBackend, llmCowork),
  })
  const { data: sessions = [] } = useQuery<Session[]>({ queryKey: ['sessions'], queryFn: sessionsApi.list })
  // 已装 skill 列表（与 SkillsPage 共享缓存）——用于 /skill 补全下拉与发送前的合法性校验。
  const { data: skills = [] } = useQuery<LocalSkill[]>({ queryKey: ['skills'], queryFn: skillsApi.list })
  // 新会话首条消息也支持 /skill（首条即新 run，可绑定）。hook 须在早返回前无条件调用。
  const pendingSkillMenu = useSkillMenu({ input: pendingInput, setInput: setPendingInput, skills, enabled: true, textareaRef: pendingTextareaRef })
  const pendingHistory = useInputHistory(setPendingInput, pendingTextareaRef)

  const session = sse.session
  const isRunning = session?.status === 'RUNNING' || session?.status === 'QUEUED'
  const isInterrupted = session?.status === 'INTERRUPTED'
  // 这条会话的 cowork 权限被收回了 → 只读：历史照常看，但不能再往下跑。
  // 边界在后端（resume/续聊一律 403 COWORK_REVOKED），这里只是别让用户对着一个能打字的
  // 输入框白忙一场——点了发送才被拒，比一开始就说清楚糟得多。
  const readOnly = isSessionReadOnly(session, useLineupState())
  // 「忙」= 运行中 或 正等你回答 HITL（ask_user / 授权 / 等待输入）。队列只在「忙→闲」的边沿抽干，
  // 即真正干完时才发——避免 ask_user 提问那种暂停被当成空闲、把队列消息插进未结束的任务里。
  const busy = isRunning || session?.status === 'PAUSED_HITL' || session?.status === 'WAITING_INPUT'
  // 运行中排队发送：点发送只入队（FIFO），等会话空闲再逐条真发。
  // 队列存在组件树之外的 messageQueue 里、由 useQueueDrainer 统一发送——切走会话、切到设置页、
  // 乃至压根没在看这个会话，agent 一跑完照样自动发出去。这里只负责「排」和「显示」。
  const queuedMessages = useSyncExternalStore(
    subscribeQueues,
    useCallback(() => getQueue(sessionId), [sessionId]),
  )
  const prevBusyRef = useRef(busy)

  // 长会话性能：分组 memo 化 + react-virtuoso 虚拟化（只渲染视口内的行，见下方 <Virtuoso>）。
  // busy 一并传进去兜底：会话已经不忙了，task 却没收到终态事件（最典型是 delegate 后
  // root task 停在 SUSPENDED，永远等不到 FINISHED），胶囊会一直呼吸。会话都闲下来了，
  // 就没有 task 还在产出，一律按收尾处理。
  const grouped = useMemo(() => groupItems(sse.items, sse.tasks, busy), [sse.items, sse.tasks, busy])
  // 流式消息作为列表【最后一个数据项】（不放 Footer）——这样 scrollToIndex 到 LAST 能到达它、
  // 且随 token 重渲染；规避“增长的 Footer 把贴底判断搞乱 + 手动 scrollTop 与 Virtuoso 异步测量打架”。
  const streamingActive = sse.streamingText !== null || sse.streamingImages.length > 0 || sse.streamingReasoning !== null
  const listData = useMemo<RowData[]>(() => (
    streamingActive
      ? [...grouped, { type: 'streaming', text: sse.streamingText ?? '', images: sse.streamingImages, reasoning: sse.streamingReasoning ?? undefined }]
      : grouped
  ), [grouped, streamingActive, sse.streamingText, sse.streamingImages, sse.streamingReasoning])
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Virtuoso 的滚动容器：task 过程区展开/收起会让该行高度突变，虚拟列表按 scrollTop 定位、
  // 不会自动锚住这一块 → 页面跳变。拿到它才能把高度差补进 scrollTop（见 TaskRow）。
  const scrollerElRef = useRef<HTMLElement | null>(null)

  // 输入历史来源：当前会话里用户发过的消息（供 Composer 上/下箭头回溯），旧→新。
  const sentHistory = useMemo(
    () => sse.items
      .filter((it): it is ChatMessage => it.kind === 'message' && (it as ChatMessage).role === 'user')
      .map(it => it.content)
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0),
    [sse.items],
  )

  // ── 会话内查找（Ctrl+F）──────────────────────────────────────────────────────
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findActive, setFindActive] = useState(0)   // 命中列表里的当前序号
  const findInputRef = useRef<HTMLInputElement>(null)

  // 命中词的扁平列表：逐个命中词导航（不是逐行）。每项 = {row: 行下标, k: 该行内第几个命中}。
  // 仅在查找框打开时才扫描——否则查找词残留会让流式生成（listData 每 token 变）时反复空算。
  const occurrences = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!findOpen || !q) return [] as { row: number; k: number }[]
    const occ: { row: number; k: number }[] = []
    listData.forEach((row, i) => {
      const t = rowDisplayText(row).toLowerCase()
      let idx = t.indexOf(q); let k = 0
      while (idx >= 0) { occ.push({ row: i, k }); k++; idx = t.indexOf(q, idx + q.length) }
    })
    return occ
  }, [findOpen, listData, findQuery])

  // 命中数变化时把 active 收进合法范围。
  useEffect(() => { setFindActive(a => (occurrences.length ? Math.min(a, occurrences.length - 1) : 0)) }, [occurrences.length])

  const activeOcc = findOpen && occurrences.length ? occurrences[findActive] : null
  const findNext = useCallback(() => setFindActive(a => (occurrences.length ? (a + 1) % occurrences.length : 0)), [occurrences.length])
  const findPrev = useCallback(() => setFindActive(a => (occurrences.length ? (a - 1 + occurrences.length) % occurrences.length : 0)), [occurrences.length])

  // 收集某行 DOM 里所有命中词的 Range（按文档顺序）。
  const rangesInRow = useCallback((rowEl: Element, q: string): Range[] => {
    const lq = q.toLowerCase()
    const out: Range[] = []
    const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || ''
      if (!text) continue
      const lt = text.toLowerCase()
      let idx = lt.indexOf(lq)
      while (idx >= 0) {
        const r = document.createRange(); r.setStart(node, idx); r.setEnd(node, idx + q.length)
        out.push(r); idx = lt.indexOf(lq, idx + q.length)
      }
    }
    return out
  }, [])

  // 用 CSS Custom Highlight API 给命中的**文字片段**上色（不改 markdown DOM、不重渲染）。
  // 当前命中词（active 行的第 k 个）用深蓝 chat-find-active，其余可见命中用浅蓝 chat-find。
  const highlightMatches = useCallback(() => {
    const CSSH = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS
    const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!CSSH?.highlights || !HighlightCtor) return
    CSSH.highlights.delete('chat-find'); CSSH.highlights.delete('chat-find-active')
    const q = findQuery.trim()
    if (!findOpen || !q) return
    const all: Range[] = []; const active: Range[] = []
    document.querySelectorAll('[data-item-index]').forEach((el) => {
      const rowIdx = Number(el.getAttribute('data-item-index'))
      const ranges = rangesInRow(el, q)
      ranges.forEach((r, i) => {
        if (activeOcc && rowIdx === activeOcc.row && i === activeOcc.k) active.push(r)
        else all.push(r)
      })
    })
    if (all.length) CSSH.highlights.set('chat-find', new HighlightCtor(...all))
    if (active.length) CSSH.highlights.set('chat-find-active', new HighlightCtor(...active))
  }, [findOpen, findQuery, activeOcc, rangesInRow])

  // 把当前命中词滚到视口中央（用 scrollIntoView，自动作用于滚动容器，不依赖手动取 scroller）。
  const centerActiveWord = useCallback(() => {
    const q = findQuery.trim()
    if (activeOcc == null || !q) return
    const rowEl = document.querySelector(`[data-item-index="${activeOcc.row}"]`)
    if (!rowEl) return
    const ranges = rangesInRow(rowEl, q)
    const range = ranges[activeOcc.k] ?? ranges[0]
    if (!range) return
    const el = (range.startContainer.parentElement as HTMLElement | null)
    el?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [activeOcc, findQuery, rangesInRow])

  // 打开查找 / 切换命中 / 内容变化：先 scrollToIndex 把行渲染进视口，再多跑几拍等渲染落定，
  // 每拍都居中命中词 + 重刷高亮（跳过去瞬间行可能还没渲染，靠重试兜住）。
  useEffect(() => {
    if (!findOpen) return
    if (activeOcc) virtuosoRef.current?.scrollToIndex({ index: activeOcc.row, align: 'center' })
    const timers = [30, 90, 200, 400].map(ms => setTimeout(() => { centerActiveWord(); highlightMatches() }, ms))
    return () => timers.forEach(clearTimeout)
  }, [findOpen, findActive, activeOcc, listData, centerActiveWord, highlightMatches])

  // 卸载时清除高亮。
  useEffect(() => () => {
    const CSSH = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS
    CSSH?.highlights?.delete('chat-find'); CSSH?.highlights?.delete('chat-find-active')
  }, [])

  // Ctrl/Cmd+F 打开查找；Esc 关闭。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setFindOpen(true)
        setTimeout(() => { findInputRef.current?.focus(); findInputRef.current?.select() }, 0)
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [findOpen])

  // 注：会话的当前模型不再由此处同步进全局状态。模型选择现在按 sessionId 隔离，
  // 由 Desktop 从「该会话的暂存选择 override 或会话后端模型」派生（见 App.tsx）。
  // 这里只保留"选中账号已被删除/隐藏 → 清回默认"的清理。
  useEffect(() => {
    if (providersLoaded && nextProvider && !providers.some(p => p.name === nextProvider)) {
      onNextLLMChange('', '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, nextProvider, providersLoaded])

  // 首屏一次性定位到底部（历史一次性到达后）。仅此一次、不影响后续跟随；之后的贴底跟随交给
  // Virtuoso 的 followOutput（按真实位置判断、只在贴底时跟随，内部处理测量与最后一项增长）。换会话重置。
  const didInit = useRef(false)
  useEffect(() => { didInit.current = false }, [sessionId])
  useEffect(() => {
    if (!didInit.current && listData.length > 0) {
      didInit.current = true
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' })
    }
  }, [listData.length])

  // Create session on first message (pending mode)
  const createMut = useMutation({
    mutationFn: async (content: { text: string; skillName?: string | null }) => {
      const { text, skillName } = content
      const cloud = pendingSession?.location === 'cloud'
      const session = await sessionsApi.create(
        {
          user_prompt: text,
          llm_account: pendingSession?.provider || null,
          llm_model: pendingSession?.model || null,
          // 云端会话不选本地目录：工作区由云端后端按**文件夹名**派生（路径给了也会被忽略），
          // 这是客户端无从指定容器内任意目录的关键。
          workspace: cloud ? null : (pendingSession?.workingDir || null),
          workspace_folder: cloud ? (pendingSession?.cloudFolder || null) : null,
          user_info: pendingSession?.user || user || null,
          // 会话归哪个 agent。草稿里存的是 agent id，这里才转成后端认的 template_id。
          // agentById 过一道：草稿可能来自上一个版本的 branding（阵容变了、id 已不存在），
          // 那就当没选，让后端回落默认模板，而不是把一个不存在的模板名发过去让创建失败。
          template_id: (() => {
            const a = agentById(pendingSession?.agentId)
            return a ? templateIdOf(a.id) : null
          })(),
          initial_task: skillName ? { skill_name: skillName } : null,
          mode: pendingMode,
        },
        cloud ? 'cloud' : 'local',
      )
      // 这里曾经补传草稿期攥着的文件。现在不需要了：云端草稿的工作区文件夹在选定那一刻
      // 就已经存在，文件是**直接传上去的**（与本地草稿同一套交互），不再有待传队列。
      return session
    },
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      composerRef.current?.clear()
      setPendingInput('')
      setPendingTokens(0)
      void reportPendingAbuse(session.id)   // 首条：会话已含 user_prompt，此刻上报才带得上原话
      onSessionCreated(session.id)
    },
  })

  const sendMut = useMutation({
    mutationFn: (arg: { content: MessageContent; skillName?: string | null }) => {
      // 优先从 pendingSession 获取，备用全局 user
      const userInfo = pendingSession?.user || user || null
      return sessionsApi.sendMessage(
        sessionId!, arg.content, nextProvider || null, nextModel || null, userInfo,
        arg.skillName ? { skill_name: arg.skillName } : null,
      )
    },
    // 向已结束会话发消息会使其恢复运行；该会话的事件流在终态时已被关闭，需重新订阅。
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); composerRef.current?.clear(); sse.reconnect(); void reportPendingAbuse(sessionId) },
  })
  type HitlAction = { item: ChatWaitingInput; text?: string }
  const idOf = async (item: ChatWaitingInput) =>
    item.hitl_id ?? await resolveHitlId(sessionId!, item)

  const answerMut = useMutation({
    // 面板文本/结构化答题:精确 answer;无 id/失败 → 兜底旧 /messages 通道
    mutationFn: async ({ item, text }: HitlAction) => {
      sse.noteHitlAnswerTarget(item)
      const id = await idOf(item)
      if (id) {
        try { const r = await hitlApi.answer(sessionId!, id, text!); sse.removePendingHitl(id); return r }
        catch { /* fall through */ }
      }
      return sessionsApi.answerInput(sessionId!, text!)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }) },
  })
  const approveMut = useMutation({
    mutationFn: async ({ item }: HitlAction) => {
      sse.noteHitlAnswerTarget(item)
      const id = await idOf(item)
      if (id) {
        try { const r = await hitlApi.approve(sessionId!, id); sse.removePendingHitl(id); return r }
        catch { /* fall through */ }
      }
      return sessionsApi.answerInput(sessionId!, 'approved')
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }) },
  })
  const rejectMut = useMutation({
    mutationFn: async ({ item }: HitlAction) => {
      sse.noteHitlAnswerTarget(item)
      const id = await idOf(item)
      if (id) {
        try { const r = await hitlApi.reject(sessionId!, id); sse.removePendingHitl(id); return r }
        catch { /* fall through */ }
      }
      return sessionsApi.answerInput(sessionId!, 'rejected')
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }) },
  })
  const waitReplyMut = useMutation({
    // PAUSED 软待命(人为打断/纯文本暂停)回复:精确端点+携带当前模型选择(语义=旧 /messages);
    // 拿不到 id → 兜底 sendMessage(带 llm,走薄委托)
    mutationFn: async (arg: { text: string }) => {
      const id = await resolveHitlId(sessionId!, null)
      if (id) {
        try { return await hitlApi.answer(sessionId!, id, arg.text, nextProvider || null, nextModel || null) } catch { /* fall through */ }
      }
      return sessionsApi.sendMessage(sessionId!, arg.text, nextProvider || null, nextModel || null)
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); composerRef.current?.clear(); sse.reconnect() },
  })
  const interruptMut = useMutation({ mutationFn: () => sessionsApi.interrupt(sessionId!) })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isRunning && sessionId && !showNewDialog) {
        interruptMut.mutate()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isRunning, sessionId, showNewDialog, interruptMut])

  const resumeMut = useMutation({
    mutationFn: (body?: { llm_account?: string; llm_model?: string }) =>
      sessionsApi.resume(sessionId!, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sessions'] }); sse.clearLlmError(); sse.reconnect() },
  })

  const bashModeQ = useQuery({
    queryKey: ['bash-review-mode', sessionId],
    queryFn: () => sessionsApi.getBashReviewMode(sessionId!),
    enabled: !!sessionId,
  })
  const bashModeMut = useMutation({
    mutationFn: (mode: BashReviewMode) => sessionsApi.setBashReviewMode(sessionId!, mode),
    onSuccess: (d) => {
      qc.setQueryData(['bash-review-mode', sessionId], d)
      // 全自动但本平台无 OS 边界（非 Windows / 无 pywin32）→ 显式告知降级：仍有准入拒绝 + rewind，
      // 但缺「写工作区外被系统拦」那层强制。用现成 toast（红条）提醒，不静默。
      if (d.mode === 'strict-auto' && d.os_low_integrity === false) {
        showToast(false, t('workMode.noOsBoundary'))
      }
    },
    onError: (e: Error) => {
      // 后端拒绝切换（如工作区没权限建边界，AUTO_MODE_NO_PERMISSION）→ 模式已在后端回滚，
      // 显示仍是旧模式；这里把原因弹出来，别让用户以为“点了没反应”。
      showToast(false, e?.message || t('workMode.switchFailed'))
      qc.invalidateQueries({ queryKey: ['bash-review-mode', sessionId] })  // 与后端回滚后的真值对齐
    },
  })
  const bashMode = bashModeQ.data?.mode ?? 'semiauto'

  // 真正发送（按会话状态路由）。仅用于「用户此刻按下发送」；排队消息的自动发送在 useQueueDrainer。
  function sendNow(text: string, picked: LocalSkill | null = null) {
    const { skillName, prompt } = parseSkillCommand(text, skills, picked)
    if (session?.status === 'PAUSED') {
      // 软待命回复不新起 run → 不能硬绑 skill；改为在回复里带一句自然语言指令，让 agent
      // 自主调用该 skill。（ask_user / 工具授权类 HITL 走的是 HITL 面板输入框，不经此路，不受影响。）
      waitReplyMut.mutate({ text: pausedReplyText(prompt, skillName, text) })
      return
    }
    // 消息体发**原始输入**（含 /skillName），会话里就显示成用户输入的样子；
    // skill 仍走结构化 skillName 绑定，不受影响。
    sendMut.mutate({ content: text, skillName })
  }

  // 由 Composer 上抛的提交（正文 + 下拉里刚选中的 skill）。
  // 骂人彩蛋：递增即放一波💩弹幕（见 components/PoopRain.tsx）
  const [poopTrigger, setPoopTrigger] = useState(0)
  // 扔完粑粑弹一条正经话。怕有用户被粑粑激到，所以提示要体面：先道歉，再说会话去了哪、
  // 谁会看。文案分两版，取决于**真的报上去没有**——遥测没配 / 网络失败时谎称"已上报"
  // 比不提示更伤人。
  const [abuseNotice, setAbuseNotice] = useState<null | { reported: boolean }>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current) }, [])
  // 待上报的辱骂（命中信息）。**上报要等这句用户原话落库之后**才做——上报会导出会话数据，
  // 而触发这次的原话此刻还没进会话/DB，现在报只会报一份缺了原话的记录（看不到用户骂了啥）。
  // 所以检测到就先记在这里，等 createMut/sendMut 成功（消息已进会话）再由 reportPendingAbuse 上报。
  const abuseToReport = useRef<NonNullable<ReturnType<typeof detectAbuse>> | null>(null)

  // 节流见 lib/abuseReport.ts：同一会话按冷却期限流，而不是「一辈子只报一次」——
  // 用户隔天接着聊、又骂，那时会话里全是新内容，该报。
  // 注意只有**成功**才记冷却：失败不该占掉这次机会，否则半小时内再骂也不会重试。
  // 检测到辱骂：**只**扔粑粑（即时反应）+ 记下待上报。**不在这里上报**——见 abuseToReport。
  function reactToAbuse(hit: NonNullable<ReturnType<typeof detectAbuse>>) {
    setPoopTrigger(n => n + 1)
    abuseToReport.current = hit
  }

  // 上报待处理的辱骂。由消息落库点调用（createMut / sendMut 的 onSuccess）——此刻这句原话
  // 已经在会话里，导出的会话数据才带得上它。sid 用落库后确定的会话 id（首条来自新建返回）。
  async function reportPendingAbuse(sid: string | null | undefined) {
    const hit = abuseToReport.current
    if (!hit || !sid) return
    abuseToReport.current = null

    let reported = false
    if (!canReportAbuse(sid)) {
      reported = true   // 冷却期内 = 不久前刚成功报过
    } else {
      const note = `自动上报：用户骂了（命中「${hit.term}」，${hit.lang}/${hit.tier}），已向其发送扔粑粑弹幕。`
      try {
        const r = await window.electronAPI?.reportSession?.(sid, note)
        reported = !!r?.ok
      } catch { reported = false }
      if (reported) markAbuseReported(sid)
    }

    // 等粑粑飞得差不多了再弹字，两个动画别抢注意力
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => {
      setAbuseNotice({ reported })
      noticeTimerRef.current = setTimeout(() => setAbuseNotice(null), 9000)
    }, 1200)
  }

  // 骂人彩蛋的收尾提示。就贴在输入框正上方——用户此刻的视线在那儿，飘在屏幕角落
  // 反而容易错过。普通块（不是 portal + fixed），跟着输入框走位。
  // 抽成常量是因为两个渲染分支（pending / 正常会话）都要挂同一份。
  const abuseNoticeEl = abuseNotice ? (
    <div
      onClick={() => setAbuseNotice(null)}
      title={t('common.close')}
      style={{
        margin: '0 auto 8px', maxWidth: 620, width: '100%',
        padding: '9px 13px', borderRadius: 'var(--r)',
        fontSize: 12.5, lineHeight: 1.6,
        border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--t2)',
        cursor: 'pointer', animation: 'notice-life 9s ease both',
      }}
    >
      {t(abuseNotice.reported ? 'chat.abuseNoticeReported' : 'chat.abuseNoticeUnsent')}
    </div>
  ) : null

  function handleSend(rawText: string, picked: LocalSkill | null = null) {
    const text = rawText.trim()
    if (!text) return

    // 骂人彩蛋：只是加个反应，不拦消息——该发还是照发。
    const abuse = detectAbuse(text)
    if (abuse) reactToAbuse(abuse)

    // Pending mode: first message triggers session creation
    if (pendingSession) {
      const { skillName } = parseSkillCommand(text, skills, picked)
      // 发原始输入（含 /skillName），首条消息就显示成用户输入的样子；skill 走结构化绑定。
      createMut.mutate({ text, skillName })
      return
    }

    if (!sessionId) return

    // agent 运行中：不真发，追加到队列末尾，等空闲由 drainer 逐条发。
    // 模型选择随消息一起存下来——延后发送时不能改用别人当时选的模型。
    if (isRunning) {
      const { skillName, prompt } = parseSkillCommand(text, skills, picked)
      enqueue(sessionId, { text, prompt, skillName, provider: nextProvider || null, model: nextModel || null })
      composerRef.current?.clear()
      return
    }

    sendNow(text, picked)
  }

  // 正在看的这个会话，「忙→闲」边沿一到就催 drainer 立刻发，省掉它 3s 轮询的等待。
  // 只认边沿：ask_user 那种暂停算「忙」，不会被当成任务结束。没在看的会话由 drainer 轮询兜底。
  useEffect(() => {
    // 切会话的那一帧 sse.session 仍是旧会话的（SSE 在父组件的 effect 里才重置）→ 先等对上号。
    if (!session || session.id !== sessionId) return
    const wasBusy = prevBusyRef.current
    prevBusyRef.current = busy
    if (wasBusy && !busy) requestDrain(sessionId, session.status)
  }, [busy, sessionId, session])

  // ── Pending mode ──────────────────────────────────────────────────────────────

  if (pendingSession) {
    const dirName = pendingSession.workingDir.split(/[\\/]/).filter(Boolean).pop() ?? pendingSession.workingDir
    const pendingOver = pendingTokens > MAX_INPUT_TOKENS
    const canCreate = pendingInput.trim().length > 0 && !createMut.isPending && !pendingOver

    function submitPending() {
      const text = pendingInput.trim()
      if (!text || pendingOver) return
      // 首条消息不走 handleSend，彩蛋要在这儿单独接一次。此刻会话还没建出来、
      // 没有 sessionId，reactToAbuse 里会走「没能自动上报」那版文案。
      const firstAbuse = detectAbuse(text)
      if (firstAbuse) reactToAbuse(firstAbuse)
      pendingHistory.commit(text)
      const { skillName } = parseSkillCommand(text, skills, pendingSkillMenu.picked)
      createMut.mutate({ text, skillName })
    }
    function onPendingKeyDown(e: React.KeyboardEvent) {
      if (pendingSkillMenu.onKeyDown(e)) return   // 补全消费了该按键
      if (pendingHistory.onKeyDown(e)) return      // 上/下箭头回溯历史
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submitPending() }
    }
    function onPendingChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      const r = checkInput(e.target.value)
      if (r.text.length !== e.target.value.length) e.target.value = r.text
      setPendingInput(r.text)
      setPendingTokens(r.tokens)
      pendingHistory.noteEdited()   // 手动改动 → 退出历史回溯
      // 高度统一由上面的 useLayoutEffect 按 pendingInput 重算，这里不再各写一份
    }
    // 从工作区拖入文件 → 在光标处插入文件名（新会话首条输入框）
    function onPendingDrop(e: React.DragEvent) {
      const dropped = e.dataTransfer.getData('text/plain')
      if (!dropped || createMut.isPending) return
      e.preventDefault()
      const el = pendingTextareaRef.current
      const start = el?.selectionStart ?? pendingInput.length
      const end = el?.selectionEnd ?? pendingInput.length
      const before = pendingInput.slice(0, start)
      const after = pendingInput.slice(end)
      const lead = before && !/\s$/.test(before) ? ' ' : ''
      const trail = after && !/^\s/.test(after) ? ' ' : ''
      const r = checkInput(before + lead + dropped + trail + after)
      setPendingInput(r.text)
      setPendingTokens(r.tokens)
      pendingHistory.noteEdited()
      const caret = (before + lead + dropped).length
      requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(caret, caret) } })
    }

    return (
      <div className="flex h-full flex-col items-center justify-center" style={{ background: 'var(--bg1)', padding: '32px 24px' }}>
        <PoopRain trigger={poopTrigger} />
        {/* 运行位置标识：本地=目录，云端=云端工作区（+ 已选文件数） */}
        <div className="mb-6 flex items-center gap-2.5 rounded-lg px-4 py-2.5" style={{ background: 'var(--bg2)', border: '1px solid var(--border)' }}>
          {pendingSession.location === 'cloud' ? (
            <>
              <CloudIcon size={16} className="flex-shrink-0" style={{ color: 'var(--teal)' }} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" style={{ color: 'var(--t1)' }}>{t('workspace.cloudTitle')}</p>
                <p className="truncate text-xs" style={{ color: 'var(--t3)' }}>
                  {t('workspace.cloudHint')}
                </p>
              </div>
            </>
          ) : (
            <>
              <FolderIcon size={16} className="flex-shrink-0 text-yellow-500" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" style={{ color: 'var(--t1)' }}>{dirName}</p>
                <p className="truncate text-xs" style={{ color: 'var(--t3)' }}>{pendingSession.workingDir}</p>
              </div>
            </>
          )}
        </div>

        {/* 标题提示 */}
        <p className="mb-5 text-sm" style={{ color: 'var(--t3)' }}>{t('chat.startAgentHint')}</p>

        {/* 居中输入卡片 */}
        <div style={{ width: '100%', maxWidth: 560 }}>
          {abuseNoticeEl}
          <div style={{
            position: 'relative',
            background: 'var(--bg1)', border: '1px solid var(--border)',
            borderRadius: 'var(--r2)', boxShadow: 'var(--shadow)',
            transition: 'border-color .15s, box-shadow .15s',
          }}
            onFocusCapture={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--blue)'; el.style.boxShadow = '0 0 0 3px var(--blue-dim)' }}
            onBlurCapture={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border)'; el.style.boxShadow = 'var(--shadow)' }}
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--blue)'; el.style.boxShadow = '0 0 0 3px var(--blue-dim)' }}
            onDragLeave={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border)'; el.style.boxShadow = 'var(--shadow)' }}
            onDrop={e => { const el = e.currentTarget as HTMLElement; el.style.borderColor = 'var(--border)'; el.style.boxShadow = 'var(--shadow)'; onPendingDrop(e) }}
          >
            {/* /skill 补全下拉 */}
            {pendingSkillMenu.open && (
              <SkillMenu items={pendingSkillMenu.items} activeIdx={pendingSkillMenu.activeIdx} onPick={pendingSkillMenu.accept} onHover={pendingSkillMenu.setActiveIdx} />
            )}
            <textarea
              // 高度是命令式写在 style 上的，textarea 一旦重新挂载（切到别的会话再切回来，
              // ChatPanel 本身没卸载，只有这块 JSX 被条件渲染掉）inline style 就随节点没了，
              // 塌回 rows=1。ref 回调每次挂载/渲染都会跑，比 useLayoutEffect([pendingInput])
              // 可靠——后者在「值没变、节点却换了」这条路径上根本不触发。
              ref={el => {
                pendingTextareaRef.current = el
                if (el) {
                  el.style.height = 'auto'
                  el.style.height = `${Math.min(el.scrollHeight, PENDING_MAX_H)}px`
                }
              }}
              className="ta-scroll"
              value={pendingInput}
              onFocus={() => pokeUpdate()}
              onChange={onPendingChange}
              onKeyDown={onPendingKeyDown}
              disabled={createMut.isPending}
              placeholder={t('chat.firstInputPlaceholder')}
              rows={1}
              autoFocus
              style={{
                width: '100%', padding: '12px 14px 4px', margin: 0,
                background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13.5,
                resize: 'none', maxHeight: PENDING_MAX_H, lineHeight: 1.6, overflowY: 'auto',
                opacity: createMut.isPending ? 0.5 : 1,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 9px 9px', justifyContent: 'flex-end' }}>
              <TokenCounter tokens={pendingTokens} />
              {pendingSkillMenu.bound && (
                <span
                  title={pendingSkillMenu.bound.description || pendingSkillMenu.bound.name}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600, color: 'var(--blue)', background: 'var(--blue-dim)', borderRadius: 6, padding: '2px 7px' }}
                >
                  <ZapIcon size={11} />{pendingSkillMenu.bound.name}
                </span>
              )}
              <WorkModeButton
                value={pendingMode}
                onChange={m => { modeTouched.current = true; setPendingMode(m) }}
                disabled={createMut.isPending}
              />
              <ModelPickerButton
                providers={providers}
                selectedProvider={pendingSession.provider}
                selectedModel={pendingSession.model}
                onChange={onNextLLMChange}
                disabled={createMut.isPending}
              />
              <button
                onClick={submitPending}
                disabled={!canCreate}
                style={{
                  width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                  background: canCreate ? 'var(--blue)' : 'var(--bg3)',
                  border: 'none', color: canCreate ? '#fff' : 'var(--t3)',
                  display: 'grid', placeItems: 'center', cursor: canCreate ? 'pointer' : 'not-allowed',
                  transition: 'background var(--tr)',
                }}
              >
                {createMut.isPending ? <Spinner className="h-3 w-3" /> : <ArrowUp size={14} strokeWidth={2.5} />}
              </button>
            </div>
          </div>
          {createMut.isError && (
            <p style={{ marginTop: 6, fontSize: 11, color: 'var(--red)' }}>
              {(createMut.error as Error)?.message ?? ''}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ── No session selected ───────────────────────────────────────────────────────

  if (!sessionId) {
    return (
      <>
        {/* 空态只负责「开始」：跟谁聊由全局当前 agent 决定（左缘抽屉切换），
            不在这里再摆一遍阵容——那样选完就再也回不去，且只在没选会话时才出现。 */}
        <AgentEmptyState
          agent={currentAgent}
          onStart={() => { setPickedAgent(currentAgent); setShowNewDialog(true) }}
        />
        <NewSessionDialog
          open={showNewDialog}
          agent={pickedAgent}
          recentSessions={sessions}
          onClose={() => setShowNewDialog(false)}
          onCreated={(p) => { setShowNewDialog(false); onNewSession(p) }}
        />
      </>
    )
  }

  // ── Normal session mode ───────────────────────────────────────────────────────

  const nonWaitPendings = sse.pendingHitls.filter(w => w.form !== 'wait')
  const waitCount = sse.pendingHitls.length - nonWaitPendings.length
  const hitlKeyOf = (w: ChatWaitingInput) => w.hitl_id || w.id
  // 默认展开首条;当前展开项被移除时回落首条;新条目不抢占
  const effectiveExpandedKey = nonWaitPendings.some(w => hitlKeyOf(w) === expandedKey)
    ? expandedKey : (nonWaitPendings[0] ? hitlKeyOf(nonWaitPendings[0]) : null)
  const activeAction =
    (answerMut.isPending && answerMut.variables) ||
    (approveMut.isPending && approveMut.variables) ||
    (rejectMut.isPending && rejectMut.variables) || null
  const busyKey = activeAction ? hitlKeyOf((activeAction as HitlAction).item) : null
  // 手风琴整体显示门（含"仅 wait 提示"场景）；composer/activity/interrupted 的隐藏门更窄——
  // 只在有非 wait 条目（占用输入区做专属应答 UI）时才隐藏，wait-only 场景仍走 composer 回复
  const hasPendingPanel = nonWaitPendings.length > 0 || waitCount > 0
  const hasExpandablePanel = nonWaitPendings.length > 0

  // AI 气泡的署名：以**这条会话自己的 agent** 为准（会话带着 template_id，跟着会话走，
  // 不会因为你切了 cowork 就把历史会话的署名改掉）；没有会话时（草稿/空态）用当前选中的；
  // 阵容为空（衍生品牌没配 agent）才退回产品外壳名。
  const agentName = (agentOfSession(session ?? {}) ?? currentAgent)?.displayName
    ?? String(branding.productName)

  return (
    <OpenUrlContext.Provider value={onOpenUrl ?? null}>
    <AgentNameContext.Provider value={agentName}>
    <RewindContext.Provider value={rewindCtx}>
    <div className="flex h-full flex-col" style={{ background: 'var(--bg1)', position: 'relative' }}>
      <PoopRain trigger={poopTrigger} />
      {/* 会话内查找栏（Ctrl+F）—— 浮在右上角 */}
      {findOpen && (
        <div style={{
          position: 'absolute', top: 8, right: 16, zIndex: 30,
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px',
          background: 'var(--bg1)', border: '1px solid var(--border)',
          borderRadius: 'var(--r2)', boxShadow: 'var(--shadow)',
        }}>
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={e => { setFindQuery(e.target.value); setFindActive(0) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) findPrev(); else findNext() }
              else if (e.key === 'Escape') { setFindOpen(false) }
            }}
            placeholder={t('chat.findPlaceholder')}
            spellCheck={false}
            style={{ width: 180, height: 26, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 'var(--r)', background: 'var(--bg1)', color: 'var(--t1)', outline: 'none', fontSize: 12.5 }}
          />
          <span style={{ minWidth: 42, textAlign: 'center', fontSize: 11.5, color: 'var(--t3)', fontVariantNumeric: 'tabular-nums' }}>
            {occurrences.length ? `${findActive + 1}/${occurrences.length}` : (findQuery.trim() ? '0/0' : '')}
          </span>
          <FindBtn title={t('chat.findPrev')} disabled={!occurrences.length} onClick={findPrev}><ChevronUpIcon size={14} /></FindBtn>
          <FindBtn title={t('chat.findNext')} disabled={!occurrences.length} onClick={findNext}><ChevronDownIcon size={14} /></FindBtn>
          <FindBtn title={t('common.close')} onClick={() => setFindOpen(false)}><XIcon size={14} /></FindBtn>
        </div>
      )}
      {/* Header —— 透明，跟 chat 一体 */}
      {session && (
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <EditableSessionTitle
              session={session}
              mode="inline"
              className="text-sm font-medium"
              style={{ color: 'var(--t1)' }}
            />
            {isCloudSession(session.id) && <CloudBadge />}
          </div>
          <div className="ml-1 flex flex-shrink-0 items-center gap-1">
            {/* 工作模式选择器已挪到输入框工具条（新建/进行中都可选），头部不再重复 */}
            <ReportSessionButton sessionId={session.id} />
            {canShowWorkspace && onToggleWorkspace && (
              <HeaderIconBtn
                title={workspaceOpen ? t('chat.hideWorkspace') : t('chat.showWorkspace')}
                active={workspaceOpen}
                onClick={onToggleWorkspace}
              >
                {workspaceOpen ? <PanelRightCloseIcon size={15} /> : <PanelRightIcon size={15} />}
              </HeaderIconBtn>
            )}
          </div>
        </div>
      )}

      {/* Messages —— react-virtuoso 虚拟化，只渲染视口内的行；主流式气泡是列表最后一个数据项，
          observer/待处理 HITL 在 Footer。贴底跟随交给 Virtuoso 的 followOutput（只在贴底时跟）。 */}
      {!sse.connected && !sse.session ? (
        <div className="flex-1 flex justify-center py-4"><Spinner /></div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          scrollerRef={el => { scrollerElRef.current = (el as HTMLElement) ?? null }}
          itemsRendered={() => { if (findOpen && findQuery.trim()) highlightMatches() }}
          className="flex-1"
          style={{ minHeight: 0 }}
          data={listData}
          followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
          computeItemKey={(_, row) => (
            row.type === 'streaming' ? 'streaming'
              : row.type === 'tools' ? `tg-${row.tools[0].id}`
                : row.type === 'task' ? `tk-${row.taskId}-${(row.process[0] ?? row.finals[0])?.id ?? ''}`
                  : `it-${row.item.id}`
          )}
          itemContent={(_, row) => (
            row.type === 'streaming'
              ? <AssistantBubble content={row.text} images={row.images} reasoning={row.reasoning} streaming />
              : row.type === 'tools'
                ? <ToolCallGroup tools={row.tools} />
                : row.type === 'task'
                  ? <TaskRow group={row} scrollerRef={scrollerElRef} />
                  : <ChatItemView item={row.item} />
          )}
          initialTopMostItemIndex={Math.max(0, listData.length - 1)}
          increaseViewportBy={{ top: 600, bottom: 800 }}
          components={{ Footer: MessagesFooter }}
          context={{
            sse,
            pendingProps: hasPendingPanel ? {
              items: nonWaitPendings,
              expandedKey: effectiveExpandedKey,
              onExpand: setExpandedKey,
              onAnswer: (item, text) => answerMut.mutate({ item, text }),
              onApprove: (item) => approveMut.mutate({ item }),
              onReject: (item) => rejectMut.mutate({ item }),
              busyKey,
            } : null,
          } satisfies FooterCtx}
        />
      )}

      {/* LLM 可重试失败的内联提示 —— 信息性,无按钮(终态失败走弹窗) */}
      {sse.llmRetrying && (
        <div style={{ padding: '0 14px 6px', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
            borderRadius: 'var(--r)', border: '1px solid rgba(220,38,38,.25)', background: 'rgba(254,242,242,.7)',
          }}>
            <Spinner className="h-3 w-3" />
            <span style={{ fontSize: 12.5, color: '#b91c1c' }}>
              {sse.llmRetryProgress
                ? t('llmError.retryingN', { attempt: sse.llmRetryProgress.attempt, max: sse.llmRetryProgress.maxAttempts })
                : t('llmError.retrying')}
            </span>
          </div>
        </div>
      )}

      {/* Activity strip —— 输入框上方，显示当前在干嘛 + 时长。
          显示门：仅「运行中(RUNNING/QUEUED)」才显示。用后端真实 status，不捏造：
          会话一旦暂停/结束/中断，即使还收到尾随推送(text_done/finish_task 等)也不再显示，
          杜绝「答完暂停后氛围词凭空冒出并空转计时」。isRunning 已可靠驱动输入禁用/中断按钮，
          故生成期间不会误挡。计时起点见 useSessionSSE（实时用事件时间，历史回放复位到现在）。 */}
      {!hasExpandablePanel && isRunning && (
        <div style={{ padding: '0 18px', flexShrink: 0 }}>
          <ActivityStrip activity={sse.currentActivity} />
        </div>
      )}

      {/* FAILED/INTERRUPTED 会话通告框 —— 取代输入框（原内联 INTERRUPTED 横幅收编）。
          FAILED 额外等 history 回放完（sse.historyLoaded）：切会话时 init 先到、notice 尚空，
          否则会闪一下红色兜底框（会话失败/未获得原因），history 补上 notice 后才变紫。 */}
      {/* 权限被收回：压过 FAILED/INTERRUPTED 的通告框。那两个都在劝用户"继续/恢复"，
          而这条会话恰恰是继续不了的——同时出现只会让人反复点一个注定 403 的按钮。 */}
      {!hasExpandablePanel && readOnly && <ReadOnlyBar templateId={session?.template_id} />}

      {!hasExpandablePanel && !readOnly && (isInterrupted || (session?.status === 'FAILED' && !noticeDismissed && sse.historyLoaded)) && (
        <SessionNoticeBar
          status={isInterrupted ? 'INTERRUPTED' : 'FAILED'}
          notice={sse.notice}
          interruptReason={sse.interruptReason}
          providers={providers}
          initialProvider={nextProvider}
          initialModel={nextModel}
          onContinue={() => setNoticeDismissed(true)}
          onResume={llm => resumeMut.mutate(llm)}
          resumePending={resumeMut.isPending}
        />
      )}

      {/* Input —— 透明背景，跟 chat 一体 */}
      {!hasExpandablePanel && !readOnly && !isInterrupted && !(session?.status === 'FAILED' && !noticeDismissed) && (
        <>
          {/* 排队待发送（FIFO）：虚线浅蓝一叠 chip，明显区别于真消息气泡；空闲后按顺序自动发出 */}
          {queuedMessages.length > 0 && (
            <div style={{ padding: '0 14px 2px', flexShrink: 0 }}>
              <div style={{ border: '1px dashed var(--blue)', borderRadius: 'var(--r)', background: 'var(--blue-dim)', padding: '5px 8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <ClockIcon size={12} style={{ color: 'var(--blue)', flexShrink: 0 }} />
                  <span style={{ color: 'var(--blue)', fontWeight: 600, fontSize: 11.5 }}>{t('chat.queued')} ({queuedMessages.length})</span>
                  <span style={{ color: 'var(--t3)', fontSize: 10, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{t('chat.queuedHint')}</span>
                </div>
                {/* 整条完整显示（换行保留、长词强制折行），不做省略号截断；条目多了整块滚动 */}
                <div style={{ maxHeight: QUEUE_MAX_H, overflowY: 'auto' }}>
                  {queuedMessages.map((m, i) => (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '1px 0' }}>
                      <span style={{ color: 'var(--t3)', fontSize: 10, fontFamily: 'monospace', flexShrink: 0, lineHeight: '18px' }}>{i + 1}.</span>
                      <span style={{ color: 'var(--t2)', fontSize: 12, lineHeight: '18px', flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</span>
                      <button
                        onClick={() => setQueue(sessionId!, queuedMessages.filter(x => x.id !== m.id))}
                        title={t('common.delete')}
                        style={{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--t3)', padding: 0, height: 18, display: 'grid', placeItems: 'center' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--red)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
                      >
                        <XIcon size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {abuseNoticeEl}
          <Composer
            ref={composerRef}
            providers={providers}
            selectedProvider={nextProvider}
            selectedModel={nextModel}
            onModelChange={onNextLLMChange}
            onSend={handleSend}
            placeholder={isRunning ? t('chat.runningQueuePlaceholder') : t('chat.inputPlaceholder')}
            busy={sendMut.isPending}
            showInterrupt={isRunning}
            onInterrupt={() => interruptMut.mutate()}
            skills={skills}
            sentHistory={sentHistory}
            workMode={bashMode}
            onWorkModeChange={m => bashModeMut.mutate(m)}
            workModeDisabled={bashModeMut.isPending}
            queued={queuedMessages[queuedMessages.length - 1]?.text ?? null}
            onRetractQueue={() => setQueue(sessionId!, queuedMessages.slice(0, -1))}
          />
        </>
      )}

      {/* 终态 LLM 调用错误弹窗 */}
      {sse.llmError && (
        <LLMErrorModal
          message={sse.llmError.message}
          onClose={sse.clearLlmError}
        />
      )}
      {/* 结果 toast。portal 到 body + position:fixed → 贴【视口】右下角（不受对话面板/
          祖先 transform 影响）。风格对齐 app 通告条（SessionNoticeBar）：浅色底+细色边+同色文字。 */}
      {toast && createPortal(
        <div style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 1000, maxWidth: 320,
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '9px 13px', borderRadius: 'var(--r)', fontSize: 12.5, fontWeight: 500,
          border: `1px solid ${toast.ok ? 'rgba(34,197,94,.32)' : 'rgba(220,38,38,.3)'}`,
          background: toast.ok ? 'rgba(240,253,244,.96)' : 'rgba(254,242,242,.96)',
          color: toast.ok ? '#15803d' : '#b91c1c',
          boxShadow: '0 6px 22px rgba(0,0,0,.12)', backdropFilter: 'blur(2px)',
          animation: 'msg-fade-up .2s ease both',
        }}>
          {toast.ok ? <Check size={14} /> : <XIcon size={14} />}
          <span>{toast.text}</span>
        </div>, document.body)}

    </div>
    </RewindContext.Provider>
    </AgentNameContext.Provider>
    </OpenUrlContext.Provider>
  )
}

// ── Header icon button ────────────────────────────────────────────────────────

function HeaderIconBtn({ onClick, title, active, children }: {
  onClick: () => void; title?: string; active?: boolean; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
      style={{
        background: active ? 'var(--blue-dim)' : 'none',
        color: active ? 'var(--blue)' : 'var(--t3)',
        border: 'none', cursor: 'pointer',
      }}
      onMouseEnter={e => { const el = e.currentTarget as HTMLElement; if (!active) { el.style.background = 'var(--bg3)'; el.style.color = 'var(--t2)' } }}
      onMouseLeave={e => { const el = e.currentTarget as HTMLElement; if (!active) { el.style.background = 'none'; el.style.color = 'var(--t3)' } }}
    >
      {children}
    </button>
  )
}

// ── Item renderers ────────────────────────────────────────────────────────────

// memo：item 引用稳定时整条历史项跳过重渲染（敲键/父级重渲染都不再重解析 markdown）。
// tool_call 不再经过此组件——由 groupItems() 分组后交给 ToolCallGroup 渲染。
const ChatItemView = React.memo(function ChatItemView({ item }: { item: ChatItem }) {
  if (item.kind === 'message')          return <MessageRow msg={item} />
  if (item.kind === 'hitl_answer')      return <HitlAnswerRow item={item} />
  return null
})

// ── Avatar (AI only) ──────────────────────────────────────────────────────────

const AV_AI: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8, flexShrink: 0,
  display: 'grid', placeItems: 'center', marginTop: 2,
  fontSize: 11, fontWeight: 700,
  background: 'linear-gradient(135deg, var(--blue), var(--teal))', color: '#fff',
}

// ── 用户原文 ─────────────────────────────────────────────────────────────────
// 用户敲进输入框的内容不是 Markdown：解析它会把 `#` 吃成空标题、抹掉行首缩进、
// 把多行折成一行，`$VAR` 还会被 remark-math 当成公式。原样呈现，pre-wrap 保留
// 换行与空格。LLM 产出的文本仍走 <Markdown>——那是它的预期输出格式。

export function PlainText({ text }: { text: string }) {
  return <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
}

// ── HitlAnswer row ───────────────────────────────────────────────────────────

const HitlAnswerRow = React.memo(function HitlAnswerRow({ item }: { item: ChatHitlAnswer }) {
  const { t } = useI18n()
  const rw = useContext(RewindContext)
  return (
    <div className="msg-row" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
      padding: '8px 16px', animation: 'msg-fade-up .2s ease both',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4, flexDirection: 'row-reverse' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>{t('chat.me')}</span>
        <span style={{ fontSize: 10.5, color: 'var(--t3)' }}>{fmtTime(item.created_at)}</span>
        {rw?.sessionId && typeof item.turnSeq === 'number' && <RewindButton turnSeq={item.turnSeq} />}
      </div>
      <div style={{ maxWidth: '72%', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
        <div style={{ ...BUBBLE_USER, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* 标签 */}
          <div style={{ fontSize: 11, color: 'var(--blue)', fontWeight: 600, letterSpacing: '.02em' }}>
            ↩ {t('chat.hitlAnswerLabel')}
          </div>
          {/* 内容 */}
          {item.parsedQA ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {item.parsedQA.map((qa, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--t3)', fontStyle: 'italic' }} className="prose prose-sm max-w-none msg-md">
                    <span style={{ fontStyle: 'normal', fontWeight: 600 }}>{t('chat.hitlQuestion')}</span>
                    <Markdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={MD_URL_TRANSFORM} components={hitlMdComponents}>{qa.question}</Markdown>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 11.5, color: 'var(--t3)', fontWeight: 600 }}>{t('chat.hitlAnswerPrefix')}</span>
                    <PlainText text={qa.answer} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            // 兜底：旧会话 content 解析失败时，取最后 " → " 后的答案文本
            <PlainText text={(() => { const i = item.content.lastIndexOf(' → '); return i >= 0 ? item.content.slice(i + 3).trim() : item.content })()} />
          )}
        </div>
        <CopyButton text={item.content} alignEnd />
        {typeof item.turnSeq === 'number' && <RewindRecords turnSeq={item.turnSeq} />}
      </div>
    </div>
  )
})

// ── Message row ───────────────────────────────────────────────────────────────

// rewind：某条用户消息旁的"回退工作区"图标按钮 —— 平时随气泡 hover 才显示（.msg-row:hover）。
// 点击弹 modal 确认；确认后 modal 立即关闭、结果走右下角 toast（在 ChatPanel）+ 消息下方内联记录。
function RewindButton({ turnSeq }: { turnSeq: number }) {
  const { t } = useI18n()
  const rw = useContext(RewindContext)
  const [open, setOpen] = useState(false)
  // 该回合无检查点（新会话未拍 / 已被 GC）→ 不显示按钮，避免点了必然失败
  if (!rw || !rw.rewindableTurns.has(turnSeq)) return null
  return (
    <>
      <button
        title={t('rewind.tooltip')} onClick={() => setOpen(true)}
        className="msg-rewind-btn"
        style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--blue)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--t3)' }}
      >
        <RotateCcwIcon size={12} />
      </button>
      {open && createPortal(
        <div onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 380, maxWidth: '90vw', background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,.25)', padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t1)', marginBottom: 8 }}>{t('rewind.title')}</div>
            <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--t2)' }}>
              {(() => {
                const em = t('rewind.confirmEmphasis')
                const parts = t('rewind.confirm').split(em)
                return parts.length > 1
                  ? <>{parts[0]}<span style={{ color: 'var(--amber)', fontWeight: 600 }}>{em}</span>{parts.slice(1).join(em)}</>
                  : t('rewind.confirm')
              })()}
            </div>
            <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.6, color: 'var(--amber)' }}>{t('rewind.confirmRisk')}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
              <button onClick={() => setOpen(false)}
                style={{ fontSize: 13, padding: '6px 14px', borderRadius: 8, background: 'var(--bg3)', color: 'var(--t2)', border: 'none', cursor: 'pointer' }}>
                {t('common.cancel')}
              </button>
              <button onClick={() => { rw.rewind(turnSeq); setOpen(false) }}
                style={{ fontSize: 13, padding: '6px 14px', borderRadius: 8, background: 'var(--red)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                {t('rewind.restore')}
              </button>
            </div>
          </div>
        </div>, document.body)}
    </>
  )
}

// rewind：某回合成功回滚的内联记录（显示在该回合消息下方；多次回滚逐条堆叠）。醒目样式。
// 最近一次、且窗口未关的回滚记录旁挂「撤销」入口（恢复到回滚前）；已撤销的记录标灰+删除线。
function RewindRecords({ turnSeq }: { turnSeq: number }) {
  const { t } = useI18n()
  const rw = useContext(RewindContext)
  const recs = (rw?.records[turnSeq]) || []
  if (recs.length === 0) return null
  const undoable = rw?.undoableRewind
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, alignItems: 'flex-end' }}>
      {recs.map((r, i) => {
        // 「撤销」只挂在该回合【最后一条】、且正是全局可撤销的那条记录上（未撤销、窗口未关）。
        const isUndoable = !r.undone && !!undoable && undoable.turnSeq === turnSeq && i === recs.length - 1
        // 一个统一的柔和琥珀胶囊：图标 + 文字 +（发丝分隔线 + 无边框的撤销链接）。已撤销 → 灰色删除线。
        return (
          <div key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            // 可撤销态右侧留 7px，与分隔线到按钮的 gap 对齐 → hover 淡底左右等距、居中不偏右。
            padding: isUndoable ? '3px 7px 3px 10px' : '4px 10px', borderRadius: 999,
            fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'nowrap',
            color: r.undone ? 'var(--t3)' : 'var(--amber)',
            background: r.undone ? 'transparent' : 'rgba(245,158,11,.10)',
            border: `1px solid ${r.undone ? 'var(--border)' : 'rgba(245,158,11,.26)'}`,
          }}>
            <RotateCcwIcon size={11} style={{ opacity: r.undone ? 0.55 : 0.85, flexShrink: 0 }} />
            <span style={r.undone ? { textDecoration: 'line-through', opacity: 0.85 } : undefined}>
              {t('rewind.record', { time: fmtDateTime(r.at) })}
            </span>
            {r.undone && <span style={{ opacity: 0.85 }}>· {t('rewind.undoneTag')}</span>}
            {isUndoable && (
              <>
                <span aria-hidden style={{ width: 1, height: 13, background: 'rgba(245,158,11,.30)', flexShrink: 0 }} />
                <button
                  onClick={() => rw!.undo(turnSeq, undoable!.safetyId)}
                  title={t('rewind.undoTooltip')}
                  className="rewind-undo-link"
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    padding: '3px 9px', borderRadius: 999, cursor: 'pointer', lineHeight: 1,
                    fontSize: 11.5, fontWeight: 600, color: 'var(--amber)',
                    background: 'transparent', border: 'none', flexShrink: 0,
                  }}
                >
                  {t('rewind.undo')}
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

const MessageRow = React.memo(function MessageRow({ msg }: { msg: ChatMessage }) {
  const agentName = useContext(AgentNameContext)
  const { t } = useI18n()
  const openUrl = useContext(OpenUrlContext)
  const rw = useContext(RewindContext)
  const isUser = msg.role === 'user'

  if (isUser) {
    // User: column, right-aligned, no avatar
    return (
      <div className="msg-row" style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
        padding: '8px 16px', animation: 'msg-fade-up .2s ease both',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4, flexDirection: 'row-reverse' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>{t('chat.me')}</span>
          <span style={{ fontSize: 10.5, color: 'var(--t3)' }}>{fmtTime(msg.created_at)}</span>
          {rw?.sessionId && typeof msg.turnSeq === 'number' && <RewindButton turnSeq={msg.turnSeq} />}
        </div>
        <div style={{ maxWidth: '72%', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <div style={BUBBLE_USER}>
            {msg.images?.map((img, i) => <ImageView key={i} img={img} />)}
            <PlainText text={msg.content} />
          </div>
          <CopyButton text={msg.content} alignEnd />
          {typeof msg.turnSeq === 'number' && <RewindRecords turnSeq={msg.turnSeq} />}
        </div>
      </div>
    )
  }

  // AI: row, left-aligned, with avatar
  return (
    <div className="msg-row" style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 16px', animation: 'msg-fade-up .2s ease both',
    }}>
      <div style={AV_AI}>✦</div>
      <div style={{ maxWidth: '72%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>{agentName} AI</span>
          <span style={{ fontSize: 10.5, color: 'var(--t3)' }}>{fmtTime(msg.created_at)}</span>
        </div>
        <div style={BUBBLE_AI}>
          {msg.images?.map((img, i) => <ImageView key={i} img={img} />)}
          {msg.reasoning && <ReasoningBlock text={msg.reasoning} />}
          <div className="prose prose-sm max-w-none msg-md">
            <Markdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={MD_URL_TRANSFORM} components={mdComponents}>{msg.content}</Markdown>
          </div>
          {msg.sources && <WebSources sources={msg.sources} onOpenUrl={openUrl ?? undefined} />}
        </div>
        <CopyButton text={msg.content} />
      </div>
    </div>
  )
})

// ── Virtuoso 底部 Footer ────────────────────────────────────────────────────────
// observer 流式 + 待处理 HITL 面板，随列表内容一起滚动。（主流式气泡已作为列表最后一个数据项，
// 不在这里。）模块级稳定组件 → 父组件重渲染不会 remount（待处理回复输入框不丢焦点）；内容更新
// 通过 Virtuoso 的 context 传入。
type FooterCtx = {
  sse: SSEHandle
  pendingProps: React.ComponentProps<typeof PendingHitlAccordion> | null
}

function MessagesFooter({ context }: { context?: FooterCtx }) {
  if (!context) return null
  const { sse, pendingProps } = context
  return (
    <>
      {sse.observerStreamingText !== null && (
        <div style={{ padding: '4px 16px 4px 58px', fontSize: 11, color: 'var(--t3)', fontStyle: 'italic' }}>
          {sse.observerStreamingText}
        </div>
      )}
      {pendingProps && <PendingHitlAccordion {...pendingProps} />}
    </>
  )
}

// ── Streaming assistant bubble ─────────────────────────────────────────────────

function AssistantBubble({ content, images, reasoning, streaming }: { content: string; images: ChatImageData[]; reasoning?: string; streaming?: boolean }) {
  const agentName = useContext(AgentNameContext)
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 16px', animation: 'msg-fade-up .2s ease both',
    }}>
      <div style={AV_AI}>✦</div>
      <div style={{ maxWidth: '72%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t2)' }}>{agentName} AI</span>
        </div>
        <div style={BUBBLE_AI}>
          {images.map((img, i) => <ImageView key={i} img={img} />)}
          {reasoning && <ReasoningBlock text={reasoning} defaultOpen={streaming} />}
          <div className="prose prose-sm max-w-none msg-md">
            <Markdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={MD_URL_TRANSFORM} components={mdComponents}>{content}</Markdown>
          </div>
          {streaming && <span style={{
            display: 'inline-block', width: 2, height: 13, marginLeft: 2, verticalAlign: 'middle',
            background: 'var(--t3)', animation: 'pulse 1s infinite',
          }} />}
        </div>
      </div>
    </div>
  )
}

// ── Thinking dots row ─────────────────────────────────────────────────────────

// ── Activity strip (above input): vibe word / tool name + live duration ───────

function ActivityStrip({ activity }: { activity: ActivityState | null }) {
  const { t } = useI18n()
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!activity) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [activity])
  if (!activity) return null
  const elapsed = Date.now() - new Date(activity.started_at).getTime()
  const lbl = activityLabel(activity, elapsed)
  const text = lbl.kind === 'tool'
    ? t('activity.tool', { tool: lbl.tool })
    : t(`activity.vibe.${lbl.phase}.${lbl.index}`)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '2px 4px 8px', fontSize: 12, color: 'var(--t2)',
      animation: 'msg-fade-up .2s ease both',
    }}>
      <Spinner className="h-3 w-3" />
      <span>{text}</span>
      <span style={{ color: 'var(--t3)' }}>· {formatDuration(elapsed)}</span>
    </div>
  )
}

// ── Tool call grouping helpers ────────────────────────────────────────────────

type ItemGroup =
  | { type: 'tools'; tools: ChatToolCall[] }
  | { type: 'single'; item: ChatItem }
  // 一个后端 task：中间过程（工具调用 + 阶段性回复）收进一块「过程」区，最终答复留在外面。
  // 过程区是背景氛围——干活时低对比呈现、干完收成一行；用户永远能一眼看到自己的话和最终答复。
  // 不同 task 各自成块，绝不合并——并发任务的事件流要能分开看。
  | { type: 'task'; taskId: string; title: string; done: boolean; process: ChatItem[]; finals: ChatMessage[] }

// Virtuoso 列表行：消息分组 + 一个可选的“流式中”行（作为最后一项，随 token 重渲染）。
type RowData = ItemGroup | { type: 'streaming'; text: string; images: ChatImageData[]; reasoning: string | undefined }

// 会话内查找（Ctrl+F）：提取一行**默认可见**的文本。虚拟列表下屏幕外消息不在 DOM，故基于
// 数据搜；同时只取默认渲染出来的文本（不含折叠的推理/工具参数与输出），这样数据里数出的命中数
// 与 DOM 里能高亮的一致，逐个命中词导航才对得上。
function itemDisplayText(item: ChatItem): string {
  switch (item.kind) {
    case 'message': return item.content || ''
    case 'tool_call': return item.tool_name || ''   // 头部可见；参数/结果默认折叠，不计
    case 'hitl_answer': return item.content || ''
    case 'waiting_input': return item.prompt || ''
    default: return ''
  }
}
function rowDisplayText(row: RowData): string {
  if (row.type === 'streaming') return row.text || ''
  if (row.type === 'tools') return row.tools.map(itemDisplayText).join('\n')
  // 最终答复始终可见；过程默认逐条卷起——运行中只剩最新一条露在外面，干完全卷。
  if (row.type === 'task') {
    const parts = row.finals.map(itemDisplayText)
    if (!row.done) parts.push(...row.process.slice(-1).map(itemDisplayText))
    return parts.filter(Boolean).join('\n')
  }
  return itemDisplayText(row.item)
}

/** 过程条上露出的那一行：只用任务标题。
 *
 *  这里刻意**不**回退到「最近一步在做什么」：那个值随任务推进每来一步就变一次，
 *  长在标题的位置上却一直跳，看起来就像「后一个 task 把前一个的标题改掉了」。
 *  拿不到标题时宁可留空，由状态行显示中性文案（执行中… / ✓ 已完成 · N 次工具调用）——
 *  信息并不丢，且不会误导。
 *
 *  标题为空的常见成因：task_created 时标题尚未定（等 recognize_intent 补 task_updated），
 *  或重开会话时 GET /sessions/{id}/tasks 拿不到（后端内存里没有该会话的 task）。 */
const TASK_SUMMARY_MAX = 90
function taskSummaryLine(row: Extract<ItemGroup, { type: 'task' }>): string {
  const t = row.title.trim()
  if (!t) return ''
  return t.length > TASK_SUMMARY_MAX ? t.slice(0, TASK_SUMMARY_MAX) + '…' : t
}

/** task 胶囊内部（以及无 task 归属的老会话）沿用原有分组：连续工具调用并成一张卡。 */
function groupPlain(items: ChatItem[]): ItemGroup[] {
  const groups: ItemGroup[] = []
  let i = 0
  while (i < items.length) {
    const item = items[i]
    if (item.kind === 'tool_call') {
      const tools: ChatToolCall[] = []
      while (i < items.length && items[i].kind === 'tool_call') {
        tools.push(items[i] as ChatToolCall)
        i++
      }
      groups.push({ type: 'tools', tools })
    } else {
      groups.push({ type: 'single', item })
      i++
    }
  }
  return groups
}

/** 归属某个 task 的条目：助手回复与工具调用（用户消息、HITL 问答始终留在胶囊外，便于回找）。 */
function taskIdOf(item: ChatItem): string {
  if (item.kind === 'tool_call') return item.task_id || ''
  if (item.kind === 'message' && item.role === 'assistant') return item.task_id || ''
  return ''
}

function groupItems(items: ChatItem[], tasks: Record<string, TaskInfo> = {}, sessionBusy = true): ItemGroup[] {
  const groups: ItemGroup[] = []
  let i = 0
  while (i < items.length) {
    const tid = taskIdOf(items[i])
    if (tid) {
      // 同一 task 的连续条目收成一个胶囊；task 一变立刻另起一块（并发任务不混在一起）。
      const chunk: ChatItem[] = []
      while (i < items.length && taskIdOf(items[i]) === tid) {
        chunk.push(items[i])
        i++
      }
      const info = tasks[tid]
      // 这一段后面还有别的条目（用户又说了一句、或另一个 task 起来了）→ 它必然已经结束。
      // 少了这一条就会出现：早就干完的胶囊，等用户再发一句话，`sessionBusy` 重新变 true，
      // done 跟着翻回 false，一屏历史胶囊集体重新呼吸闪烁。
      const hasLater = i < items.length
      // 末尾的助手回复 = 该 task 的答复 → 留在过程区外面，永远可读；其余是过程。
      // 若末尾是 finish_task 的交付物小结，它前面那条才是真正的答复，两条一并留在外面——
      // 否则小结会顶替掉答复，把答复卷进折叠的过程里看不见（小结常常只是文件清单）。
      const isAssistantMsg = (it: ChatItem | undefined): it is ChatMessage =>
        !!it && it.kind === 'message' && it.role === 'assistant'
      const finals: ChatMessage[] = []
      let cut = chunk.length
      const tail = chunk[cut - 1]
      if (isAssistantMsg(tail)) {
        finals.unshift(tail); cut--
        const prev = chunk[cut - 1]
        if (tail.task_summary && isAssistantMsg(prev)) { finals.unshift(prev); cut-- }
      }
      groups.push({
        type: 'task', taskId: tid,
        process: chunk.slice(0, cut),
        finals,
        title: info?.title || '',
        // 三个都是「已结束」的充分条件，任一成立即可：
        //   1. 后端给了终态（权威）
        //   2. 后面还有条目 —— 它不可能还在往这一段里写东西（修「用户再说一句、旧胶囊重新闪」）
        //   3. 会话不忙了 —— 兜「停在 SUSPENDED/ACTIVE 收不到终态」
        done: isTaskDone(info?.status) || hasLater || !sessionBusy,
      })
      continue
    }
    // 无 task 归属（用户消息、HITL，或旧会话的历史帧）→ 原有渲染，一切照旧
    const start = i
    while (i < items.length && !taskIdOf(items[i])) i++
    groups.push(...groupPlain(items.slice(start, i)))
  }
  return groups
}

// ── Task row（一个后端 task）──────────────────────────────────────────────────
// 观感目标（对齐 Claude 那种「丝滑」）：干活过程是**背景氛围**，不是需要逐条阅读的卡片墙。
//   · 运行中：一行会流光的状态字（"正在工作…"），下面把过程低对比铺开——瞥一眼知道在动就够，
//     想细看鼠标移上去自然变清晰，或点状态行收起。
//   · 干完：过程静静折成一行淡字（不画框、不加重），只在 hover 时浮出一点底色示意可点。
//   · 该 task 的**最终答复始终留在外面**、正常气泡呈现——用户要读的东西永远不用点开。
function TaskRow({ group, scrollerRef }: {
  group: Extract<ItemGroup, { type: 'task' }>
  scrollerRef?: React.MutableRefObject<HTMLElement | null>
}) {
  const { t } = useI18n()
  const { done, process, finals } = group
  // expanded = 用户主动要看全过程。平时不需要它：跑的时候只留最新一条，干完全收。
  const [expanded, setExpanded] = useState(false)
  const [hov, setHov] = useState(false)
  // 干完那一下把主动展开也复位，回到「只剩一行」的安静态。
  useEffect(() => { if (done) setExpanded(false) }, [done])

  // ── 展开/收起不跳页 ─────────────────────────────────────────────────────────
  // 虚拟列表按 scrollTop 定位，本行高度突变时不会自动锚住它 → 视觉上整页窜动。
  // 办法：切换前记下本行在屏幕上的位置，重排后把位移差补回 scrollTop，让它钉在原处。
  // Virtuoso 随后还会异步重测一次，故在下一帧再校正一次。
  const rootRef = useRef<HTMLDivElement>(null)
  const anchorTopRef = useRef<number | null>(null)

  const toggleExpanded = useCallback(() => {
    anchorTopRef.current = rootRef.current?.getBoundingClientRect().top ?? null
    setExpanded(e => !e)
  }, [])

  useLayoutEffect(() => {
    const before = anchorTopRef.current
    anchorTopRef.current = null
    if (before == null) return          // 非用户切换引起的重渲染（如新消息进来）→ 不动
    const fix = () => {
      const el = rootRef.current
      const scroller = scrollerRef?.current
      if (!el || !scroller) return
      const delta = el.getBoundingClientRect().top - before
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta
    }
    fix()
    const raf = requestAnimationFrame(fix)
    return () => cancelAnimationFrame(raf)
  }, [expanded, scrollerRef])

  const inner = useMemo(() => groupPlain(process), [process])
  const summary = taskSummaryLine(group)
  const toolCount = process.filter(it => it.kind === 'tool_call').length
  const finalNodes = finals.map(m => <ChatItemView key={m.id} item={m} />)

  // 没有过程（一问一答）→ 不加任何外壳，就是一条普通回复
  if (process.length === 0) return <>{finalNodes}</>

  // 收起的时机：**整个 task 干完**才收，运行中一直铺开。
  //
  // 早先是「每出来一条就把上一条卷走，只留最新那条」。信息量是够的，但体感很慢——干了半天，
  // 屏幕上永远只有孤零零一行，看不出进度在累积；而且刚出来的内容立刻被抽走，读到一半就没了。
  // 现在运行中把过程整段留着（看得见活在往前走），干完那一下再一次性折成一行。
  const visible = (done && !expanded) ? [] : inner

  // 没有任务标题时回落到中性文案（绝不拿「最近一步」冒充标题，见 taskSummaryLine）。
  //
  // 占位符要一眼看出**是状态、不是标题**：它长在标题的位置上，写成「执行中…」会被当成
  // 任务就叫这个名字。所以无标题时用带主语的说法（「正在执行这个任务」），并把工具次数
  // 接上去——既有实质信息，也不像个名字。
  const countPart = toolCount > 0 ? t('chat.toolsGroup', { count: toolCount }) : ''
  const statusText = done
    ? [summary || t('chat.taskDoneUnnamed'), countPart].filter(Boolean).join(' · ')
    : [summary || t('chat.taskRunningUnnamed'), countPart].filter(Boolean).join(' · ')

  return (
    <div ref={rootRef}>
      {/* 状态行：无边框、无卡片，只有一枚小圆点 + 一行字。运行中流光，收尾后转静。 */}
      <div style={{ padding: '2px 16px' }}>
        <button
          onClick={toggleExpanded}
          onMouseEnter={() => setHov(true)}
          onMouseLeave={() => setHov(false)}
          title={expanded ? t('chat.taskCollapse') : t('chat.taskExpand')}
          style={{
            display: 'flex', width: '100%', alignItems: 'center', gap: 8,
            padding: '5px 8px', cursor: 'pointer', textAlign: 'left',
            background: hov ? 'var(--bg2)' : 'transparent',
            border: 'none', borderRadius: 8,
            transition: 'background var(--tr)',
          }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
            background: done ? 'var(--t3)' : 'var(--blue)',
          }} className={done ? undefined : 'animate-pulse'} />
          <span
            className={done ? undefined : 'task-shimmer'}
            style={{
              flex: 1, minWidth: 0, fontSize: 11.5,
              color: done ? 'var(--t3)' : undefined,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {statusText}
          </span>
          {/* 箭头只在 hover 时浮现，安静时一行字干干净净 */}
          <span style={{
            fontSize: 9, color: 'var(--t3)', flexShrink: 0,
            opacity: hov ? 1 : 0, transition: 'opacity var(--tr)',
          }}>{expanded ? '▲' : '▼'}</span>
        </button>
      </div>

      {visible.length > 0 && (
        <div className={done ? 'task-process' : 'task-process task-live'}>
          {visible.map((g, idx) => (
            g.type === 'tools'
              ? <ToolCallGroup key={`tg-${g.tools[0].id}`} tools={g.tools} />
              : <ChatItemView key={`it-${g.type === 'single' ? g.item.id : idx}`} item={(g as { item: ChatItem }).item} />
          ))}
        </div>
      )}

      {finalNodes}
    </div>
  )
}

// ── Tool call — inner content (one row inside a group) ───────────────────────

const ToolCallInner = React.memo(function ToolCallInner({ tc, isLast }: { tc: ChatToolCall; isLast: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const argsStr = Object.keys(tc.arguments).length > 0 ? JSON.stringify(tc.arguments, null, 2) : ''
  // Tool failures are rendered neutrally (no red / no "error" wording): a failed
  // call shows a grey "已结束/Finished" instead of green "✓ 完成", and its detail
  // body uses the neutral "结果/Result" label. Avoids alarming users over
  // routine recoverable tool failures (MCP unreachable, skill non-zero exit, …).
  const isPending = tc.status === 'pending'
  const statusColor = isPending ? 'var(--blue)' : (tc.is_error ? 'var(--t3)' : 'var(--green)')
  const statusLabel = isPending ? t('chat.toolRunning') : (tc.is_error ? t('chat.toolEnded') : t('chat.toolDone'))
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', width: '100%', alignItems: 'center', gap: 7,
          padding: '7px 11px', cursor: 'pointer', textAlign: 'left',
          background: 'transparent', border: 'none',
          borderRadius: isLast && !open ? '0 0 9px 9px' : 0,
          transition: 'background var(--tr)',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <span style={{
          width: 16, height: 16, borderRadius: 3, flexShrink: 0,
          display: 'grid', placeItems: 'center', fontSize: 9,
          background: 'var(--blue-dim)', color: 'var(--blue)',
        }}>⚙</span>
        <code style={{ flex: 1, fontFamily: 'monospace', fontSize: 11, color: 'var(--t2)', fontWeight: 500 }}>{tc.tool_name}</code>
        <span style={{ fontSize: 10, color: statusColor, flexShrink: 0 }}>{statusLabel}</span>
        <span style={{ fontSize: 9, color: 'var(--t3)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{
          padding: '9px 11px', fontFamily: 'monospace', fontSize: 11,
          color: 'var(--t2)', lineHeight: 1.6, background: 'var(--bg2)',
          borderTop: '1px solid var(--border)',
          borderRadius: isLast ? '0 0 9px 9px' : 0,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {argsStr && (
            <div>
              <span style={{ color: 'var(--t3)', fontSize: 10 }}>{t('chat.args')}</span>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '3px 0 0', fontSize: 11, color: 'var(--t2)' }}>{argsStr}</pre>
            </div>
          )}
          {tc.result && (
            <div>
              <span style={{ color: 'var(--t3)', fontSize: 10 }}>{t('chat.result')}</span>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '3px 0 0', fontSize: 11, color: 'var(--t2)' }}>
                {tc.result.length > 2000 ? tc.result.slice(0, 2000) + '\n' + t('chat.resultTruncated') : tc.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ── Tool call group (card wrapping consecutive tool calls) ────────────────────

function ToolCallGroup({ tools }: { tools: ChatToolCall[] }) {
  const { t } = useI18n()
  const hasPending = tools.some(tc => tc.status === 'pending')
  const [open, setOpen] = useState(hasPending)

  // Auto-expand while any tool is pending; auto-collapse when all done.
  useEffect(() => { setOpen(hasPending) }, [hasPending])

  const groupStatusColor = hasPending ? 'var(--blue)' : 'var(--t3)'
  const groupStatusLabel = hasPending ? t('chat.toolRunning') : t('chat.toolDone')
  // Preview: first tool name (+ count badge if multiple)
  const previewName = tools[0].tool_name

  return (
    <div style={{ padding: '3px 16px' }}>
      <div style={{
        borderRadius: 10, overflow: 'hidden', boxShadow: 'var(--shadow)',
        border: '1px solid var(--border)', background: 'var(--bg1)',
      }}>
        {/* Group header */}
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex', width: '100%', alignItems: 'center', gap: 7,
            padding: '7px 11px', cursor: 'pointer', textAlign: 'left',
            background: 'var(--bg2)', border: 'none',
            borderRadius: open ? 0 : '9px',
            transition: 'background var(--tr)',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg2)' }}
        >
          <span style={{
            width: 20, height: 20, borderRadius: 4, flexShrink: 0,
            display: 'grid', placeItems: 'center', fontSize: 10,
            background: 'var(--blue-dim)', color: 'var(--blue)',
          }}>⚙</span>
          <span style={{ flex: 1, fontSize: 12, color: 'var(--t2)', fontWeight: 500 }}>
            {t('chat.toolsGroup', { count: tools.length })}
          </span>
          {!open && (
            <code style={{ fontSize: 10.5, color: 'var(--t3)', fontFamily: 'monospace', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {previewName}
            </code>
          )}
          <span style={{ fontSize: 10.5, color: groupStatusColor, flexShrink: 0, marginLeft: 6 }}>{groupStatusLabel}</span>
          <span style={{ fontSize: 9, color: 'var(--t3)', flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
        </button>
        {/* Expanded: individual tool rows */}
        {open && tools.map((tc, idx) => (
          <ToolCallInner key={tc.id} tc={tc} isLast={idx === tools.length - 1} />
        ))}
      </div>
    </div>
  )
}

// ── Observer row ──────────────────────────────────────────────────────────────

// ── Reasoning block (inside AI bubble) ───────────────────────────────────────

function ReasoningBlock({ text, defaultOpen }: { text: string; defaultOpen?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(defaultOpen ?? false)
  return (
    <div style={{ marginBottom: 8, paddingLeft: 8, borderLeft: '2px solid var(--border2)' }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--t3)', background: 'none', border: 'none', cursor: 'pointer' }}>
        <Brain size={10} /> {t('chat.reasoning')} <span style={{ fontSize: 8 }}>{open ? '▲' : '▶'}</span>
      </button>
      {open && <p style={{ marginTop: 4, whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.6, color: 'var(--t2)' }}>{text}</p>}
    </div>
  )
}

function ImageView({ img }: { img: ChatImageData }) {
  const src = img.source_type === 'base64' ? `data:${img.media_type};base64,${img.data}` : img.data
  return <img src={src} style={{ maxHeight: 256, maxWidth: '100%', borderRadius: 6, marginBottom: 8, objectFit: 'contain' }} />
}

// ── Bubble style constants ────────────────────────────────────────────────────

const BUBBLE_USER: React.CSSProperties = {
  display: 'inline-block',
  padding: '8px 12px', borderRadius: 12, borderTopRightRadius: 2,
  fontSize: 13.5, lineHeight: 1.65, wordBreak: 'break-word',
  background: 'var(--blue-dim)', color: 'var(--t1)', textAlign: 'left',
  border: '1px solid var(--blue-glow)',
}

const BUBBLE_AI: React.CSSProperties = {
  display: 'block',
  padding: '8px 12px', borderRadius: 12, borderTopLeftRadius: 2,
  fontSize: 13.5, lineHeight: 1.65, wordBreak: 'break-word',
  background: '#ffffff', border: '1px solid var(--border)', color: 'var(--t1)',
}

function PendingHitlAccordion({ items, expandedKey, onExpand, onAnswer, onApprove, onReject, busyKey }: {
  items: ChatWaitingInput[]                 // 非 wait 条目,created_at 升序
  expandedKey: string | null
  onExpand: (key: string) => void
  onAnswer: (item: ChatWaitingInput, text: string) => void
  onApprove: (item: ChatWaitingInput) => void
  onReject: (item: ChatWaitingInput) => void
  busyKey: string | null                    // 正在应答的条目 key(独立禁用)
}) {
  const { t } = useI18n()
  const keyOf = (w: ChatWaitingInput) => w.hitl_id || w.id
  return (
    <div style={{ padding: '4px 16px' }}>
      {items.length > 1 && (
        <div style={{ marginBottom: 4, fontSize: 11, fontWeight: 500, color: 'var(--t3)' }}>
          {t('chat.pendingHitlTitle')} ({items.length})
        </div>
      )}
      {items.map(item => {
        const k = keyOf(item)
        if (k !== expandedKey) {
          return (
            <button key={k} onClick={() => onExpand(k)} style={{
              display: 'block', width: '100%', textAlign: 'left', marginBottom: 4,
              padding: '6px 10px', borderRadius: 'var(--r)', cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--bg1)',
              fontSize: 12, color: 'var(--t2)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
            }}>
              ▸ {item.hitl_kind === 'approval' ? '⚠ ' : '? '}
              {(item.prompt || item.task_title || '').slice(0, 80)}
            </button>
          )
        }
        return (
          <div key={k} style={{ marginBottom: 4 }}>
            <WaitingInputPanel
              item={item}
              onAnswer={(text) => onAnswer(item, text)}
              onApprove={() => onApprove(item)}
              onReject={() => onReject(item)}
              busy={busyKey === k}
            />
          </div>
        )
      })}
    </div>
  )
}

function WaitingInputPanel({ item, onAnswer, onApprove, onReject, busy }: {
  item: ChatWaitingInput
  onAnswer: (text: string) => void; onApprove: () => void; onReject: () => void
  busy?: boolean
}) {
  const { t } = useI18n()
  const pokeUpdate = useUpdateNagPoke()
  // 回复文本归本面板自己持有：敲字只重渲染这里，不牵连 ChatPanel/历史列表。
  const [reply, setReply] = useState('')
  const [replyTokens, setReplyTokens] = useState(0)
  const replyOver = replyTokens > MAX_INPUT_TOKENS
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const isBash = item.input_type === 'bash_exec_confirm'
  // approval 类（含 bash 门控）渲染 Approve/Reject 按钮;input 类渲染文本框（spec/07）
  const isApproval = isBash || item.hitl_kind === 'approval'
  // bash 风险提示：后端把结构化数据（codes/manual）塞进 prompt(=HITL.question)，这里按 i18n 显示。
  // 解析失败 / 非 bash_risk（其它 HITL 的普通文本 prompt）→ null，回退原 Markdown 渲染。
  const bashRisk = useMemo<{ hits?: { cmd: string; code: string }[]; manual?: boolean } | null>(() => {
    if (!item.prompt) return null
    try { const p = JSON.parse(item.prompt); return p && p.t === 'bash_risk' ? p : null } catch { return null }
  }, [item.prompt])
  return (
    <div style={{
      borderRadius: 'var(--r)', border: `1px solid ${isBash ? 'rgba(234,88,12,.25)' : isApproval ? 'rgba(217,119,6,.25)' : 'rgba(37,99,235,.18)'}`,
      background: isBash ? 'rgba(255,237,213,.5)' : isApproval ? 'rgba(254,243,199,.5)' : 'rgba(37,99,235,.04)',
      padding: 12,
    }}>
      {isApproval ? (
        <>
          <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: 'var(--amber)' }}>
            {isBash ? <><Terminal size={12} /> {t('chat.execConfirm')}</> : t('chat.agentNeedsApproval')}
          </div>
          {isBash && item.command && (
            <pre style={{ marginBottom: 8, overflowX: 'auto', borderRadius: 'var(--r)', background: 'var(--bg1)', border: '1px solid var(--border)', padding: '6px 10px', fontSize: 11, color: 'var(--t2)' }}>{item.command}</pre>
          )}
          {bashRisk ? (
            <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--t2)' }}>
              {bashRisk.hits && bashRisk.hits.length > 0 ? (
                <>
                  <div style={{ marginBottom: 4 }}>{t('warn.bash.header')}</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {bashRisk.hits.map((h, i) => (
                      <li key={i}>
                        {h.cmd && (
                          <code style={{ background: 'var(--bg1)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', marginRight: 4, fontSize: 11 }}>{h.cmd}</code>
                        )}
                        {t(`warn.bash.${h.code}`)}
                      </li>
                    ))}
                  </ul>
                </>
              ) : bashRisk.manual ? (
                <div>{t('warn.bash.manual')}</div>
              ) : null}
            </div>
          ) : item.prompt ? (
            <div className="prose prose-sm max-w-none msg-md" style={{ marginBottom: 8, fontSize: 12, color: 'var(--t2)' }}>
              <Markdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={MD_URL_TRANSFORM} components={hitlMdComponents}>{item.prompt}</Markdown>
            </div>
          ) : null}
          {item.arguments && Object.keys(item.arguments).length > 0 && (
            <>
              <div style={{ marginBottom: 4, fontSize: 11, color: 'var(--t3)' }}>{t('chat.callArguments')}</div>
              <pre style={{ marginBottom: 8, maxHeight: 200, overflow: 'auto', borderRadius: 'var(--r)', background: 'var(--bg1)', border: '1px solid var(--border)', padding: '6px 10px', fontSize: 11, color: 'var(--t2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(item.arguments, null, 2)}</pre>
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" onClick={onApprove} disabled={busy} style={{ background: 'var(--amber)', color: '#fff' }}>{t('chat.allow')}</Button>
            <Button size="sm" variant="outline" onClick={onReject} disabled={busy}>{t('chat.reject')}</Button>
          </div>
        </>
      ) : item.questions && item.questions.length > 0 ? (
        <>
          <p style={{ marginBottom: 8, fontSize: 12, fontWeight: 500, color: 'var(--blue)' }}>{t('chat.agentNeedsInput')}</p>
          <StructuredQuestions questions={item.questions} onAnswer={onAnswer} />
        </>
      ) : (
        <>
          <p style={{ marginBottom: 8, fontSize: 12, fontWeight: 500, color: 'var(--blue)' }}>{t('chat.agentNeedsInput')}</p>
          {item.prompt && (
            <div className="prose prose-sm max-w-none msg-md" style={{ marginBottom: 8, fontSize: 13, color: 'var(--t2)' }}>
              <Markdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={MD_URL_TRANSFORM} components={hitlMdComponents}>{item.prompt}</Markdown>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={replyRef}
              autoFocus
              value={reply}
              rows={1}
              onChange={e => {
                const r = checkInput(e.target.value)
                if (r.text.length !== e.target.value.length) e.target.value = r.text
                setReply(r.text)
                setReplyTokens(r.tokens)
                const ta = e.target
                ta.style.height = 'auto'
                ta.style.height = ta.scrollHeight + 'px'
              }}
              onFocus={e => {
                pokeUpdate()
                const ta = e.target
                ta.setSelectionRange(ta.value.length, ta.value.length)
              }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && reply.trim() && !replyOver) { e.preventDefault(); onAnswer(reply) } }}
              style={{ flex: 1, resize: 'none', overflow: 'hidden', borderRadius: 'var(--r)', border: '1px solid var(--border)', padding: '6px 10px', fontSize: 13, background: 'var(--bg1)', color: 'var(--t1)', outline: 'none', lineHeight: 1.5, minHeight: 32 }}
              placeholder={t('chat.replyPlaceholder')}
            />
            <TokenCounter tokens={replyTokens} />
            <Button size="sm" disabled={!reply.trim() || replyOver} onClick={() => onAnswer(reply)}>{t('chat.send')}</Button>
          </div>
        </>
      )}
    </div>
  )
}

// ask_user 的结构化批量问题面板:每问单/多选 + 常驻"其他"文本框。提交时拼成统一编号文本走 onAnswer。
function StructuredQuestions({ questions, onAnswer }: { questions: AskQuestion[]; onAnswer: (text: string) => void }) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  function toggle(qi: number, label: string, multi: boolean) {
    setSelected(prev => {
      const cur = prev[qi] || []
      if (multi) {
        const next = cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label]
        return { ...prev, [qi]: next }
      }
      // 单选:替换;再点同一项=取消
      return { ...prev, [qi]: cur.length === 1 && cur[0] === label ? [] : [label] }
    })
    if (!multi) setOther(prev => ({ ...prev, [qi]: '' }))   // 单选与"其他"互斥
  }

  function setOtherText(qi: number, val: string, multi: boolean) {
    setOther(prev => ({ ...prev, [qi]: val }))
    if (!multi && val.trim()) setSelected(prev => ({ ...prev, [qi]: [] }))  // 单选:填"其他"清掉选项
  }

  function answerFor(qi: number): string[] {
    const parts = [...(selected[qi] || [])]
    const o = (other[qi] || '').trim()
    if (o) parts.push(o)
    return parts
  }

  const allAnswered = questions.every((_, qi) => answerFor(qi).length > 0)

  function submit() {
    if (!allAnswered) return
    // 统一编号(单问也编号),多选/含"其他"用 ", " 连接
    // q.question 中的换行转义为字面 \n，使每条答案保持单行，parseStructuredQA 可靠解析
    const text = questions.map((q, qi) => `${qi + 1}. ${q.question.replace(/\n/g, '\\n')} → ${answerFor(qi).join(', ')}`).join('\n')
    onAnswer(text)
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
    >
      {questions.map((q, qi) => {
        const multi = !!q.multi_select
        const cur = selected[qi] || []
        return (
          <div key={qi} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, fontSize: 13, color: 'var(--t1)' }}>
              <span style={{ color: 'var(--t3)', flexShrink: 0 }}>{qi + 1}.&nbsp;</span>
              {/* minWidth:0 让本 flex 子项可收缩到内容固有宽度以下,否则宽代码块/长公式撑破问题列表宽度、
                  内部 pre 的 overflowX:auto 永不触发 */}
              <div className="prose prose-sm max-w-none msg-md" style={{ flex: 1, minWidth: 0, color: 'var(--t1)' }}>
                <Markdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={MD_URL_TRANSFORM} components={hitlMdComponents}>{q.question}</Markdown>
              </div>
              {multi && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--t3)', flexShrink: 0 }}>{t('chat.multiSelectHint')}</span>}
            </div>
            {(q.options && q.options.length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {q.options.map((opt, oi) => {
                  const on = cur.includes(opt.label)
                  return (
                    <button key={oi} onClick={() => toggle(qi, opt.label, multi)} style={{
                      textAlign: 'left', borderRadius: 'var(--r)', padding: '7px 10px', cursor: 'pointer',
                      border: `1px solid ${on ? 'var(--blue)' : 'var(--border)'}`,
                      background: on ? 'var(--blue-dim)' : 'var(--bg1)',
                    }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--t1)' }}>
                        {opt.label}
                        {opt.recommended && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--amber)' }}>{t('chat.recommended')}</span>}
                      </div>
                      {opt.description && (
                        <div className="prose prose-sm max-w-none msg-md" style={{ marginTop: 2, fontSize: 11, color: 'var(--t2)' }}>
                          <Markdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={MD_URL_TRANSFORM} components={hitlMdComponents}>{opt.description}</Markdown>
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            <textarea
              rows={1}
              value={other[qi] || ''}
              onChange={e => {
                setOtherText(qi, e.target.value, multi)
                const ta = e.target; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'
              }}
              onFocus={e => {
                const ta = e.target; ta.setSelectionRange(ta.value.length, ta.value.length)
                if (!multi) setSelected(prev => ({ ...prev, [qi]: [] }))
              }}
              placeholder={t('chat.otherOption')}
              style={{ width: '100%', resize: 'none', overflow: 'hidden', borderRadius: 'var(--r)', border: '1px solid var(--border)', padding: '5px 10px', fontSize: 12, background: 'var(--bg1)', color: 'var(--t1)', outline: 'none', lineHeight: 1.5 }}
            />
          </div>
        )
      })}
      <div>
        <Button size="sm" disabled={!allAnswered} onClick={submit}>{t('chat.submit')}</Button>
      </div>
    </div>
  )
}

// ── Markdown overrides ────────────────────────────────────────────────────────

// 从 react-markdown 传入的 children 里抽出纯文本，供复制用（children 可能是字符串/数组/元素）。
function nodeToText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join('')
  if (React.isValidElement(node)) return nodeToText((node.props as { children?: React.ReactNode }).children)
  return ''
}

// 代码/命令块右上角的复制按钮。默认隐藏，悬停块时出现（.code-block:hover 见 index.css）。
function CodeCopyButton({ text }: { text: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  async function doCopy(e: React.MouseEvent) {
    e.stopPropagation()
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }
  return (
    <button
      onClick={doCopy}
      className="code-copy"
      title={copied ? t('chat.copied') : t('chat.copy')}
      aria-label={t('chat.copy')}
      style={{
        position: 'absolute', top: 6, right: 6, zIndex: 1,
        padding: '3px 5px', borderRadius: 5, cursor: 'pointer', lineHeight: 0,
        border: `1px solid ${copied ? 'var(--teal)' : 'var(--border)'}`,
        background: copied ? 'rgba(8,145,178,.10)' : 'var(--bg2)',
        color: copied ? 'var(--teal)' : 'var(--t3)',
        display: 'inline-flex', alignItems: 'center',
        transition: 'opacity var(--tr), color var(--tr), background var(--tr), border-color var(--tr)',
      }}
      onMouseEnter={e => { if (!copied) { const b = e.currentTarget; b.style.background = 'var(--bg3)'; b.style.borderColor = 'var(--border2)'; b.style.color = 'var(--t2)' } }}
      onMouseLeave={e => { if (!copied) { const b = e.currentTarget; b.style.background = 'var(--bg2)'; b.style.borderColor = 'var(--border)'; b.style.color = 'var(--t3)' } }}
    >
      {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={2} />}
    </button>
  )
}

// 行内代码若是本地文件路径 → 返回可交给 openUrl 的 file:// URL；否则 null。
// 覆盖 file:///… 与 Windows 绝对路径 D:\a\b.html / D:/a/b.html（须带文件扩展名，避免把普通
// 路径样文本都变可点）。模型常把路径用反引号包成行内代码，故在此识别。
function localFileUrl(text: string): string | null {
  const t = text.trim()
  if (/^file:\/\//i.test(t)) return t
  if (/^[A-Za-z]:[\\/].+\.\w+$/.test(t)) return 'file:///' + t.replace(/\\/g, '/')
  return null
}

export const mdComponents: React.ComponentProps<typeof Markdown>['components'] = {
  code({ className, children, ...props }) {
    const openUrl = useContext(OpenUrlContext)
    const isBlock = className?.includes('language-') || (typeof children === 'string' && children.includes('\n'))
    if (isBlock) {
      return (
        <div className="code-block" style={{ position: 'relative', margin: '4px 0' }}>
          <CodeCopyButton text={nodeToText(children).replace(/\n$/, '')} />
          <pre style={{ margin: 0, borderRadius: 6, overflow: 'hidden' }}>
            <code style={{ display: 'block', padding: '10px 12px', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6, background: '#f0f4fa', color: 'var(--t1)', overflowX: 'auto', whiteSpace: 'pre', border: 'none', borderRadius: 0 }} className={className} {...props}>{children}</code>
          </pre>
        </div>
      )
    }
    const inlineStyle = { fontFamily: 'monospace', fontSize: 12, background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4, color: 'var(--blue)' } as const
    const fileUrl = openUrl ? localFileUrl(typeof children === 'string' ? children : nodeToText(children)) : null
    if (fileUrl) {
      return <code onClick={() => openUrl!(fileUrl)} title="在预览中打开 / Open in preview" style={{ ...inlineStyle, cursor: 'pointer', textDecoration: 'underline' }} {...props}>{children}</code>
    }
    return <code style={inlineStyle} {...props}>{children}</code>
  },
  a({ href, children }) {
    const openUrl = useContext(OpenUrlContext)
    // http(s) → 应用内浏览器（网页 tab）；file:// 本地文件 → 右侧预览 tab（由 App 的 openUrl 按
    // 协议分流）。其它（mailto/相对等）走默认。
    const inApp = !!openUrl && !!href && /^(https?|file):\/\//i.test(href)
    return (
      <a
        href={href}
        target={inApp ? undefined : '_blank'}
        rel="noreferrer"
        onClick={inApp ? (e => { e.preventDefault(); openUrl!(href!) }) : undefined}
        style={{ color: 'var(--blue)', textDecoration: 'underline', cursor: 'pointer' }}
      >{children}</a>
    )
  },
  table({ children }) {
    return <div style={{ overflowX: 'auto' }}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>{children}</table></div>
  },
  th({ children }) {
    return <th style={{ border: '1px solid var(--bg3)', padding: '5px 10px', background: 'var(--bg2)', fontWeight: 600, color: 'var(--t1)', textAlign: 'left' }}>{children}</th>
  },
  td({ children }) {
    return <td style={{ border: '1px solid var(--bg3)', padding: '5px 10px', textAlign: 'left' }}>{children}</td>
  },
  blockquote({ children }) {
    return <blockquote style={{ margin: '4px 0', padding: '4px 10px', borderLeft: '3px solid var(--t3)', color: 'var(--t2)', background: 'var(--bg2)', borderRadius: '0 4px 4px 0' }}>{children}</blockquote>
  },
}

// 紧凑 md 组件：用于用户消息、ask_user 面板、HitlAnswerRow，段落/列表间距收紧
const hitlMdComponents: React.ComponentProps<typeof Markdown>['components'] = {
  ...mdComponents,
  p({ children }) { return <p style={{ margin: 0 }}>{children}</p> },
  ul({ children }) { return <ul style={{ margin: '2px 0', paddingLeft: '1.2em' }}>{children}</ul> },
  ol({ children }) { return <ol style={{ margin: '2px 0', paddingLeft: '1.2em' }}>{children}</ol> },
  li({ children }) { return <li style={{ margin: '1px 0' }}>{children}</li> },
}

// ── 输入区垂直拖拽 ─────────────────────────────────────────────────────────────
function startVDrag(e: React.MouseEvent, cb: (d: number) => void) {
  e.preventDefault()
  let last = e.clientY
  const mv = (ev: MouseEvent) => { cb(ev.clientY - last); last = ev.clientY }
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = '' }
  document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
}
function HResizeHandle({ onStart }: { onStart: (e: React.MouseEvent) => void }) {
  const [hov, setHov] = React.useState(false)
  return (
    <div onMouseDown={onStart} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ height: 8, flexShrink: 0, cursor: 'row-resize', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ height: 2, width: '30%', minWidth: 40, borderRadius: 1, background: hov ? 'var(--border2)' : 'transparent', transition: 'background .15s' }} />
    </div>
  )
}


/**
 * 只读条 —— 这条会话的 cowork 权限被收回了。
 *
 * 取代输入框，而不是把输入框置灰：置灰的话光标还能落进去、还能打字，用户会以为是暂时卡住。
 * 说清"只能查看"并给出下一步（找管理员），比让人对着一个不响应的框猜要短得多。
 *
 * 不提"重试"：这不是故障，重试一万次也一样。与 FAILED/INTERRUPTED 那两个通告框的区别就在
 * 这里——那两个都在劝你继续，这个是告诉你继续不了。
 */
function ReadOnlyBar({ templateId }: { templateId?: string | null }) {
  const { t } = useI18n()
  const id = agentIdFromTemplate(templateId)
  // 名字已经从阵容里消失了（正是"被收回"的表现），只剩 id 可显示——总比空着强，
  // 空着的话用户连"是哪个 cowork 没了"都不知道。
  return (
    <div style={{ flexShrink: 0, padding: '10px 14px 14px' }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 9,
        padding: '11px 13px', borderRadius: 'var(--r)',
        border: '1px solid var(--border)', background: 'var(--bg2)',
      }}>
        <LockIcon size={14} style={{ color: 'var(--t3)', flexShrink: 0, marginTop: 1 }} />
        <div style={{ lineHeight: 1.6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t2)' }}>
            {t('session.readOnlyTitle').replace('{name}', id || '')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--t3)' }}>{t('session.readOnlyDesc')}</div>
        </div>
      </div>
    </div>
  )
}
