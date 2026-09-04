/**
 * Input-dock resume UI: recognizes a pasted absolute JSONL path or a legacy
 * `/api/session.export` URL and offers one-click resume.
 *
 * Rules of discipline: `ResumeDock` itself has no hooks. It conditionally
 * renders one of two leaf components (`PathResumeDock` — pure, no hooks;
 * `UrlResumeDock` — calls its hooks unconditionally at the top). Because the
 * leaves are distinct component types, React mounts/unmounts them as units,
 * so the hook count of any mounted instance never changes between renders.
 */

import * as React from 'react'
import { MAX_REFERENCES } from '../shared/constants.js'
import { countDistinctSourceRefs, findFirstSourceRef } from '../shared/source-ref.js'
import { buildResumePromptWithInstruction } from './resume-client.js'
import { copyText } from './resume-executor.js'
import type { ResumeOrderUiState } from './resume-executor.js'
import {
  dockStyle,
  accentButtonStyle,
  smallButtonStyle,
  secondaryTextStyle,
  errorTextStyle,
  ellipsisStyle,
  useTransient,
  fillPathAndSend,
  ResumeActionBar,
  referenceLimitLabel,
  type PathDockProps,
  type UrlDockProps,
} from './dock-ui.js'
import type { ClientContext, DockProps, ResolvedLogUrl } from './types.js'

const API = '/session-resume/api'

/** Path dock: pure presentational, no hooks. */
function PathResumeDock({ props, draft, hit }: PathDockProps): React.ReactElement {
  const distinctCount = countDistinctSourceRefs(draft)
  const tooMany = distinctCount > MAX_REFERENCES
  const children: React.ReactNode[] = [
    React.createElement('span', { style: secondaryTextStyle }, '检测到会话日志路径'),
  ]

  if (tooMany) {
    children.push(
      React.createElement('span', { style: errorTextStyle }, referenceLimitLabel('path', distinctCount)),
    )
  } else {
    children.push(
      React.createElement('span', { style: ellipsisStyle, title: hit.path }, hit.path),
      React.createElement(
        'button',
        { type: 'button', style: accentButtonStyle, onClick: () => fillPathAndSend(props, draft, hit, true) },
        '一键续跑',
      ),
      React.createElement(
        'button',
        { type: 'button', style: smallButtonStyle, onClick: () => fillPathAndSend(props, draft, hit, false) },
        '仅填入',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          style: smallButtonStyle,
          onClick: async () => {
            copyText(await buildResumePromptWithInstruction(hit.path))
          },
        },
        '复制续跑指令',
      ),
    )
  }

  return React.createElement('div', { style: dockStyle }, ...children)
}

/** URL dock: resolves the legacy export URL via the Host API. Hooks are unconditional. */
function UrlResumeDock({ ctx, props, draft, urlHit }: UrlDockProps): React.ReactElement {
  const distinctCount = countDistinctSourceRefs(draft)
  const tooMany = distinctCount > MAX_REFERENCES
  const hitKey = `${urlHit.start}:${urlHit.end}:${urlHit.id}`
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [info, setInfo] = React.useState<ResolvedLogUrl | null>(null)
  const [error, setError] = React.useState('')
  const [orderState, setOrderState] = React.useState<ResumeOrderUiState>('idle')
  useTransient(orderState, setOrderState)

  React.useEffect(() => {
    if (tooMany) {
      setStatus('error')
      setInfo(null)
      setError(referenceLimitLabel('session', distinctCount))
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
        const record = data as {
          ok?: boolean
          error?: string
          sessionId?: string
          label?: string
          mention?: string
        }
        if (!record || record.ok !== true) {
          setStatus('error')
          setError(record.error ?? '无法解析该会话日志链接')
          setInfo(null)
        } else {
          setStatus('ready')
          setInfo({
            sessionId: String(record.sessionId ?? ''),
            label: String(record.label ?? ''),
            mention: String(record.mention ?? ''),
          })
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

  const selfSession = props.sessionId === info?.sessionId
  const children: React.ReactNode[] = [
    React.createElement('span', { style: secondaryTextStyle }, '检测到 Session 日志链接'),
  ]

  if (tooMany) {
    children.push(
      React.createElement('span', { style: errorTextStyle }, referenceLimitLabel('session', distinctCount)),
    )
  } else if (status === 'loading') {
    children.push(React.createElement('span', { style: secondaryTextStyle }, '解析中…'))
  } else if (status === 'error') {
    children.push(React.createElement('span', { style: errorTextStyle }, error))
  } else if (status === 'ready' && info) {
    children.push(
      React.createElement(
        'span',
        { style: ellipsisStyle, title: info.label },
        selfSession ? `${info.label}（当前会话）` : info.label,
      ),
    )
    if (!selfSession) {
      children.push(
        React.createElement(ResumeActionBar, {
          ctx,
          props,
          draft,
          urlHit,
          info,
          orderState,
          setOrderState,
        }),
      )
    }
  }

  return React.createElement('div', { style: dockStyle }, ...children)
}

export function ResumeDockFor(ctx: ClientContext) {
  return function ResumeDock(props: DockProps): React.ReactElement | null {
    const draft = typeof props.input?.draft === 'string' ? props.input.draft : ''
    const ref = findFirstSourceRef(draft)

    // ResumeDock has no hooks. The two leaves are distinct component types,
    // so switching between them mounts/unmounts a unit — hook counts stay
    // consistent for every mounted instance.
    if (!ref) return null
    if (ref.kind === 'path') {
      return React.createElement(PathResumeDock, { props, draft, hit: ref })
    }
    return React.createElement(UrlResumeDock, { ctx, props, draft, urlHit: ref })
  }
}
