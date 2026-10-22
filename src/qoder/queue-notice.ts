/**
 * The upstream "this model is not serviceable" answer, parsed and worded.
 *
 * Qoder announces a saturated per-model queue — or a region whose service is
 * off — with a body carrying `code: 10605`, `isQueued`, `serviceAvailable`,
 * `retryAfterSeconds`, `modelKey`, `queueCount`, `queueType` and
 * `subCode: RESOURCE_LIMIT`. That body arrives as HTTP 200, 401 **or** 403, so
 * the status is not the signal; the body is the only place the distinction
 * between "come back shortly" and "your credential died" is visible.
 *
 * The body is also not a flat document. The upstream nests its own JSON inside
 * the `message` field as a **string**, sometimes twice; users pasted this
 * verbatim shape (2026-10-21):
 *
 *     {"code":"403","message":"{\"code\":\"10605\",
 *      \"message\":\"{\\\"isQueued\\\":true,\\\"modelKey\\\":\\\"qfmodel\\\",…}\",
 *      \"subCode\":\"RESOURCE_LIMIT\"}"}
 *
 * A plain `JSON.parse` of that text sees only the outer wrapper, so everything
 * below descends through `message` strings until it reaches the object that
 * actually holds the facts. The wording built here exists because the two
 * misreadings both sent the user the wrong way: coded `AUTH` it sent them to
 * replace a perfectly good token, and coded as a bare `RATE_LIMIT` it said
 * "throttled" while hiding that the model itself is unavailable. The notice
 * therefore states that credentials and quota are not the problem, and never
 * claims a wait this plugin did not actually perform.
 *
 * @module dsh-qoder-plugin/qoder/queue-notice
 */

/** Bound keeping a runaway upstream body from flooding the conversation row. */
const UPSTREAM_MESSAGE_LIMIT = 400

/** How many `message`-in-a-string layers are followed before giving up. */
const MAX_MESSAGE_DEPTH = 6

/**
 * The queue markers Qoder puts in a rejection body.
 *
 * This deliberately mirrors the private `QUEUE_BODY_MARKERS` in `./errors.ts`
 * rather than importing it. `qoderQueueSignal` is the classification path
 * shared with `src/upstream.ts` and the transport, and it must keep reading the
 * bodies exactly as observed even if this newer, richer parser develops a
 * blind spot; a shared constant would let one change move both at once. The
 * two lists stay in step through the tests on either side
 * (`tests/qoder/errors.test.ts`, `tests/qoder/queue-notice.test.ts`).
 */
const QUEUE_MARKERS: readonly RegExp[] = [
  /"code"\s*:\s*"?10605"?/u,
  /"isQueued"\s*:\s*true/u,
  /"queueCount"/u,
  /"serviceAvailable"\s*:\s*false/u,
]

/** A parsed object whose fields are still unvalidated upstream data. */
interface LooseRecord {
  readonly [key: string]: unknown
}

export interface QoderQueueFacts {
  isQueued: boolean
  serviceAvailable: boolean
  modelKey?: string
  queueCount?: number
  queueType?: string
  retryAfterSeconds?: number
  /**
   * How long the upstream expects this request to sit in the queue, in
   * seconds.
   *
   * Deliberately separate from `retryAfterSeconds`: the two disagree in the
   * wild (observed `retryAfterSeconds=30` with `waitTime=86`), and the wait
   * budget must cover the longer one or the caller retries straight back into
   * the same queue.
   */
  waitTime?: number
  subCode?: string
  /** The upstream's own message text, unescaped and bounded. */
  upstreamMessage?: string
}

/**
 * Parse Qoder's queue/unserviceable answer out of a raw response body,
 * whatever HTTP status carried it.
 *
 * Total by contract: any string is a legal input, junk included, and `undefined`
 * means "this body is not that answer" — never an exception thrown into an
 * error path that is already reporting a failure. The returned-facts/undefined
 * boundary is drawn on the same markers the classifier uses, so a rejection
 * that classified as a throttle is never left without an explanation.
 */
export function parseQueueFacts(body: string): QoderQueueFacts | undefined {
  if (typeof body !== 'string' || body.trim() === '') return undefined
  // The boundary is borrowed, not re-derived: the same markers, tested on the
  // same backslash-stripped text `qoderQueueSignal` uses, so exactly the bodies
  // the classifier calls a queue answer get an explanation — and nothing else
  // does. A body whose only queue-ish field is a quoted `"isQueued":"true"`
  // therefore stays unexplained here instead of acquiring a notice that
  // contradicts the classification (that shape classifies as an authorization
  // rejection, and the notice would tell the user the opposite).
  if (!QUEUE_MARKERS.some(marker => marker.test(body.replace(/\\/gu, '')))) return undefined
  return factsFromRecords(collectRecords(body), body) ?? factsFromMarkerText(body)
}

/**
 * Render the user-facing notice for one queue answer.
 *
 * `waited` and `occurrences` are facts, not decoration: the sentence claiming a
 * wait appears only when the plugin really waited out the upstream's window,
 * and the risk-control possibility is mentioned only when the same answer has
 * recurred (a single saturated queue is an ordinary busy minute, while the
 * same answer coming back repeatedly is what suggests the account is being
 * throttled upstream).
 */
export function formatQueueNotice(
  facts: QoderQueueFacts,
  options: { waited: boolean; occurrences: number },
): string {
  const seconds = facts.retryAfterSeconds
  // The upstream distinguishes "the service is off" from "your request is
  // queued"; the wording must not upgrade the milder one into an outage.
  const state = facts.serviceAvailable === false
    ? '模型暂不可服务'
    : facts.isQueued
      ? '模型排队中'
      : '模型暂不可服务'
  const head = seconds === undefined
    ? `上游模型排队中（${state}，上游未给出建议重试时间）`
    : `上游模型排队中（${state}，上游建议 ${seconds} 秒后重试）`
  const wait = options.waited
    ? seconds === undefined
      ? '已按上游建议等待后仍不可服务'
      : `已按上游建议等待 ${seconds} 秒仍不可服务`
    : '本次未按上游建议等待即返回此结果'
  const risk = options.occurrences > 1
    ? '，如果频繁返回此结果可能代表当前账号已被风控'
    : ''
  // Re-bound here as well as at parse time: a hand-built facts object (or one
  // carried across a boundary) must not be able to flood the row either.
  const quoted = facts.upstreamMessage === undefined
    ? undefined
    : boundMessage(facts.upstreamMessage)
  const source = quoted === undefined ? '' : `（上游原文：${quoted}）`
  return `${head}：这不是登录态或额度问题，${wait}${risk}${source}`
}

/** The wait about to start, as reported by the transport's `onQueueWait`. */
export interface QoderQueueWaitProgress {
  /** How long this wait will last, in milliseconds. */
  waitMs: number
  /** 1-based index of this wait within the request's budget. */
  attempt: number
  /** Waits left after this one; 0 means this is the last one. */
  remaining: number
}

/**
 * Render the visible "we are actually waiting now" row.
 *
 * The final-failure notice ({@link formatQueueNotice}) could only ever appear
 * AFTER a request gave up, so a request that waited out one or two advise
 * windows looked indistinguishable from a hang: the user watched an empty
 * conversation for 30–90 seconds and read the queue explanation only when
 * nothing was left to do. This row is printed when the wait STARTS, once per
 * wait, and the attempt number makes consecutive rows textually different —
 * the host's per-turn de-duplication (it suppresses identical notices) must not
 * collapse the second wait into the first, or a two-wait retry would again look
 * frozen after the first line.
 */
export function formatQueueWaitNotice(facts: QoderQueueFacts, wait: QoderQueueWaitProgress): string {
  const seconds = Math.max(1, Math.round(wait.waitMs / 1000))
  const left = wait.remaining > 0
    ? `，本次请求还可再等 ${wait.remaining} 次`
    : '，这是本次请求的最后一次等待'
  const queue = facts.queueCount === undefined ? '' : `（当前排队约 ${facts.queueCount} 个请求）`
  const quoted = facts.upstreamMessage === undefined
    ? undefined
    : boundMessage(facts.upstreamMessage)
  const source = quoted === undefined ? '' : `（上游原文：${quoted}）`
  return `上游模型排队中：正在等待约 ${seconds} 秒后重试（第 ${wait.attempt} 次等待${left}）${queue}。这不是登录态或额度问题${source}`
}

/**
 * Every JSON object reachable from `body`, outermost first.
 *
 * The descent follows `message` strings only, because that is where Qoder
 * wraps each layer. A depth cap and a seen-set keep a self-referential or
 * machine-generated nesting from turning a parse of a hostile body into
 * unbounded work.
 */
function collectRecords(body: string): LooseRecord[] {
  const records: LooseRecord[] = []
  const seen = new Set<string>()
  let pending: { text: string; depth: number }[] = [{ text: body, depth: 0 }]
  while (pending.length > 0) {
    const next: { text: string; depth: number }[] = []
    for (const { text, depth } of pending) {
      if (depth > MAX_MESSAGE_DEPTH || seen.has(text)) continue
      seen.add(text)
      const record = parseObject(text)
      if (record === undefined) continue
      records.push(record)
      const nested = record['message']
      if (typeof nested === 'string' && nested.trim() !== '') {
        next.push({ text: nested, depth: depth + 1 })
      }
    }
    pending = next
  }
  return records
}

/**
 * Tolerate the text around the JSON: an SSE envelope prefixes the payload, and
 * a truncated body has no closing brace at all (then there is simply nothing
 * to parse and the caller falls back to a marker scan).
 */
function parseObject(text: string): LooseRecord | undefined {
  const trimmed = text.trim()
  const direct = tryParseObject(trimmed)
  if (direct !== undefined) return direct
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  return tryParseObject(trimmed.slice(start, end + 1))
}

function tryParseObject(text: string): LooseRecord | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as LooseRecord
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The facts the parsed layers carry, or `undefined` when none of them is a
 * queue answer (an authorization rejection nests the same way, and must not
 * acquire a queue explanation).
 *
 * Values are read innermost-first: that is where the upstream describes the
 * model it is refusing, and an outer wrapper only ever repeats or omits it.
 */
function factsFromRecords(records: readonly LooseRecord[], body: string): QoderQueueFacts | undefined {
  const isQueued = deepestBoolean(records, 'isQueued')
  const serviceAvailable = deepestBoolean(records, 'serviceAvailable')
  const queueCount = deepestNumber(records, 'queueCount')
  const codeIsQueue = records.some(record => readString(record['code']) === '10605')
  if (isQueued !== true && serviceAvailable !== false && queueCount === undefined && !codeIsQueue) {
    return undefined
  }
  const facts: QoderQueueFacts = {
    // Absent flags carry their plain meaning rather than being invented: an
    // upstream that sent only `{"queueCount":8887}` never said the service was
    // off, and one that sent only `{"isQueued":true}` never said it was
    // unavailable.
    isQueued: isQueued ?? false,
    serviceAvailable: serviceAvailable ?? true,
  }
  const modelKey = deepestString(records, 'modelKey')
  if (modelKey !== undefined) facts.modelKey = modelKey
  const queueType = deepestString(records, 'queueType')
  if (queueType !== undefined) facts.queueType = queueType
  const subCode = deepestString(records, 'subCode')
  if (subCode !== undefined) facts.subCode = subCode
  if (queueCount !== undefined) facts.queueCount = queueCount
  const retryAfterSeconds = deepestNumber(records, 'retryAfterSeconds')
  if (retryAfterSeconds !== undefined) facts.retryAfterSeconds = retryAfterSeconds
  const waitTime = deepestNumber(records, 'waitTime')
  if (waitTime !== undefined) facts.waitTime = waitTime
  // The innermost `message` IS the upstream's own words: with two nesting
  // layers the middle one holds the JSON facts, and with a human sentence at
  // the bottom this picks the sentence. When no wrapper carried one at all the
  // body itself is the only thing the user could quote back upstream.
  const quoted = deepestMessage(records) ?? body
  const upstreamMessage = boundMessage(quoted)
  if (upstreamMessage !== undefined) facts.upstreamMessage = upstreamMessage
  return facts
}

/**
 * Facts recovered from a body that does not parse at all — a truncated
 * response, or an envelope carrying the markers as loose text.
 *
 * It exists so that a rejection the classifier calls a queue is never left
 * without an explanation; it reads the markers after dropping the JSON string
 * escapes, exactly as `qoderQueueSignal` does.
 */
function factsFromMarkerText(body: string): QoderQueueFacts | undefined {
  const text = body.replace(/\\/gu, '')
  if (!QUEUE_MARKERS.some(marker => marker.test(text))) return undefined
  const isQueued = /"isQueued"\s*:\s*(true|false)/u.exec(text)?.[1]
  const serviceAvailable = /"serviceAvailable"\s*:\s*(true|false)/u.exec(text)?.[1]
  const facts: QoderQueueFacts = {
    isQueued: isQueued === 'true',
    serviceAvailable: serviceAvailable === undefined ? true : serviceAvailable === 'true',
  }
  const modelKey = /"modelKey"\s*:\s*"([^"]*)"/u.exec(text)?.[1]
  if (modelKey !== undefined && modelKey !== '') facts.modelKey = modelKey
  const queueType = /"queueType"\s*:\s*"([^"]*)"/u.exec(text)?.[1]
  if (queueType !== undefined && queueType !== '') facts.queueType = queueType
  const subCode = /"subCode"\s*:\s*"([^"]*)"/u.exec(text)?.[1]
  if (subCode !== undefined && subCode !== '') facts.subCode = subCode
  const queueCount = readNumber(/"queueCount"\s*:\s*"?(\d+)"?/u.exec(text)?.[1])
  if (queueCount !== undefined) facts.queueCount = queueCount
  const retryAfterSeconds = readNumber(/"retryAfterSeconds"\s*:\s*"?(\d+)"?/u.exec(text)?.[1])
  if (retryAfterSeconds !== undefined) facts.retryAfterSeconds = retryAfterSeconds
  const waitTime = readNumber(/"waitTime"\s*:\s*"?(\d+(?:\.\d+)?)"?/u.exec(text)?.[1])
  if (waitTime !== undefined) facts.waitTime = waitTime
  const upstreamMessage = boundMessage(body)
  if (upstreamMessage !== undefined) facts.upstreamMessage = upstreamMessage
  return facts
}

function deepestBoolean(records: readonly LooseRecord[], key: string): boolean | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]
    if (record === undefined) continue
    const value = readBoolean(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function deepestNumber(records: readonly LooseRecord[], key: string): number | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]
    if (record === undefined) continue
    const value = readNumber(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function deepestString(records: readonly LooseRecord[], key: string): string | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]
    if (record === undefined) continue
    const value = readString(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function deepestMessage(records: readonly LooseRecord[]): string | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]
    if (record === undefined) continue
    const value = record['message']
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** Quoted numbers are accepted: the upstream does not promise JSON types. */
function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value)
  return undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * One readable line of upstream text.
 *
 * Whichever quoting layer it came from, the text ends up inside a single-line
 * conversation row, so runs of whitespace collapse and the result is cut at
 * {@link UPSTREAM_MESSAGE_LIMIT} with an ellipsis marking the cut.
 */
function boundMessage(text: string): string | undefined {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed === '') return undefined
  return collapsed.length > UPSTREAM_MESSAGE_LIMIT
    ? `${collapsed.slice(0, UPSTREAM_MESSAGE_LIMIT)}…`
    : collapsed
}