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
 * facts.
 *
 * Attribution is explicit whenever the request names its conversation: every
 * emitter takes the issuing session id and prints only into THAT conversation.
 * The row used to go to whichever agent most recently looked busy
 * (`lastRunningAgent`), which let one conversation's queue notice land in
 * another's — with two sessions running at once, the wrong log got the row. The
 * remembered agent survives only as the fallback for callers that carry no
 * session id (a direct API request, or a host that composes no session store).
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

/** The session store slice this module reads, structurally. */
interface HintSessions {
  get(id: string): HintSession | undefined
}

/**
 * The conversation a row may be printed into: an appendable session plus the id
 * the per-conversation state (de-duplication, refresh times) is keyed by.
 */
interface HintTarget {
  readonly id: string
  readonly session: HintSession
}

/** The context captured at install time, for its session store. */
let installed: { sessions?: HintSessions } | undefined

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
 * Start tracking which agent is running, and keep the session store reachable.
 *
 * `agent/status` is a plain `emit` event: a listener that returns nothing
 * cannot disturb the emitting path (unlike a waterfall event, where a listener
 * owes the chain its `next()` call). It is no longer the PRIMARY way to pick a
 * conversation — the request's own session id is — but it still supplies the
 * fallback target for callers that carry no id, and it advances the turn mark
 * the upstream-notice guard is scoped to.
 *
 * The turn mark matters because a `running` status is what opens a turn: the
 * identical notice is suppressed inside one and allowed again in the next, which
 * is exactly the recurrence the notice wording reports as a risk-control signal.
 */
export function installJobTokenHint(ctx: Context): void {
  // Read the store structurally rather than through its service types: this
  // module must keep working on a host that composes no session store at all
  // (and on the bare contexts the tests build), where it is simply absent.
  installed = ctx as unknown as { sessions?: HintSessions }
  ctx.on('agent/status' as never, ((payload: { agent?: HintAgent, status?: string }) => {
    if (payload.status === 'running' && payload.agent !== undefined) {
      lastRunningAgent = payload.agent
      turnSeq += 1
      turnByAgent.set(String(payload.agent.id), turnSeq)
    }
  }) as never)
}

/**
 * Resolve the conversation a row belongs to.
 *
 * The id is the issuing request's own session id, which the transport carries
 * because requests run concurrently and no remembered "current agent" can say
 * which conversation a given queue answer or heal belongs to. With an id the
 * rule is strict:
 *
 * - the session store's own object for that id wins — it is the live log the
 *   client is reading, and it also works for a conversation that is idle right
 *   now (a session-title or compaction request belongs to its own conversation,
 *   not to whoever started most recently);
 * - otherwise the remembered agent, but ONLY when it is that same conversation;
 * - otherwise nothing. The row is dropped rather than printed into a
 *   conversation whose request it does not describe: a missing diagnostics line
 *   is a lost detail, a misplaced one is a false statement about someone else's
 *   chat.
 *
 * Without an id there is nothing to be strict about, so the old best-effort
 * target stands: the most recently running agent.
 *
 * @param sessionId - The issuing request's session id, `undefined` when the
 *   request carried none.
 */
function resolveTarget(sessionId: string | undefined): HintTarget | undefined {
  if (sessionId === undefined) {
    const agent = lastRunningAgent
    return agent?.session === undefined ? undefined : { id: String(agent.id), session: agent.session }
  }
  const stored = installed?.sessions?.get(sessionId)
  if (stored !== undefined) return { id: sessionId, session: stored }
  const agent = lastRunningAgent
  if (agent?.session !== undefined && String(agent.id) === sessionId) {
    return { id: sessionId, session: agent.session }
  }
  return undefined
}

/**
 * Print the refresh row into the conversation whose request triggered it.
 *
 * Best effort by design: a missing agent, an absent session, or a projection
 * that rejects the append must never affect the chat that just recovered.
 *
 * @param at - When the job token was rotated.
 * @param text - The row's summary line.
 * @param sessionId - The conversation whose request healed; see
 *   {@link resolveTarget}.
 */
export function emitJobTokenHint(at: number, text: string, sessionId?: string): void {
  const target = resolveTarget(sessionId)
  if (target === undefined) return
  lastRefreshAt.set(target.id, at)
  appendHintRow(target.session, 'success', text)
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
 * @param sessionId - The conversation whose request failed to heal; see
 *   {@link resolveTarget}.
 */
export function emitJobTokenRefreshFailedHint(at: number, text: string, sessionId?: string): void {
  const target = resolveTarget(sessionId)
  if (target === undefined) return
  appendHintRow(target.session, 'error', text)
}

/**
 * Print one upstream "model not serviceable" notice into the conversation whose
 * request produced it.
 *
 * The same best-effort printer as the job-token rows. The request it describes
 * has already been answered with the upstream's own queue/unserviceable body,
 * so a missing agent session must never turn a diagnostics line into a second
 * failure: no target, no row, and the chat keeps whatever outcome it had.
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
 * @param sessionId - The conversation whose request produced this answer; see
 *   {@link resolveTarget}.
 */
export function emitUpstreamNotice(text: string, sessionId?: string): void {
  if (text === '') return
  const target = resolveTarget(sessionId)
  if (target === undefined) return
  const id = target.id
  const turn = turnByAgent.get(id) ?? 0
  const printed = lastNoticeByAgent.get(id)
  if (printed !== undefined && printed.turn === turn && printed.text === text) return
  // Recorded before the append, which swallows its own failures: a row that
  // could not be written must not be retried by a later identical attempt in
  // the same turn.
  lastNoticeByAgent.set(id, { turn, text })
  appendHintRow(target.session, 'error', text)
}

/** Append one log-only command pair carrying `text` as its outcome. */
function appendHintRow(session: HintSession, kind: 'success' | 'error', text: string): void {
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
