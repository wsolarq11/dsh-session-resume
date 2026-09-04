/**
 * @dsh-external/dsh-session-resume — client half.
 *
 * Registers two slot occupants:
 * - `conversation.session.header.utilities`: the "自动续跑" button.
 * - `conversation.input.dock`: the pasted-path/URL recognition dock.
 *
 * The client bundle is built by tsdown and generated into `lib/client.js`.
 */

import { AutoResumeButtonFor } from './button.js'
import { ResumeDockFor } from './dock.js'
import type { ClientContext } from './types.js'

export const inject = ['slots', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'session-resume-copy',
          order: 10,
          label: () => '续跑',
        }, AutoResumeButtonFor(ctx)),
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
        }, ResumeDockFor(ctx)),
      ),
    'session-resume: dock',
  )
}