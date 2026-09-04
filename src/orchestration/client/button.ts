/**
 * Header "自动续跑" button: resolves the Host plan and drives the shared
 * resume order. All hooks are called unconditionally at the top of the
 * component (no conditional early returns before hooks).
 */

import * as React from 'react'
import { runResumeOrder } from './order.js'
import type { ResumeOrderUiState } from './resume-executor.js'
import { buttonStyle, orderLabel, runResumeOrderWithUi, useTransient } from './dock-ui.js'
import type { ClientContext, HeaderButtonProps } from './types.js'

export function AutoResumeButtonFor(ctx: ClientContext) {
  return function AutoResumeButton(props: HeaderButtonProps) {
    const [state, setState] = React.useState<ResumeOrderUiState>('idle')
    useTransient(state, setState)
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''

    const onClick = () => {
      if (!sessionId) return
      runResumeOrderWithUi(
        () => runResumeOrder(ctx, sessionId, setState),
        setState,
        '[session-resume] auto resume failed',
      )
    }

    return React.createElement(
      'button',
      {
        type: 'button',
        style: { ...buttonStyle, opacity: state === 'idle' ? 1 : 0.65 },
        onClick,
        disabled: state !== 'idle',
        title: '由 Host 锁定原工作区，创建新会话并自动续跑',
      },
      orderLabel(state, '自动续跑'),
    )
  }
}
