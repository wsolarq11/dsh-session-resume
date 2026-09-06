/**
 * Header "复制日志地址" button: copies the official session-log export URL of
 * the current session to the clipboard. This is strictly read-only — it never
 * resolves the Host plan, creates/reuses a target session, or sends a resume
 * instruction. All hooks are called unconditionally at the top of the
 * component (no conditional early returns before hooks).
 */

import * as React from 'react'
import { exportPathFromId } from '../../pure/refs/session-url.js'
import { copyText } from './resume-executor.js'
import { buttonStyle, useTransient } from './dock-ui.js'
import type { ClientContext, HeaderButtonProps } from './types.js'

type CopyState = 'idle' | 'copied' | 'error'

const COPY_LABEL: Record<CopyState, string> = {
  idle: '复制日志地址',
  copied: '已复制',
  error: '复制失败',
}

export function CopyLogButtonFor(_ctx: ClientContext) {
  return function CopyLogButton(props: HeaderButtonProps): React.ReactElement {
    const [state, setState] = React.useState<CopyState>('idle')
    useTransient(state, setState)
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''

    const onClick = () => {
      if (!sessionId) return
      const origin =
        typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : ''
      const copied = copyText(origin + exportPathFromId(sessionId))
      void copied.then((done) => setState(done ? 'copied' : 'error'))
    }

    return React.createElement(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, opacity: state === 'idle' ? 1 : 0.65 },
        onClick,
        disabled: sessionId === '' || state !== 'idle',
        title: sessionId
          ? '复制当前会话的官方 session log 导出地址'
          : '当前会话无 sessionId，无法复制',
      },
      COPY_LABEL[state],
    )
  }
}