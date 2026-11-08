/** Inline video result card: playback, live progress, and failure detail. */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { JOBS_ROUTE, THUMB_ROUTE, VIDEO_ROUTE, isTerminalStatus, type JobStatus } from '../shared.js'

/** Language chosen by the locale service at registration time. */
export type Lang = 'en' | 'zh'

export interface VideoCardFace {
  lang: Lang
}

export type VideoCardProps = PropsRuntime<'tool.call.toolview'> & InjectFace<VideoCardFace>

/** Shape of the tool result card this plugin's tools project. */
interface VideoMeta {
  kind?: string
  jobId?: string
  status?: string
  prompt?: string
  seconds?: number
  size?: string
  videoName?: string
  thumbName?: string
  savedTo?: string
  error?: string
  jobs?: VideoMeta[]
}

/** Browser view of one job, as `JOBS_ROUTE` reports it. */
interface JobSnapshot {
  id: string
  status: JobStatus
  progress: number
  stage?: string
  queuePosition?: number
  error?: string
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
  },
} as const

const STYLE = {
  card: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' },
  header: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  prompt: { margin: 0, fontSize: 13, lineHeight: 1.45, color: 'var(--dsh-text-secondary, #9aa3b2)' },
  video: { width: '100%', maxHeight: 420, borderRadius: 8, background: '#000', display: 'block' },
  badge: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.85 },
  meta: { fontSize: 11, opacity: 0.75 },
  track: { height: 4, borderRadius: 2, background: 'rgba(127,127,127,0.25)', overflow: 'hidden' },
  fill: { height: '100%', background: 'var(--dsh-accent, #4c8dff)', transition: 'width 300ms linear' },
  error: { fontSize: 12, color: 'var(--dsh-danger, #e5534b)', whiteSpace: 'pre-wrap' as const },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  listRow: { display: 'flex', gap: 8, fontSize: 12, padding: '4px 0', borderBottom: '1px solid rgba(127,127,127,0.15)' },
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

/** Poll one job while it is still rendering and return its newest snapshot. */
export function useJobProgress(jobId: string | undefined, initial: JobSnapshot | undefined): JobSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<JobSnapshot | undefined>(initial)
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
        const payload = await response.json() as { jobs?: Array<{ id: string; status: JobStatus; progress: number; stage?: string; queuePosition?: number; error?: string }> }
        const hit = payload.jobs?.find(job => job.id === jobId)
        if (!cancelled && hit !== undefined) {
          setSnapshot({
            id: hit.id,
            status: hit.status,
            progress: hit.progress,
            ...(hit.stage === undefined ? {} : { stage: hit.stage }),
            ...(hit.queuePosition === undefined ? {} : { queuePosition: hit.queuePosition }),
            ...(hit.error === undefined ? {} : { error: hit.error }),
          })
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

function statusLabel(lang: Lang, status: string | undefined): string {
  const text = TEXT[lang]
  if (status === 'completed') return text.ready
  if (status === 'failed') return text.failed
  if (status === 'cancelled') return text.cancelled
  if (status === 'interrupted') return text.interrupted
  if (status === 'queued') return text.queued
  return text.stillWorking
}

function MediaLine({ meta, lang }: { meta: VideoMeta; lang: Lang }) {
  const text = TEXT[lang]
  const parts: string[] = []
  if (meta.seconds !== undefined) parts.push(`${String(meta.seconds)}s`)
  if (meta.size !== undefined && meta.size.length > 0) parts.push(meta.size)
  if (meta.savedTo !== undefined) parts.push(`${text.saved}: ${meta.savedTo}`)
  else if (meta.jobId !== undefined) parts.push(text.stored)
  if (parts.length === 0) return null
  return <div style={STYLE.meta}>{parts.join(' · ')}</div>
}

/** One clip: player when ready, progress bar while rendering. */
function VideoCardView({ meta, lang }: { meta: VideoMeta; lang: Lang }) {
  const jobId = meta.jobId
  const progress = useJobProgress(jobId, jobId === undefined ? undefined : {
    id: jobId,
    status: (meta.status ?? 'in_progress') as JobStatus,
    progress: meta.status === 'completed' ? 100 : 0,
    ...(meta.error === undefined ? {} : { error: meta.error }),
  })
  const status = progress?.status ?? meta.status
  const terminal = status !== undefined && isTerminalStatus(status as JobStatus)
  const ready = status === 'completed' && jobId !== undefined
  const error = progress?.error ?? meta.error
  const text = TEXT[lang]

  return (
    <div style={STYLE.card}>
      <div style={STYLE.header}>
        <span style={STYLE.badge}>{statusLabel(lang, status)}</span>
        {meta.prompt !== undefined && meta.prompt.length > 0 ? <p style={STYLE.prompt}>{meta.prompt}</p> : null}
      </div>
      {ready ? (
        <video
          style={STYLE.video}
          controls
          preload="metadata"
          playsInline
          src={`${VIDEO_ROUTE}?job=${encodeURIComponent(jobId)}`}
          {...(meta.thumbName === undefined ? {} : { poster: `${THUMB_ROUTE}?job=${encodeURIComponent(jobId)}` })}
        />
      ) : null}
      {!ready && status !== 'failed' && status !== 'cancelled' ? (
        <>
          <div style={STYLE.track}>
            <div style={{ ...STYLE.fill, width: `${String(Math.max(0, Math.min(100, progress?.progress ?? 0)))}%` }} />
          </div>
          <div style={STYLE.meta}>
            {`${text.progress} ${String(progress?.progress ?? 0)}%`}
            {progress?.stage === undefined ? '' : ` · ${text.stage} ${progress.stage}`}
            {progress?.queuePosition === undefined ? '' : ` · ${text.queue} ${String(progress.queuePosition)}`}
          </div>
        </>
      ) : null}
      {error !== undefined && terminal && status !== 'completed' ? <div style={STYLE.error}>{error}</div> : null}
      <MediaLine meta={meta} lang={lang} />
    </div>
  )
}

/** Compact list for repeated status checks. */
function VideoList({ metas, lang }: { metas: VideoMeta[]; lang: Lang }) {
  const text = TEXT[lang]
  return (
    <div style={STYLE.card}>
      <div style={STYLE.meta}>{text.recent}</div>
      {metas.map((job, index) => (
        <div key={`${job.jobId ?? String(index)}`} style={STYLE.listRow}>
          <span style={STYLE.badge}>{statusLabel(lang, job.status)}</span>
          <span style={{ flex: 1 }}>{(job.prompt ?? '').slice(0, 90)}</span>
          <span style={STYLE.meta}>{[`${String(job.seconds ?? '')}s`, job.size ?? ''].filter(part => part.length > 0).join(' · ')}</span>
        </div>
      ))}
    </div>
  )
}

/** The keyed `tool.call.toolview` component for generate_video and its siblings. */
export function VideoResultCard(props: VideoCardProps) {
  const lang: Lang = props.lang ?? 'en'
  const meta = readVideoMeta(props.block)
  if (meta === undefined) {
    return <div style={STYLE.meta}>{lang === 'zh' ? '没有可显示的视频结果' : 'No video result to show.'}</div>
  }
  if (Array.isArray(meta.jobs)) return <VideoList metas={meta.jobs} lang={lang} />
  return <VideoCardView meta={meta} lang={lang} />
}

/** Read the language from the locale service snapshot. */
export function languageOf(snapshot: { active?: string | undefined } | undefined): Lang {
  return snapshot?.active?.toLowerCase().startsWith('zh') === true ? 'zh' : 'en'
}
