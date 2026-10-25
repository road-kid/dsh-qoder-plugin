/**
 * The queue-notice row in the conversation flow.
 *
 * The plugin reports upstream queue waits as log-only command rows named
 * `qoder` (see `src/job-token-hint.ts`). The host's generic command card puts
 * the finished text in a single-line summary span —
 * `text-overflow: ellipsis; white-space: nowrap; overflow: hidden` — so the
 * tail of the notice is cut off exactly where the queue length and the retry
 * count live. This renderer takes over the `qoder` key of
 * `conversation.chat.commandview` and prints the same sentence with normal
 * wrapping, so the whole notice stays readable.
 *
 * The row keeps the generic card's anatomy (an icon-less title line, a caption
 * tone, hairline padding) so it reads as one of the host's own rows rather
 * than a foreign banner. No expand affordance: the full text is already the
 * point, and a queue notice is one sentence, not a payload.
 */
import type { ReactNode } from 'react'
import type { CommandRowOwnerProps } from './quota-slots.ts'

export function QoderQueueNoticeRow({ node }: CommandRowOwnerProps): ReactNode {
  const text = node.outcome?.text ?? ''
  if (text === '') return null
  // The host's generic row colours an `error` outcome with the state colour and
  // an `ok`/`success` one with the caption tone; the notice's meaning rides on
  // that same distinction, so the renderer keeps it.
  const kind = node.outcome?.kind
  const tone = kind === 'error' ? ' qdp-noticeRowError' : ''
  return (
    <div className={`qdp-noticeRow${tone}`} data-notice-command={node.name ?? 'qoder'}>
      <span className="qdp-noticeRowName">{node.name ?? 'qoder'}</span>
      <span className="qdp-noticeRowDot">·</span>
      <span className="qdp-noticeRowText">{text}</span>
    </div>
  )
}
