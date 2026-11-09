/**
 * Modern DSH conversation node that keeps generated videos outside Tool
 * process folding. On hosts with the `uiConversation` service, a successful
 * `generate_video` result becomes a session-located chat row (kind
 * `dsh-video-result`) anchored at the event that produced it, so the clip
 * stays visible as final output even when the Tool process folds (#65, same
 * mechanism as dsh-image-gen's promoted image rows).
 */

export const VIDEO_RESULT_NODE_KIND = 'dsh-video-result'

export interface VideoResultPresentation {
  readonly jobId: string
  readonly status: string
  readonly prompt: string
  readonly model?: string
  readonly seconds?: number
  readonly size?: string
  readonly seed?: number
  /** Epoch milliseconds, when the event carried one. */
  readonly createdAt?: number
  readonly savedTo?: string
}

interface VideoResultState {
  /** Owning conversation turn; PTC (run_code) sub-call results carry no turn. */
  readonly turn?: number
  readonly results: readonly (VideoResultPresentation & { readonly seq: number })[]
}

interface EventLike {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

interface MatchLike {
  readonly event: EventLike
  readonly location: unknown
}

interface ContextLike<State> {
  readonly key: string
  readonly id: string
  readonly matches: readonly MatchLike[]
  readonly start?: MatchLike
  readonly state?: State
}

interface ConversationNodeDefinitionLike<State> {
  readonly kind: string
  readonly target: 'chat'
  match(event: EventLike): { id: string; role: 'start' | 'update' } | null
  start(context: ContextLike<State>, match: MatchLike, reader: unknown): State
  update(context: ContextLike<State> & { readonly state: State }, match: MatchLike): State
  buildViewNode(context: ContextLike<State>): Record<string, unknown> | null
}

export const videoResultDefinition: ConversationNodeDefinitionLike<VideoResultState> =
  createVideoResultDefinition()

/**
 * Give each generate_video Tool result its own Chat row at the event that
 * produced it. In-flight results (queued/in_progress) match too: the row
 * polls the job and rippled-reveals the clip when it lands. PTC (run_code)
 * sub-calls already have their own stable sub-call identity.
 */
export function createVideoResultDefinition(): ConversationNodeDefinitionLike<VideoResultState> {
  return {
    kind: VIDEO_RESULT_NODE_KIND,
    target: 'chat',
    match: (event) => {
      // PTC (run_code) sub-calls carry neither a turn nor presentationMeta.
      // A successful dispatch of the generate tool becomes its own node keyed
      // by the sub-call.
      if (event.type === 'tool/ptc-dispatch') {
        const subCallId = event.data.subCallId
        if (typeof subCallId !== 'string' || subCallId === '') return null
        return videoResultsFromPtcDispatch(event).length === 0
          ? null
          : { id: `ptc:${subCallId}`, role: 'start' }
      }
      if (event.type === 'tool/result'
        && videoResultsFromMeta(event.data.meta).length > 0) {
        return { id: `result:${event.seq}`, role: 'start' }
      }
      return null
    },
    start: (_context, match) => {
      if (match.event.type === 'tool/ptc-dispatch') {
        const results = videoResultsFromPtcDispatch(match.event)
        if (results.length === 0) throw new Error('dsh-video-result start requires a plugin video dispatch')
        return { results: results.map(result => ({ ...result, seq: match.event.seq })) }
      }
      const results = match.event.type === 'tool/result'
        ? videoResultsFromMeta(match.event.data.meta)
        : []
      if (results.length === 0) {
        throw new Error('dsh-video-result start requires a video Tool result')
      }
      // A live Tool result can arrive before the harness stamps its turn onto
      // the event data; the row still belongs at that seq, so the turn is
      // optional here (a later re-read carries it and the key never changes).
      const turn = eventTurn(match.event)
      return {
        ...(turn === undefined ? {} : { turn }),
        results: results.map(result => ({ ...result, seq: match.event.seq })),
      }
    },
    update: (context, match) => {
      if (match.event.type !== 'tool/ptc-dispatch') return context.state
      // Defensive merge: a re-dispatch of the same sub-call must not duplicate.
      return videoResultsFromPtcDispatch(match.event).reduce(
        (state, result) => appendResult(state, result, match.event.seq), context.state,
      )
    },
    buildViewNode: (context) => {
      const state = context.state
      const first = state?.results[0]
      if (state === undefined || first === undefined) return null
      return {
        key: context.key,
        kind: VIDEO_RESULT_NODE_KIND,
        id: context.id,
        target: 'chat',
        // Keep the result at the event that produced it, even after the Turn
        // ends or later videos arrive in that same Turn.
        anchorSeq: first.seq,
        // Chat groups every turn-located custom node into Tool process, even
        // when its anchor is beside the answer. A session-located result is a
        // direct Chat row and remains visible when that process folds (#65).
        location: { kind: 'session' },
        visibility: 'visible',
        data: {
          ...(state.turn !== undefined ? { turn: state.turn } : {}),
          results: state.results.map(({ seq: _seq, ...result }) => result),
        },
      }
    },
  }
}

/** Append a parsed result unless its job is already collected. */
function appendResult(
  state: VideoResultState,
  result: VideoResultPresentation,
  seq: number,
): VideoResultState {
  if (state.results.some(candidate => candidate.jobId === result.jobId)) {
    return state
  }
  return { ...state, results: [...state.results, { ...result, seq }] }
}

/** Job states this plugin's presentation metadata carries. */
const JOB_STATUSES: ReadonlySet<string> = new Set([
  'queued', 'in_progress', 'completed', 'failed', 'cancelled', 'interrupted',
])

/** Parse the plugin-owned durable presentation metadata from a Tool result event. */
export function videoResultsFromMeta(value: unknown): readonly VideoResultPresentation[] {
  const result = videoResultFromMeta(value)
  return result === undefined ? [] : [result]
}

function videoResultFromMeta(value: unknown): VideoResultPresentation | undefined {
  const meta = record(value)
  if (meta?.kind !== 'dsh-video-gen') return undefined
  const jobId = typeof meta.jobId === 'string' && meta.jobId.length > 0 ? meta.jobId : undefined
  const status = typeof meta.status === 'string' ? meta.status : undefined
  if (jobId === undefined || status === undefined || !JOB_STATUSES.has(status)) return undefined
  return {
    jobId,
    status,
    prompt: stringValue(meta.prompt, ''),
    ...(typeof meta.model === 'string' && meta.model.length > 0 ? { model: meta.model } : {}),
    ...(typeof meta.seconds === 'number' ? { seconds: meta.seconds } : {}),
    ...(typeof meta.size === 'string' && meta.size.length > 0 ? { size: meta.size } : {}),
    ...(typeof meta.seed === 'number' ? { seed: meta.seed } : {}),
    ...(typeof meta.createdAt === 'number' ? { createdAt: meta.createdAt } : {}),
    ...(typeof meta.savedTo === 'string' ? { savedTo: meta.savedTo } : {}),
  }
}

function eventTurn(event: EventLike): number | undefined {
  const turn = event.data.turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined
}

/** Plugin tools whose PTC (run_code) dispatch results are video results. */
const PTC_VIDEO_TOOL_NAMES: ReadonlySet<string> = new Set(['generate_video', 'videogen_generate_video'])

/** Job id as this plugin's fixed summary text prints it. */
const PTC_JOB_PATTERN = /job (video_[0-9a-f]+)/

/**
 * Parse a plugin video result from a tool/ptc-dispatch event. PTC run_code
 * sub-calls carry neither a turn nor presentationMeta, so the result is
 * rebuilt from the dispatch payload itself: the single text summary block
 * (this plugin's fixed render template) for the job id and state, and the
 * call arguments for prompt, seconds, size, and seed. Returns undefined for
 * anything that is not a video result from the generate tool.
 */
export function videoResultsFromPtcDispatch(event: EventLike): readonly VideoResultPresentation[] {
  if (event.type !== 'tool/ptc-dispatch') return []
  const data = event.data
  if (data.isError === true) return []
  if (typeof data.name !== 'string' || !PTC_VIDEO_TOOL_NAMES.has(data.name)) return []
  const content = Array.isArray(data.content) ? data.content : []
  let summaryText = ''
  for (const block of content) {
    const candidate = record(block)
    if (candidate === undefined || candidate.type !== 'text') continue
    if (typeof candidate.text === 'string') summaryText = candidate.text
  }
  const jobId = PTC_JOB_PATTERN.exec(summaryText)?.[1]
  if (jobId === undefined) return []
  let status: string | undefined
  if (/^Video ready \(/.test(summaryText)) {
    status = 'completed'
  } else {
    const failed = summaryText.match(/^Video job video_[0-9a-f]+ (failed|cancelled|interrupted) \(/)
    const inProgress = summaryText.match(/^Video job video_[0-9a-f]+ is still ([a-z_]+) \(/)
    status = failed?.[1] ?? inProgress?.[1]
  }
  if (status === undefined || !JOB_STATUSES.has(status)) return []
  const args = record(data.arguments)
  return [{
    jobId,
    status,
    prompt: stringValue(args?.prompt, ''),
    ...(typeof args?.seconds === 'number' ? { seconds: args.seconds } : {}),
    ...(typeof args?.size === 'string' ? { size: args.size } : {}),
    ...(typeof args?.seed === 'number' ? { seed: args.seed } : {}),
  }]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}
