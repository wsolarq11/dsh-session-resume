/** Shared UI building blocks for the resume dock (styles, transient state, order labels, action bar). */

import * as React from 'react'
import { MAX_REFERENCES } from '../../pure/text/constants.js'
import { buildResumePromptWithInstruction } from './resume-client.js'
import {
  countDistinctSessionRefs,
  findSourceRefs,
  type SourcePathRef,
  type SourceSessionRef,
} from '../../pure/refs/source-ref.js'
import { copyText } from './resume-executor.js'
import { runResumeOrder } from './order.js'
import { runResumeBatchOrder } from './batch.js'
import type { ResumeOrderUiState } from './resume-executor.js'
import type { ClientContext, DockProps, ResolvedLogUrl } from './types.js'

export const dockStyle: React.CSSProperties = {
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

export const buttonStyle: React.CSSProperties = {
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

export const accentButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  height: '28px',
  color: '#fff',
  background: 'var(--theme-accent, #4a9eff)',
  borderColor: 'transparent',
}

export const smallButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  height: '28px',
}

export const secondaryTextStyle: React.CSSProperties = {
  color: 'var(--theme-text-secondary, #9aa2ad)',
}

export const errorTextStyle: React.CSSProperties = {
  color: '#e5534b',
}

export const ellipsisStyle: React.CSSProperties = {
  maxWidth: 'min(42vw, 320px)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--theme-text, #e6e6e6)',
}

/** Reset a transient UI state to idle after a short delay. */
export function useTransient<TState extends string>(
  state: TState,
  setState: React.Dispatch<React.SetStateAction<TState>>,
  duration = 1800,
): void {
  React.useEffect(() => {
    if (state === 'idle') return
    const timer = globalThis.setTimeout(() => setState('idle' as TState), duration)
    return () => globalThis.clearTimeout(timer)
  }, [state, duration, setState])
}

/** Human label for a resume order stage state. */
export function orderLabel(state: ResumeOrderUiState, idleLabel = '一键续跑'): string {
  switch (state) {
    case 'resolving':
      return '读取路径…'
    case 'creating':
      return '创建会话…'
    case 'sending':
      return '发送续跑…'
    case 'done':
      return '已续跑'
    case 'error':
      return '续跑失败'
    default:
      return idleLabel
  }
}

/** Replace a draft span with the resume text and optionally submit. */
export function replaceDraft(
  props: DockProps,
  draft: string,
  start: number,
  end: number,
  text: string,
  send: boolean,
): void {
  const next = draft.slice(0, start) + text + draft.slice(end)
  const actions = props.inputActions
  if (!actions || typeof actions.setDraft !== 'function') return
  actions.setDraft(next)
  if (send && typeof actions.submit === 'function') actions.submit()
}

export async function fillPathAndSend(props: DockProps, draft: string, hit: SourcePathRef, send: boolean): Promise<void> {
  replaceDraft(props, draft, hit.start, hit.end, await buildResumePromptWithInstruction(hit.path), send)
}

export async function fillMentionAndSend(
  props: DockProps,
  draft: string,
  hit: SourceSessionRef,
  info: ResolvedLogUrl,
  send: boolean,
): Promise<void> {
  replaceDraft(props, draft, hit.start, hit.end, await buildResumePromptWithInstruction(info.mention), send)
}

export interface PathDockProps {
  props: DockProps
  draft: string
  hit: SourcePathRef
}

export interface UrlDockProps {
  ctx: ClientContext
  props: DockProps
  draft: string
  urlHit: SourceSessionRef
}

/** Run a single or batch order and map the terminal outcome to shared UI state. */
export function runResumeOrderWithUi(
  run: () => Promise<unknown>,
  onState: (next: 'done' | 'error') => void,
  errorLabel: string,
): void {
  run()
    .then(() => onState('done'))
    .catch((runError) => {
      console.error(errorLabel, runError)
      onState('error')
    })
}

/** The one-click/fill/copy action cluster for a resolved source. */
export function ResumeActionBar(props: {
  ctx: ClientContext
  props: DockProps
  draft: string
  urlHit: SourceSessionRef
  info: ResolvedLogUrl
  orderState: ResumeOrderUiState
  setOrderState: (next: ResumeOrderUiState) => void
}): React.ReactElement {
  const { ctx, props: dockProps, draft, urlHit, info, orderState, setOrderState } = props
  const distinctCount = countDistinctSessionRefs(draft)
  const runSingle = () =>
    runResumeOrderWithUi(
      () => runResumeOrder(ctx, info.sessionId, setOrderState),
      setOrderState,
      '[session-resume] dock resume failed',
    )
  const children: React.ReactNode[] = [
    React.createElement(
      'button',
      {
        type: 'button',
        style: { ...accentButtonStyle, opacity: orderState === 'idle' ? 1 : 0.65 },
        disabled: orderState !== 'idle',
        onClick: runSingle,
      },
      orderLabel(orderState),
    ),
    React.createElement(
      'button',
      {
        type: 'button',
        style: smallButtonStyle,
        onClick: () => fillMentionAndSend(dockProps, draft, urlHit, info, false),
      },
      '仅填入',
    ),
    React.createElement(
      'button',
      {
        type: 'button',
        style: smallButtonStyle,
        onClick: async () => {
          copyText(await buildResumePromptWithInstruction(info.mention))
        },
      },
      '复制续跑指令',
    ),
  ]
  if (distinctCount > 1) {
    const allIds = [...new Set(findSourceRefs(draft).filter((ref) => ref.kind === 'session').map((ref) => ref.sourceId))]
    children.push(
      React.createElement(
        'button',
        {
          type: 'button',
          style: { ...accentButtonStyle, opacity: orderState === 'idle' ? 1 : 0.65 },
          disabled: orderState !== 'idle',
          onClick: () =>
            runResumeOrderWithUi(
              () => runResumeBatchOrder(ctx, allIds),
              setOrderState,
              '[session-resume] dock batch resume failed',
            ),
        },
        `批量续跑 ${allIds.length} 个`,
      ),
    )
  }
  return React.createElement(React.Fragment, null, ...children)
}

/** Reference count guard reused by path and URL docks. */
export function referenceLimitLabel(kind: 'path' | 'session', count: number): string {
  const max = MAX_REFERENCES
  return kind === 'path'
    ? `最多支持 ${max} 个不同路径，当前 ${count} 个`
    : `最多支持 ${max} 个不同会话，当前 ${count} 个`
}
