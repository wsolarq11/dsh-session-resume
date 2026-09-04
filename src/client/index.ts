/**
 * @dsh-external/dsh-session-resume — client half.
 *
 * Adds two small native surfaces:
 * - `conversation.session.header.utilities`: copy the current session-log ZIP
 *   download URL to the clipboard.
 * - `conversation.input.dock`: when the draft contains a pasted session-log
 *   URL, resolve it through the host API and offer one-click resume (fills a
 *   canonical `@session` mention + instruction and sends it).
 *
 * The client bundle is built by tsdown and generated into `lib/client.js`.
 */
// @ts-nocheck
import * as React from 'react'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import { MAX_REFERENCES } from '../shared/constants.js'
import { findLogUrlMatch, countDistinctLogSessions } from '../shared/session-url.js'

type ClientContext = {
  slots: SlotsService
  effect(fn: () => unknown, label?: string): unknown
}

export const inject = ['slots']

const API = '/session-resume/api'
const INSTRUCTION =
  '请继续这个会话：先阅读上面引用的会话快照，总结已完成的工作、当前状态和剩余任务，然后从断点继续，不要要求用户重复粘贴日志。'

const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  height: '32px',
  padding: '0 10px',
  borderRadius: '6px',
  border: '1px solid var(--theme-border, #3a3f4b)',
  background: 'transparent',
  color: 'var(--theme-text, #e6e6e6)',
  fontSize: '12px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const dockStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
  margin: '0 0 6px',
  padding: '6px 10px',
  borderRadius: '6px',
  background: 'var(--theme-surface, #181b22)',
  border: '1px solid var(--theme-border, #33363d)',
  fontSize: '12px',
}

function copyText(text) {
  const nav = globalThis.navigator
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    return nav.clipboard.writeText(text).catch(() => legacyCopy(text))
  }
  return Promise.resolve(legacyCopy(text))
}

function legacyCopy(text) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  textarea.remove()
  return ok
}

function useTransient(state, setState, duration = 1800) {
  React.useEffect(() => {
    if (state === 'idle') return
    const timer = globalThis.setTimeout(() => setState('idle'), duration)
    return () => globalThis.clearTimeout(timer)
  }, [state, duration, setState])
}

function CopyResumeButton(props) {
  const [state, setState] = React.useState('idle')
  useTransient(state, setState)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  if (!sessionId) return null

  const onClick = async () => {
    try {
      const response = await fetch(API + '/copy?sessionId=' + encodeURIComponent(sessionId))
      const data = await response.json()
      if (!data || data.ok !== true) throw new Error(data?.error ?? '复制失败')
      const origin =
        globalThis.location?.origin && globalThis.location.origin !== 'null'
          ? globalThis.location.origin
          : 'http://dsh.internal'
      await copyText(new URL(data.downloadPath, origin).href)
      setState('copied')
    } catch (error) {
      console.error('[session-resume] copy failed', error)
      setState('error')
    }
  }

  const label = state === 'copied' ? '已复制' : state === 'error' ? '复制失败' : '复制日志链接'
  return React.createElement(
    'button',
    {
      type: 'button',
      style: { ...buttonStyle, opacity: state === 'idle' ? 1 : 0.65 },
      onClick,
      disabled: state !== 'idle',
      title: '复制当前 Session 日志下载地址，在新会话粘贴即可续跑',
    },
    label,
  )
}

function resumeText(info) {
  return info.mention + ' ' + INSTRUCTION
}

function fillAndSend(props, draft, hit, info, send) {
  const next = draft.slice(0, hit.start) + resumeText(info) + draft.slice(hit.end)
  const actions = props.inputActions
  if (!actions || typeof actions.setDraft !== 'function') return
  actions.setDraft(next)
  if (send && typeof actions.submit === 'function') actions.submit()
}

function ResumeDock(props) {
  const draft = typeof props.input?.draft === 'string' ? props.input.draft : ''
  const hit = findLogUrlMatch(draft)
  const distinctCount = countDistinctLogSessions(draft)
  const tooMany = distinctCount > MAX_REFERENCES
  const hitKey = hit ? `${hit.start}:${hit.end}:${hit.id}` : ''
  const [status, setStatus] = React.useState('idle')
  const [info, setInfo] = React.useState(null)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (!hit) {
      setStatus('idle')
      setInfo(null)
      setError('')
      return
    }
    if (tooMany) {
      setStatus('error')
      setInfo(null)
      setError(`最多支持 ${MAX_REFERENCES} 个不同会话，当前 ${distinctCount} 个`)
      return
    }
    let alive = true
    setStatus('loading')
    fetch(API + '/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: draft }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (!alive) return
        if (!data || data.ok !== true) {
          setStatus('error')
          setError(data?.error ?? '无法识别该会话日志链接')
          setInfo(null)
        } else {
          setStatus('ready')
          setInfo(data)
          setError('')
        }
      })
      .catch(() => {
        if (alive) {
          setStatus('error')
          setError('解析失败')
          setInfo(null)
        }
      })
    return () => {
      alive = false
    }
    // Resolve again only when the URL span or reference-count guard changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitKey, tooMany, distinctCount])

  if (!hit) return null

  const selfSession = props.sessionId === info?.sessionId
  const children = [
    React.createElement(
      'span',
      { style: { color: 'var(--theme-text-secondary, #9aa2ad)' } },
      '检测到 Session 日志链接',
    ),
  ]

  if (tooMany) {
    children.push(
      React.createElement(
        'span',
        { style: { color: '#e5534b' } },
        `最多支持 ${MAX_REFERENCES} 个不同会话，当前 ${distinctCount} 个`,
      ),
    )
  } else if (status === 'loading') {
    children.push(React.createElement('span', { style: { color: '#9aa2ad' } }, '解析中…'))
  } else if (status === 'error') {
    children.push(React.createElement('span', { style: { color: '#e5534b' } }, error))
  } else if (status === 'ready' && info) {
    children.push(
      React.createElement(
        'span',
        {
          style: {
            maxWidth: 'min(42vw, 320px)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--theme-text, #e6e6e6)',
          },
          title: info.label,
        },
        selfSession ? `${info.label}（当前会话）` : info.label,
      ),
    )
    if (!selfSession) {
      children.push(
        React.createElement(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, height: '28px', color: '#fff', background: 'var(--theme-accent, #4a9eff)', borderColor: 'transparent' },
            onClick: () => fillAndSend(props, draft, hit, info, true),
          },
          '一键续跑',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, height: '28px' },
            onClick: () => fillAndSend(props, draft, hit, info, false),
          },
          '仅填入',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            style: { ...buttonStyle, height: '28px' },
            onClick: () => copyText(resumeText(info)),
          },
          '复制续跑指令',
        ),
      )
    }
  }

  return React.createElement('div', { style: dockStyle }, ...children)
}

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'session-resume-copy',
            order: 10,
            label: () => '续跑',
          },
          CopyResumeButton,
        ),
      ),
    'session-resume: header',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'session-resume',
            order: 5,
            label: () => '续跑',
          },
          ResumeDock,
        ),
      ),
    'session-resume: dock',
  )
}
