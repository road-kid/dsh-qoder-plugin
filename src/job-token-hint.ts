/**
 * The conversation hint row for a self-healed job token.
 *
 * The card's status notice proved hard to observe, so the visible channel is
 * the session itself. The harness records a command line as a pair of
 * **log-only** session events — `command/run` + `command/done`, the mechanism
 * behind the `[icon] new · 已开启新会话。` row (and the same icon a pwsh tool
 * row uses). Appending that pair directly prints one line into the
 * conversation: no turn is opened, no model round trip happens, and **nothing
 * is registered** — so no synthetic command ever appears in the `/` menu:
 *
 *     [icon] qoder · jobToken 已自动刷新（旧令牌被上游拒绝，已自动重换并恢复）
 *
 * and its failure mirror, printed when the heal ran and still lost:
 *
 *     [icon] qoder · jobToken 已重换但仍被上游拒绝（自愈未恢复，该请求已失败）
 *
 * The mirror used to point the reader at "the error above", which assumed the
 * failed heal belonged to a chat rendering a card in this conversation. A heal
 * inside the session-title request shares the transport and the notice state
 * but renders no card, so the pointer led nowhere. It now states only the
 * facts. Attribution stays best effort (`lastRunningAgent`): with two agents
 * running concurrently the row can land in the other one's conversation, which
 * is a display imprecision, never a wrong heal.
 *
 * The host half alone produces these rows; without a client renderer the title
 * is the recorded name, which is why it is the ASCII `qoder`.
 *
 * @module dsh-qoder-plugin/job-token-hint
 */

import type { Context } from '@deepseek-ai/cordis'

/** The name recorded on the hint row (and therefore its displayed title). */
export const JOB_TOKEN_HINT_NAME = 'qoder'

/** The session slice this module appends to. */
interface HintSession {
  append(type: string, data: unknown): unknown
}

/** The agent slice this module needs: identity plus its session. */
interface HintAgent {
  readonly id: unknown
  readonly session?: HintSession
}

/** Refresh time per agent id, so a later read can name when it happened. */
const lastRefreshAt = new Map<string, number>()

/** The most recent agent observed entering a running turn. */
let lastRunningAgent: HintAgent | undefined

/** Monotonic suffix keeping appended ids unique within this process. */
let hintSeq = 0

/** Monotonic mark for the latest observed turn, and the turn each agent is in. */
let turnSeq = 0
const turnByAgent = new Map<string, number>()

/**
 * The last upstream notice printed, per agent, with the turn it was printed in.
 *
 * The host retries a RATE_LIMIT several times inside one turn and the queue
 * answer is identical on every attempt, so without this the conversation would
 * collect the same row once per retry.
 */
const lastNoticeByAgent = new Map<string, { turn: number; text: string }>()

/**
 * Start tracking which agent is running.
 *
 * `agent/status` is a plain `emit` event: a listener that returns nothing
 * cannot disturb the emitting path (unlike a waterfall event, where a listener
 * owes the chain its `next()` call). The self-heal fires inside that agent's
 * request, so the most recently running agent is the conversation to print
 * into.
 *
 * The same event also advances the turn mark the upstream-notice guard is
 * scoped to: a `running` status is what opens a turn, so the identical notice
 * is suppressed inside one and allowed again in the next — which is exactly the
 * recurrence the notice wording reports as a risk-control signal.
 */
export function installJobTokenHint(ctx: Context): void {
  ctx.on('agent/status' as never, ((payload: { agent?: HintAgent, status?: string }) => {
    if (payload.status === 'running' && payload.agent !== undefined) {
      lastRunningAgent = payload.agent
      turnSeq += 1
      turnByAgent.set(String(payload.agent.id), turnSeq)
    }
  }) as never)
}

/**
 * Print the refresh row into the conversation whose request triggered it.
 *
 * Best effort by design: a missing agent, an absent session, or a projection
 * that rejects the append must never affect the chat that just recovered.
 *
 * @param at - When the job token was rotated.
 * @param text - The row's summary line.
 */
export function emitJobTokenHint(at: number, text: string): void {
  const agent = lastRunningAgent
  if (agent?.session === undefined) return
  lastRefreshAt.set(String(agent.id), at)
  appendHintRow(agent, 'success', text)
}

/**
 * Print the failed-heal row into the conversation whose request triggered it.
 *
 * The mirror of {@link emitJobTokenHint}: the self-heal ran, exchanged a fresh
 * job token, retried, and the upstream still refused. Without this row that
 * outcome was silent — the user saw only the resulting authorization failure
 * and could not tell that recovery had already been attempted and lost.
 *
 * Rate limited by the transport (once per unresolved outage), not here: this
 * module stays a pure printer so the dedupe policy lives with the state that
 * knows when an outage ends.
 *
 * @param at - When the failed heal was recorded.
 * @param text - The row's summary line.
 */
export function emitJobTokenRefreshFailedHint(at: number, text: string): void {
  const agent = lastRunningAgent
  if (agent?.session === undefined) return
  appendHintRow(agent, 'error', text)
}

/**
 * Print one upstream "model not serviceable" notice into the running agent's
 * conversation.
 *
 * The same best-effort printer as the job-token rows. The request it describes
 * has already been answered with the upstream's own queue/unserviceable body,
 * so a missing agent session must never turn a diagnostics line into a second
 * failure: no agent, no row, and the chat keeps whatever outcome it had.
 *
 * Guarded per turn. The host retries a `RATE_LIMIT` several times inside one
 * turn and the upstream's queue answer is byte-identical on each attempt, so
 * without the guard the conversation would stack one identical row per retry.
 * Identical text is the key, not "any notice": a turn that first reports the
 * queue without waiting and later reports the waited-out retry has two
 * different facts to tell and prints both. The turn mark advances on every
 * `agent/status` `running`, so the same notice may legitimately surface again
 * in a later turn — and that recurrence is what the wording reports as a
 * possible risk-control signal.
 *
 * @param text - The rendered notice line (see `formatQueueNotice`).
 */
export function emitUpstreamNotice(text: string): void {
  const agent = lastRunningAgent
  if (agent?.session === undefined || text === '') return
  const id = String(agent.id)
  const turn = turnByAgent.get(id) ?? 0
  const printed = lastNoticeByAgent.get(id)
  if (printed !== undefined && printed.turn === turn && printed.text === text) return
  // Recorded before the append, which swallows its own failures: a row that
  // could not be written must not be retried by a later identical attempt in
  // the same turn.
  lastNoticeByAgent.set(id, { turn, text })
  appendHintRow(agent, 'error', text)
}

/** Append one log-only command pair carrying `text` as its outcome. */
function appendHintRow(agent: HintAgent, kind: 'success' | 'error', text: string): void {
  const session = agent.session
  if (session === undefined) return
  const commandId = `cmd-qoder-hint-${Date.now().toString(36)}-${++hintSeq}`
  try {
    // The official pairing: `command/run` opens the row, `command/done` carries
    // its summary. Both are log-only events, so no turn is opened and no
    // model-facing state changes. `error` renders the row as a failure, which
    // is what an exhausted heal is.
    session.append('command/run', {
      commandId,
      name: JOB_TOKEN_HINT_NAME,
      source: { kind: 'user' },
    })
    session.append('command/done', {
      commandId,
      kind,
      text,
    })
  } catch {
    // The row reports a heal that already happened (or already failed); failing
    // to print it is diagnostics-grade and must never surface as a chat failure.
  }
}

/** The refresh time recorded for one agent, if this process rotated its token. */
export function jobTokenRefreshAt(agentId: unknown): number | undefined {
  return lastRefreshAt.get(String(agentId))
}
