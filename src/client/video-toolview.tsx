/**
 * Inline video result card. While a job is queued or rendering the card draws
 * the "being made" sheet (ripples, plain-words stage, percent, time,
 * progress bar) with a cancel button and a heartbeat log line; when the clip
 * is ready the sheet ripples its first frame in and a `<video>` player takes
 * over on that frame. Failures grey the sheet with the reason.
 *
 * The card also owns the pre-result window: while the generate tool is still
 * running (its wait grace), there is no result metadata yet, so the sheet is
 * driven from the call arguments and a live job lookup by prompt. On hosts
 * with the `dsh-video-result` conversation node, a settled generate result is
 * rendered as a direct chat row instead; the tool card then carries only a
 * short notice.
 */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CANCEL_ROUTE, JOBS_ROUTE, VIDEO_ROUTE, isTerminalStatus, selectJobForCall, type JobStatus, type VideoJobView } from '../shared.js'
import { createVideoPanel, describeJob, secondsLabel, toPanelJob, type VideoPanelHandle } from './video-panel.js'
import type { VideoResultPresentation } from './video-result-node.js'

/** Language chosen by the locale service at registration time. */
export type Lang = 'en' | 'zh'

export interface VideoCardFace {
  lang: Lang
  /**
   * True on hosts where the `dsh-video-result` conversation node is
   * registered. There, a settled `generate_video` result renders as a direct
   * chat row; the tool card then shows only a short notice.
   */
  promoted?: boolean
}

/**
 * The harness owner payload spreads the call stage into the view's props:
 * `phase` is `'preparing'` (arguments still streaming), `'start'` (running,
 * full arguments, no result yet), or `'result'`.
 */
interface VideoCardOwnerProps {
  phase?: string
  toolName?: string
}

export type VideoCardProps = PropsRuntime<'tool.call.toolview'> & InjectFace<VideoCardFace> & VideoCardOwnerProps

/** Shape of the tool result card this plugin's tools project. */
interface VideoMeta {
  kind?: string
  jobId?: string
  status?: string
  prompt?: string
  seconds?: number
  size?: string
  model?: string
  createdAt?: number
  stage?: string
  queuePosition?: number
  seed?: number
  videoName?: string
  thumbName?: string
  savedTo?: string
  error?: string
  jobs?: VideoMeta[]
}

const TEXT = {
  en: {
    stillWorking: 'Rendering',
    queued: 'Queued',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    ready: 'Video',
    progress: 'progress',
    queue: 'queue',
    stage: 'stage',
    saved: 'Saved to',
    stored: 'Stored on this host',
    frames: 'frames',
    recent: 'Recent video jobs',
    cancel: 'Cancel',
    cancelling: 'Cancelling…',
    processing: 'Processing…',
    seed: 'seed',
    promoted: 'Video is shown in the conversation',
  },
  zh: {
    stillWorking: '渲染中',
    queued: '排队中',
    failed: '失败',
    cancelled: '已取消',
    interrupted: '已中断',
    ready: '视频',
    progress: '进度',
    queue: '队列',
    stage: '阶段',
    saved: '已保存到',
    stored: '保存在本机',
    frames: '画面',
    recent: '最近的视频任务',
    cancel: '取消',
    cancelling: '取消中…',
    processing: '处理中…',
    seed: '种子',
    promoted: '视频已显示在对话中',
  },
} as const

const STYLE = {
  card: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' },
  header: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  prompt: { margin: 0, fontSize: 13, lineHeight: 1.45, color: 'var(--dsh-text-secondary, #9aa3b2)' },
  badge: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.85 },
  meta: { fontSize: 11, opacity: 0.75 },
  error: { fontSize: 12, color: 'var(--dsh-danger, #e5534b)', whiteSpace: 'pre-wrap' as const },
  sheetHost: { width: '100%' },
  metaRow: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
  cancelBtn: {
    fontSize: 11,
    padding: '2px 10px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.4)',
    background: 'transparent',
    color: 'var(--dsh-text-secondary, #9aa3b2)',
    cursor: 'pointer',
    opacity: 0.9,
  },
  processRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: 'var(--dsh-text-secondary, #9aa3b2)' },
  process: { opacity: 0.8 },
  spinner: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    border: '2px solid rgba(127,127,127,0.35)',
    borderTopColor: 'rgba(246,244,255,0.85)',
    display: 'inline-block',
    flexShrink: 0,
    animation: 'nm-gen-spin 1s linear infinite',
  },
  logLine: { fontSize: 11, opacity: 0.55, fontVariantNumeric: 'tabular-nums' as const },
  logList: { display: 'flex', flexDirection: 'column' as const, gap: 2, marginBottom: 2 },
  logRow: { fontSize: 11, opacity: 0.4, fontVariantNumeric: 'tabular-nums' as const, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  listRow: { display: 'flex', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid rgba(127,127,127,0.15)' },
  notice: { fontSize: 12, opacity: 0.75, color: 'var(--dsh-text-secondary, #9aa3b2)' },
} as const

/** Read the tool result card metadata from either block shape the host offers. */
export function readVideoMeta(block: unknown): VideoMeta | undefined {
  const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : {}
  const fromResult = typeof record.resultView === 'object' && record.resultView !== null
    ? (record.resultView as Record<string, unknown>).meta
    : undefined
  for (const candidate of [record.meta, fromResult]) {
    if (typeof candidate === 'object' && candidate !== null) {
      const meta = candidate as VideoMeta
      if (meta.jobId !== undefined || Array.isArray(meta.jobs)) return meta
    }
  }
  return undefined
}

/** Parsed generate_video call arguments, used while the tool is still running. */
export interface VideoCallArgs {
  prompt: string
  seconds?: number
  size?: string
  seed?: number
}

/**
 * Read the generate_video arguments from the running-stage block
 * (`argsRaw`). During the tool's wait grace there is no result metadata yet,
 * so these arguments drive the sheet. A still-streaming (preparing) argument
 * blob parses to nothing until the harness completes it.
 */
export function readVideoArgs(block: unknown): VideoCallArgs | undefined {
  const record = typeof block === 'object' && block !== null ? block as Record<string, unknown> : {}
  const raw = typeof record.argsRaw === 'string' ? record.argsRaw : undefined
  if (raw === undefined || raw.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const args = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  if (args === undefined || typeof args.prompt !== 'string' || args.prompt.length === 0) return undefined
  return {
    prompt: args.prompt,
    ...(typeof args.seconds === 'number' ? { seconds: args.seconds } : {}),
    ...(typeof args.size === 'string' && args.size.length > 0 ? { size: args.size } : {}),
    ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
  }
}

/** What the running-call lookup knows: the job (once it exists) and why not yet. */
export interface JobLookup {
  job: VideoJobView | undefined
  /** One plain line for the card's log while there is no job to track. */
  note: string | undefined
}

/**
 * While the generate tool is still running (no result metadata yet), find the
 * job the call belongs to so the sheet can track real progress, stage, and the
 * cancel handle. The job appears in the job list as soon as the server accepts
 * it. The selection rule is the host's own (`selectJobForCall`): a prompt match
 * first, then a single unambiguous active job — a call whose wire text drifts
 * from the stored prompt still finds its render instead of sitting at 0%.
 * Polling stops once the job settles.
 */
export function useJobByPrompt(prompt: string, sinceMs: number): JobLookup {
  const [lookup, setLookup] = useState<JobLookup>({ job: undefined, note: undefined })
  useEffect(() => {
    if (prompt.length === 0) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${JOBS_ROUTE}?limit=10`, { cache: 'no-store' })
        if (!response.ok) {
          const note = `job list unavailable (HTTP ${String(response.status)})`
          if (!cancelled) setLookup(previous => ({ job: previous.job, note }))
        } else {
          const payload = await response.json() as { jobs?: VideoJobView[] }
          // Ignore anything older than this call, so a previous render is never
          // mistaken for this one.
          // An endpoint that reports `created_at` in epoch seconds would read as
          // 1970 here and be filtered out; scale it before comparing.
          const fresh = (payload.jobs ?? [])
            .map(job => (job.createdAt >= 1e9 && job.createdAt < 1e12 ? { ...job, createdAt: job.createdAt * 1000 } : job))
            .filter(job => (job.createdAt ?? 0) >= sinceMs - 60000)
          const hit = selectJobForCall(fresh, prompt)
          if (!cancelled) {
            setLookup({ job: hit, note: hit === undefined ? 'waiting for the job to appear' : undefined })
            if (hit !== undefined && isTerminalStatus(hit.status)) return
          }
        }
      } catch (error) {
        const note = `job list unavailable (${error instanceof Error ? error.message : String(error)})`
        if (!cancelled) setLookup(previous => ({ job: previous.job, note }))
      }
      if (!cancelled) timer = setTimeout(() => void tick(), 2000)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [prompt, sinceMs])
  return lookup
}

/** One line of the card's progress log. */
export interface JobLogLine {
  key: string
  elapsed: string
  text: string
}

/**
 * The card's log: one line per distinct engine answer, like a terminal tail.
 * The sheet's own text only ever shows the current state, and the plugin can
 * see every stage the API reports — this keeps the earlier lines readable.
 */
export function useJobLog(job: VideoJobView | undefined, note: string | undefined, active: boolean): JobLogLine[] {
  const [lines, setLines] = useState<JobLogLine[]>([])
  const lastRef = useRef('')
  useEffect(() => {
    if (!active) return
    const text = job === undefined
      ? (note ?? 'creating the job')
      : describeJob(toPanelJob(job))
    if (text === lastRef.current) return
    lastRef.current = text
    const elapsed = job === undefined
      ? secondsLabel(0)
      : secondsLabel(Date.now() - (job.createdAt > 0 ? job.createdAt : Date.now()))
    setLines(previous => [...previous, { key: `${String(previous.length)}:${text}`, elapsed, text }].slice(-6))
  }, [job, note, active])
  return lines
}
export function useJobProgress(jobId: string | undefined, initial: VideoJobView | undefined): VideoJobView | undefined {
  const [snapshot, setSnapshot] = useState<VideoJobView | undefined>(initial)
  const settled = useRef(false)
  useEffect(() => {
    if (jobId === undefined) return undefined
    settled.current = snapshot !== undefined && isTerminalStatus(snapshot.status)
    if (settled.current) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${JOBS_ROUTE}?limit=10`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const payload = await response.json() as { jobs?: VideoJobView[] }
        const hit = payload.jobs?.find(job => job.id === jobId)
        if (!cancelled && hit !== undefined) {
          setSnapshot(hit)
          if (isTerminalStatus(hit.status)) return
        }
      } catch {
        // A dropped poll is not an error the user needs to see; try again.
      }
      if (!cancelled) timer = setTimeout(() => void tick(), 2000)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [jobId, snapshot?.status])
  return snapshot
}

/**
 * The sheet for one job. The panel module owns every pixel inside the
 * host div: the water while rendering, the grey sheet on failure, and the
 * `<video>` player after the reveal wave settles. `autoplay` mirrors the design:
 * a fresh `generate_video` plays; re-opening a finished job stays paused
 * on its first frame. `jobId` may be undefined while the sheet is driven by
 * the call arguments (the tool is still running); the reveal waits for the
 * id the live lookup or the result supplies.
 */
function VideoSheet({ job, jobId, autoplay }: { job: VideoJobView; jobId: string | undefined; autoplay: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<VideoPanelHandle | null>(null)
  const actedRef = useRef(false)
  const jobIdRef = useRef<string | undefined>(jobId)
  const initialSizeRef = useRef(job.size)

  useEffect(() => {
    jobIdRef.current = jobId
  }, [jobId])

  // The panel mounts once per card instance so the sheet survives the
  // argument-driven start stage handing off to the result's job id.
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const panel = createVideoPanel(host, { size: initialSizeRef.current })
    panelRef.current = panel
    return () => {
      panel.destroy()
      panelRef.current = null
    }
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    if (panel === null || actedRef.current) return
    if (job.status === 'completed') {
      const id = jobIdRef.current
      if (id === undefined) return
      actedRef.current = true
      void panel.done(`${VIDEO_ROUTE}?job=${encodeURIComponent(id)}`, { autoplay })
    } else if (job.status === 'queued' || job.status === 'in_progress') {
      panel.update(toPanelJob(job))
    } else {
      actedRef.current = true
      panel.fail(job.error, { cancelled: job.status === 'cancelled' })
    }
  }, [job, jobId, autoplay])

  return <div ref={hostRef} style={STYLE.sheetHost} />
}

/** One line under the sheet while a job runs: `size · Ns · seed N` plus cancel. */
function MetaRow({ job, meta, lang, cancelling, canCancel, onCancel }: {
  job: VideoJobView | undefined
  meta: VideoMeta
  lang: Lang
  cancelling: boolean
  canCancel: boolean
  onCancel: () => void
}): JSX.Element {
  const text = TEXT[lang]
  const size = job?.size ?? meta.size ?? ''
  const seconds = job?.seconds ?? meta.seconds
  const seed = job?.seed ?? meta.seed
  const parts: string[] = []
  if (size.length > 0) parts.push(size)
  if (seconds !== undefined && seconds > 0) parts.push(`${String(seconds)}s`)
  if (seed !== undefined) parts.push(`${text.seed} ${String(seed)}`)
  return (
    <div style={STYLE.metaRow}>
      <span style={STYLE.meta}>{parts.join(' · ')}</span>
      {canCancel ? (
        <button
          type="button"
          style={STYLE.cancelBtn}
          disabled={cancelling}
          onClick={onCancel}
        >
          {cancelling ? text.cancelling : `✕ ${text.cancel}`}
        </button>
      ) : null}
    </div>
  )
}

/** The spinner + `Processing…` row, with the model chip. */
function ProcessingRow({ job, meta, lang }: { job: VideoJobView | undefined; meta: VideoMeta; lang: Lang }): JSX.Element {
  const text = TEXT[lang]
  const model = job?.model ?? meta.model ?? ''
  return (
    <div style={STYLE.processRow}>
      <span style={STYLE.spinner} aria-hidden="true" />
      <span style={STYLE.process}>{text.processing}</span>
      {model.length > 0 ? <span style={STYLE.badge}>{model}</span> : null}
    </div>
  )
}

function statusLabel(lang: Lang, status: string | undefined): string {
  const text = TEXT[lang]
  switch (status) {
    case 'queued': return text.queued
    case 'completed': return text.ready
    case 'failed': return text.failed
    case 'cancelled': return text.cancelled
    case 'interrupted': return text.interrupted
    case 'in_progress': return text.stillWorking
    default: return text.stillWorking
  }
}

function MediaLine({ meta, lang }: { meta: VideoMeta; lang: Lang }): JSX.Element | null {
  const text = TEXT[lang]
  const parts: string[] = []
  if (meta.seconds !== undefined) parts.push(`${String(meta.seconds)}s`)
  if (meta.size !== undefined && meta.size.length > 0) parts.push(meta.size)
  if (meta.savedTo !== undefined) parts.push(`${text.saved}: ${meta.savedTo}`)
  else if (meta.jobId !== undefined) parts.push(text.stored)
  if (parts.length === 0) return null
  return <div style={STYLE.meta}>{parts.join(' · ')}</div>
}

/** The single-job card: sheet or player, the status rows while running, and detail. */
function VideoCardView({ meta, lang, note }: { meta: VideoMeta; lang: Lang; note?: string | undefined }) {
  const text = TEXT[lang]
  const jobId = meta.jobId
  const initial: VideoJobView | undefined = {
    id: jobId ?? 'pending',
    model: meta.model ?? '',
    prompt: meta.prompt ?? '',
    status: (meta.status ?? 'in_progress') as JobStatus,
    progress: meta.status === 'completed' ? 100 : 0,
    ...(meta.stage === undefined ? {} : { stage: meta.stage }),
    ...(meta.queuePosition === undefined ? {} : { queuePosition: meta.queuePosition }),
    seconds: meta.seconds ?? 0,
    size: meta.size ?? '',
    ...(meta.seed === undefined ? {} : { seed: meta.seed }),
    fromPicture: false,
    createdAt: meta.createdAt ?? 0,
    updatedAt: 0,
    ...(meta.error === undefined ? {} : { error: meta.error }),
  }
  const snapshot = useJobProgress(jobId, initial)
  const job = snapshot ?? initial
  const status = job?.status ?? meta.status
  const ready = jobId !== undefined && status === 'completed'
  const failedLike = status === 'failed' || status === 'cancelled' || status === 'interrupted'
  const error = job?.error ?? meta.error
  const [cancelling, setCancelling] = useState(false)
  const rendering = status === 'queued' || status === 'in_progress'

  useEffect(() => {
    if (cancelling && !rendering) setCancelling(false)
  }, [cancelling, rendering])

  const cancelJob = (): void => {
    if (jobId === undefined || cancelling) return
    setCancelling(true)
    void fetch(CANCEL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: jobId }),
    }).catch(() => undefined)
  }

  // Re-render once a second while rendering so the elapsed time moves even
  // when the engine has nothing new to say.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!rendering) return undefined
    const timer = setInterval(() => setTick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [rendering])

  // The §4 heartbeat line: `<latest log text> · <seconds since creation>`.
  const elapsed = job?.createdAt !== undefined && job.createdAt > 0 ? Date.now() - job.createdAt : 0
  // Until a real job is tracked (no id yet), `job` is only the placeholder
  // built from the call arguments; log the lookup's own note instead, so the
  // card says why it is still at 0% rather than a generic "Generating".
  const tracked = jobId !== undefined || note === undefined ? job : undefined
  // One line per distinct engine answer, so every stage the API reports stays
  // readable instead of only the current one.
  const log = useJobLog(tracked, note, rendering)
  const history = log.slice(0, -1).slice(-4)
  const current = log.length > 0 ? log[log.length - 1]!.text : describeJob(job !== undefined ? toPanelJob(job) : undefined)

  return (
    <div style={STYLE.card}>
      <div style={STYLE.header}>
        <span style={STYLE.badge}>{statusLabel(lang, status)}</span>
        {meta.prompt !== undefined && meta.prompt.length > 0 ? <p style={STYLE.prompt}>{meta.prompt}</p> : null}
      </div>
      {job !== undefined ? <VideoSheet job={job} jobId={jobId} autoplay={meta.kind === 'dsh-video-gen'} /> : null}
      {rendering ? (
        <>
          <MetaRow job={job} meta={meta} lang={lang} cancelling={cancelling} canCancel={jobId !== undefined} onCancel={cancelJob} />
          <ProcessingRow job={job} meta={meta} lang={lang} />
          {history.length > 0 ? (
            <div style={STYLE.logList}>
              {history.map(line => (
                <div key={line.key} style={STYLE.logRow}>{line.elapsed} · {line.text}</div>
              ))}
            </div>
          ) : null}
          <div style={STYLE.logLine}>{current} · {secondsLabel(elapsed)}</div>
        </>
      ) : null}
      {failedLike ? <div style={STYLE.error}>{error ?? text.failed}</div> : null}
      {(ready || failedLike) ? <MediaLine meta={meta} lang={lang} /> : null}
    </div>
  )
}

function VideoList({ metas, lang }: { metas: VideoMeta[]; lang: Lang }) {
  const text = TEXT[lang]
  return (
    <div style={STYLE.card}>
      <div style={STYLE.meta}>{text.recent}</div>
      {metas.map((job, index) => (
        <div key={job.jobId ?? String(index)} style={STYLE.listRow}>
          <span style={STYLE.badge}>{statusLabel(lang, job.status)}</span>
          <span>{job.prompt}</span>
          <span style={STYLE.meta}>
            {[job.model ?? '', job.seconds !== undefined ? `${String(job.seconds)}s` : '', job.size ?? ''].filter(part => part.length > 0).join(' · ')}
          </span>
        </div>
      ))}
    </div>
  )
}

/** The keyed `tool.call.toolview` component for generate_video and its siblings. */
/**
 * The tool result card entry. Three shapes:
 * - a settled generate result on a host with the conversation node renders
 *   only a notice — the clip lives in the `dsh-video-result` chat row;
 * - a running generate call (no result metadata yet) renders the sheet
 *   driven by the call arguments plus the live job matched by prompt;
 * - everything else (results, check/cancel, legacy hosts) renders the full
 *   card.
 */
export function VideoResultCard(props: VideoCardProps) {
  const lang: Lang = props.lang ?? 'en'
  const meta = readVideoMeta(props.block)
  if (meta !== undefined) {
    if (props.promoted === true && meta.kind === 'dsh-video-gen' && meta.jobId !== undefined) {
      return <PromotedResultNotice lang={lang} />
    }
    if (Array.isArray(meta.jobs)) return <VideoList metas={meta.jobs} lang={lang} />
    return <VideoCardView meta={meta} lang={lang} />
  }
  const phase = props.phase
  const args = phase === 'start' || phase === 'preparing'
    ? readVideoArgs(props.block)
    : undefined
  if (args !== undefined && props.toolName !== undefined && GENERATE_TOOL_NAMES.has(props.toolName)) {
    return <StartPhaseCard args={args} lang={lang} />
  }
  return <div style={STYLE.meta}>{lang === 'zh' ? '没有可显示的视频结果' : 'No video result to show.'}</div>
}

/** The short line a tool card carries once its result is promoted to a chat row. */
function PromotedResultNotice({ lang }: { lang: Lang }): JSX.Element {
  const text = TEXT[lang]
  return <div style={STYLE.notice}>{text.promoted}</div>
}

/** Tool names that start a render; the others (check/cancel) have no sheet stage. */
const GENERATE_TOOL_NAMES: ReadonlySet<string> = new Set(['generate_video', 'videogen_generate_video'])

/**
 * The sheet while the generate tool is still running (its wait grace, no
 * result metadata yet). The job is followed by its prompt, so percent, stage,
 * cancel, and the reveal behave exactly as once the result lands.
 */
function StartPhaseCard({ args, lang }: { args: VideoCallArgs; lang: Lang }): JSX.Element {
  const mountedAt = useRef(Date.now())
  const { job: found, note } = useJobByPrompt(args.prompt, mountedAt.current)
  const meta: VideoMeta = {
    kind: 'dsh-video-gen',
    status: found?.status ?? 'in_progress',
    prompt: args.prompt,
    createdAt: found?.createdAt ?? mountedAt.current,
    ...(found?.id === undefined ? {} : { jobId: found.id }),
    ...(found?.seconds === undefined && args.seconds === undefined ? {} : { seconds: found?.seconds ?? args.seconds }),
    ...(found?.size === undefined && args.size === undefined ? {} : { size: found?.size ?? args.size }),
    ...(found?.model === undefined ? {} : { model: found.model }),
    ...(found?.seed === undefined && args.seed === undefined ? {} : { seed: found?.seed ?? args.seed }),
    ...(found?.stage === undefined ? {} : { stage: found.stage }),
    ...(found?.queuePosition === undefined ? {} : { queuePosition: found.queuePosition }),
    ...(found?.error === undefined ? {} : { error: found.error }),
  }
  return <VideoCardView meta={meta} lang={lang} note={note} />
}

/** The direct chat row for promoted video results (kind `dsh-video-result`). */
export interface VideoResultNodeProps {
  node: { data: { results: readonly VideoResultPresentation[] } }
  lang?: Lang | undefined
}

/**
 * Conversation node view: every promoted result renders the full card
 * as final output — the water sheet with live progress while the job runs and
 * the ripple reveal when the clip lands.
 */
export function PromotedVideoResultNode(props: VideoResultNodeProps): JSX.Element | null {
  const lang: Lang = props.lang ?? 'en'
  const results = props.node?.data?.results
  if (results === undefined || results.length === 0) return null
  return (
    <div>
      {results.map((result, index) => (
        <div key={result.jobId ?? String(index)} style={index === 0 ? undefined : { marginTop: 12 }}>
          <VideoCardView meta={videoMetaFromPresentation(result)} lang={lang} />
        </div>
      ))}
    </div>
  )
}

/** Map one presentation the conversation node stored onto the card's meta shape. */
export function videoMetaFromPresentation(result: VideoResultPresentation): VideoMeta {
  return {
    kind: 'dsh-video-gen',
    jobId: result.jobId,
    status: result.status,
    prompt: result.prompt,
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.seconds === undefined ? {} : { seconds: result.seconds }),
    ...(result.size === undefined ? {} : { size: result.size }),
    ...(result.seed === undefined ? {} : { seed: result.seed }),
    ...(result.createdAt === undefined ? {} : { createdAt: result.createdAt }),
    ...(result.savedTo === undefined ? {} : { savedTo: result.savedTo }),
  }
}

/** Read the language from the locale service snapshot. */
export function languageOf(snapshot: { active?: string | undefined } | undefined): Lang {
  return snapshot?.active?.toLowerCase().startsWith('zh') === true ? 'zh' : 'en'
}







