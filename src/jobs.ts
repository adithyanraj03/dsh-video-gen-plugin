/**
 * Video job store: submit, poll, download, and remember.
 *
 * The store is the single owner of job state. A tool call waits on it for a
 * grace window and can then be re-queried through `video_status`, so a long
 * render never holds the conversation hostage. Job records persist to
 * `jobs.json` next to the clips, which lets a restarted host re-attach to
 * renders the server is still working on.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_JOB_HISTORY,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  isTerminalStatus,
  safeFileName,
  videoFileStem,
  type JobStatus,
  type VideoJobRecord,
  type VideoJobView,
} from './shared.js'
import { cancelVideo, createVideo, describeJobFailure, downloadContent, getVideo, pollDelay, type NinferClient, type NinferJob, type ReferenceImage } from './ninfer.js'

/** Everything needed to queue one clip. */
export interface SubmitRequest {
  model: string
  prompt: string
  seconds: number
  size: string
  fps?: number
  seed?: number
  enhance: boolean
  negativePrompt?: string
  reference?: ReferenceImage
}

export interface JobStoreOptions {
  /** Directory that receives finished clips and `jobs.json`; re-read every use. */
  dir: string | (() => string)
  /** Client factory so a rotated token takes effect without a restart. */
  client: () => NinferClient | Promise<NinferClient>
  log?: (message: string) => void
  pollIntervalMs?: number
  jobTimeoutMs?: number
  maxVideoBytes?: number
  saveThumbnail?: boolean
  history?: number
  /**
   * Called once a clip is downloaded, before the record is written back. Use it
   * for side effects that must happen exactly once per finished job, such as
   * copying the clip into a workspace; failures are logged, never fatal.
   */
  afterComplete?: (record: VideoJobRecord) => Promise<VideoJobRecord>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

const HISTORY_FILE = 'jobs.json'

/** Abortable sleep; polling must not outlive the caller's abort. */
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (signal?.aborted === true) {
      clearTimeout(timer)
      reject(new Error('aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Coerce the API's free-form status into the store's vocabulary. */
export function mapStatus(status: string): JobStatus {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized === 'queued' || normalized === 'pending' || normalized === 'waiting') return 'queued'
  if (normalized === 'in_progress' || normalized === 'processing' || normalized === 'running' || normalized === 'rendering') return 'in_progress'
  if (normalized === 'completed' || normalized === 'succeeded' || normalized === 'done') return 'completed'
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled'
  return 'in_progress'
}

/** Merge one server payload into a local record. */
export function applyJobPayload(record: VideoJobRecord, job: NinferJob, now: number): VideoJobRecord {
  const status = mapStatus(job.status)
  const next: VideoJobRecord = {
    ...record,
    status,
    progress: Math.max(0, Math.min(100, Math.round(job.progress ?? record.progress))),
    updatedAt: now,
  }
  if (job.stage !== undefined) next.stage = job.stage
  if (job.queuePosition !== undefined) next.queuePosition = job.queuePosition
  if (job.size !== undefined) next.size = job.size
  if (job.seed !== undefined) next.seed = job.seed
  if (job.fromPicture !== undefined) next.fromPicture = job.fromPicture
  if (status === 'completed') next.completedAt = record.completedAt ?? now
  if (status === 'failed') {
    const code = job.error?.code
    next.errorCode = code ?? 'failed'
    next.error = describeJobFailure(code, job.error?.message, job)
    next.completedAt = record.completedAt ?? now
  }
  return next
}

/** Drop host paths from a record before handing it to the browser. */
export function toJobView(record: VideoJobRecord): VideoJobView {
  return {
    id: record.id,
    model: record.model,
    prompt: record.prompt,
    status: record.status,
    progress: record.progress,
    ...(record.stage === undefined ? {} : { stage: record.stage }),
    ...(record.queuePosition === undefined ? {} : { queuePosition: record.queuePosition }),
    seconds: record.seconds,
    size: record.size,
    ...(record.seed === undefined ? {} : { seed: record.seed }),
    fromPicture: record.fromPicture,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.videoFile === undefined ? {} : { videoName: safeFileName(record.videoFile.split(/[\\/]/).pop() ?? 'video.mp4') }),
    ...(record.thumbFile === undefined ? {} : { thumbName: safeFileName(record.thumbFile.split(/[\\/]/).pop() ?? 'thumb.jpg') }),
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

/** In-memory job table backed by `jobs.json`, with one poller per running job. */
export class VideoJobStore {
  private readonly options: Required<Pick<JobStoreOptions, 'pollIntervalMs' | 'jobTimeoutMs' | 'maxVideoBytes' | 'saveThumbnail' | 'history'>> & JobStoreOptions
  private readonly records = new Map<string, VideoJobRecord>()
  private readonly polls = new Map<string, Promise<VideoJobRecord>>()
  private loaded = false

  constructor(options: JobStoreOptions) {
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      jobTimeoutMs: options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
      maxVideoBytes: options.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES,
      saveThumbnail: options.saveThumbnail ?? true,
      history: options.history ?? DEFAULT_JOB_HISTORY,
      ...options,
    }
  }

  private log(message: string): void {
    this.options.log?.(message)
  }

  /** Current clip directory; a settings edit moves new writes without a restart. */
  private get dir(): string {
    return typeof this.options.dir === 'function' ? this.options.dir() : this.options.dir
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private async nap(ms: number, signal?: AbortSignal): Promise<void> {
    const sleep = this.options.sleep ?? delay
    await sleep(ms, signal)
  }

  /** Absolute clip path for a record; names are derived, never server-supplied. */
  filePaths(record: { id: string; createdAt?: number }): { video: string; thumb: string } {
    const stem = videoFileStem(record)
    return { video: join(this.dir, `${stem}.mp4`), thumb: join(this.dir, `${stem}.jpg`) }
  }

  /** Read `jobs.json`; non-terminal leftovers from a previous host become `interrupted`. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(join(this.dir, HISTORY_FILE), 'utf8')
      const parsed = JSON.parse(raw) as { jobs?: unknown }
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : []
      for (const item of jobs) {
        const record = item as Partial<VideoJobRecord>
        if (typeof record?.id !== 'string' || record.id.length === 0) continue
        const status: JobStatus = isTerminalStatus((record.status ?? 'interrupted') as JobStatus)
          ? (record.status as JobStatus)
          : 'interrupted'
        this.records.set(record.id, {
          id: record.id,
          provider: record.provider ?? 'ninfer',
          model: record.model ?? 'ltx-2.5',
          prompt: record.prompt ?? '',
          status,
          progress: typeof record.progress === 'number' ? record.progress : 0,
          ...(record.stage === undefined ? {} : { stage: record.stage }),
          ...(record.queuePosition === undefined ? {} : { queuePosition: record.queuePosition }),
          seconds: typeof record.seconds === 'number' ? record.seconds : 5,
          size: record.size ?? '1280x704',
          ...(record.fps === undefined ? {} : { fps: record.fps }),
          ...(record.seed === undefined ? {} : { seed: record.seed }),
          enhance: record.enhance === true,
          ...(record.negativePrompt === undefined ? {} : { negativePrompt: record.negativePrompt }),
          fromPicture: record.fromPicture === true,
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : this.now(),
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : this.now(),
          ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
          ...(record.videoFile === undefined ? {} : { videoFile: record.videoFile }),
          ...(record.thumbFile === undefined ? {} : { thumbFile: record.thumbFile }),
          ...(record.videoBytes === undefined ? {} : { videoBytes: record.videoBytes }),
          ...(record.savedTo === undefined ? {} : { savedTo: record.savedTo }),
          ...(record.thumbSavedTo === undefined ? {} : { thumbSavedTo: record.thumbSavedTo }),
          ...(record.error === undefined ? {} : { error: record.error }),
          ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log(`video job history could not be read: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Re-attach pollers to jobs the server may still be rendering. */
  async resume(signal?: AbortSignal): Promise<number> {
    await this.load()
    let resumed = 0
    for (const record of this.records.values()) {
      if (record.status !== 'interrupted' && record.status !== 'queued' && record.status !== 'in_progress') continue
      record.status = 'in_progress'
      void this.attach(record.id, signal).catch(error => {
        this.log(`resumed job ${record.id} ended badly: ${error instanceof Error ? error.message : String(error)}`)
      })
      resumed += 1
    }
    if (resumed > 0) this.log(`re-attached ${String(resumed)} unfinished video job(s)`)
    return resumed
  }

  get(id: string): VideoJobRecord | undefined {
    return this.records.get(id)
  }

  /** Insert or replace one record, e.g. a job read straight from the server. */
  async remember(record: VideoJobRecord): Promise<VideoJobRecord> {
    await this.load()
    this.records.set(record.id, record)
    await this.persist()
    return record
  }

  /** Newest first, terminal or not. */
  list(limit?: number): VideoJobRecord[] {
    const all = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt)
    return limit === undefined ? all : all.slice(0, Math.max(0, limit))
  }

  listActive(): VideoJobRecord[] {
    return this.list().filter(record => !isTerminalStatus(record.status))
  }

  /** Queue a clip and start polling it. Returns once the server has accepted it. */
  async submit(request: SubmitRequest, signal?: AbortSignal): Promise<VideoJobRecord> {
    await this.load()
    const client = await this.options.client()
    const job = await createVideo(client, {
      model: request.model,
      prompt: request.prompt,
      seconds: request.seconds,
      size: request.size,
      ...(request.fps === undefined ? {} : { fps: request.fps }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      enhance: request.enhance,
      ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
    }, { ...(request.reference === undefined ? {} : { reference: request.reference }), ...(signal === undefined ? {} : { signal }) })

    const now = this.now()
    const record: VideoJobRecord = {
      id: job.id,
      provider: 'ninfer',
      model: job.model ?? request.model,
      prompt: request.prompt,
      status: mapStatus(job.status),
      progress: job.progress ?? 0,
      ...(job.stage === undefined ? {} : { stage: job.stage }),
      ...(job.queuePosition === undefined ? {} : { queuePosition: job.queuePosition }),
      seconds: job.seconds ?? request.seconds,
      size: job.size ?? request.size,
      ...(request.fps === undefined ? {} : { fps: request.fps }),
      ...(job.seed ?? request.seed === undefined ? {} : { seed: job.seed ?? (request.seed as number) }),
      enhance: request.enhance,
      ...(request.negativePrompt === undefined ? {} : { negativePrompt: request.negativePrompt }),
      fromPicture: job.fromPicture ?? request.reference !== undefined,      createdAt: job.createdAt ?? now,
      updatedAt: now,
    }
    this.records.set(record.id, record)
    await this.persist()
    void this.attach(record.id).catch(error => {
      this.log(`job ${record.id} poller stopped: ${error instanceof Error ? error.message : String(error)}`)
    })
    return record
  }

  /** Poll one job to a terminal state, then download it. Concurrent calls share one poller. */
  attach(id: string, signal?: AbortSignal): Promise<VideoJobRecord> {
    const existing = this.polls.get(id)
    if (existing !== undefined) return existing
    const poll = this.runPoll(id, signal).finally(() => this.polls.delete(id))
    this.polls.set(id, poll)
    return poll
  }

  private async runPoll(id: string, signal?: AbortSignal): Promise<VideoJobRecord> {
    const deadline = (this.records.get(id)?.createdAt ?? this.now()) + this.options.jobTimeoutMs
    let attempt = 0
    for (;;) {
      const record = this.records.get(id)
      if (record === undefined) throw new Error(`job ${id} is not tracked by this store`)
      const client = await this.options.client()
      try {
        const job = await getVideo(client, id, signal)
        attempt = 0
        const next = applyJobPayload(record, job, this.now())
        this.records.set(id, next)
        await this.persist()
        if (next.status === 'completed') return await this.finalize(id, client)
        if (isTerminalStatus(next.status)) return next
      } catch (error) {
        const retryable = (error as { retryable?: boolean; code?: string })?.retryable === true
        if (!retryable) {
          const failed: VideoJobRecord = {
            ...record,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
            errorCode: (error as { code?: string })?.code ?? 'poll_failed',
            updatedAt: this.now(),
            completedAt: record.completedAt ?? this.now(),
          }
          this.records.set(id, failed)
          await this.persist()
          return failed
        }
        this.log(`polling ${id} hit a transient error: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (this.now() > deadline) {
        const timedOut: VideoJobRecord = {
          ...this.records.get(id) as VideoJobRecord,
          status: 'failed',
          error: `the job did not finish within ${String(Math.round(this.options.jobTimeoutMs / 60000))} minutes; ask for a shorter clip or a smaller size.`,
          errorCode: 'timeout',
          updatedAt: this.now(),
          completedAt: this.now(),
        }
        this.records.set(id, timedOut)
        await this.persist()
        return timedOut
      }
      try {
        await this.nap(pollDelay(attempt, this.options.pollIntervalMs), signal)
      } catch {
        const parked: VideoJobRecord = { ...(this.records.get(id) as VideoJobRecord), updatedAt: this.now() }
        this.records.set(id, parked)
        await this.persist()
        return parked
      }
      attempt += 1
    }
  }

  /** Download the MP4 (and thumbnail) and record where they landed. */
  private async finalize(id: string, client: NinferClient): Promise<VideoJobRecord> {
    const record = this.records.get(id) as VideoJobRecord
    const paths = this.filePaths(record)
    await mkdir(this.dir, { recursive: true })
    const bytes = await downloadContent(client, id, { maxBytes: this.options.maxVideoBytes })
    await writeFile(`${paths.video}.part`, bytes)
    await rename(`${paths.video}.part`, paths.video)
    const next: VideoJobRecord = { ...record, videoFile: paths.video, videoBytes: bytes.byteLength, updatedAt: this.now(), completedAt: record.completedAt ?? this.now() }
    if (this.options.saveThumbnail) {
      try {
        const thumb = await downloadContent(client, id, { kind: 'thumbnail', maxBytes: 8 * 1024 * 1024 })
        await writeFile(`${paths.thumb}.part`, thumb)
        await rename(`${paths.thumb}.part`, paths.thumb)
        next.thumbFile = paths.thumb
      } catch (error) {
        this.log(`thumbnail for ${id} was not stored: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.records.set(id, next)
    await this.persist()
    if (this.options.afterComplete !== undefined) {
      try {
        const decorated = await this.options.afterComplete(next)
        if (decorated !== next) {
          this.records.set(id, decorated)
          await this.persist()
          return decorated
        }
      } catch (error) {
        this.log(`post-processing for ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return next
  }

  /** Wait up to `graceMs` for a job to finish; `timedOut` means it is still rendering. */
  async waitFor(id: string, graceMs: number, signal?: AbortSignal): Promise<{ record: VideoJobRecord; timedOut: boolean }> {
    const poll = this.attach(id, signal)
    if (graceMs <= 0) {
      void poll.catch(error => this.log(`background job ${id} stopped: ${error instanceof Error ? error.message : String(error)}`))
      return { record: this.records.get(id) as VideoJobRecord, timedOut: true }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), graceMs)
    })
    try {
      const result = await Promise.race([poll.then(() => 'done' as const), timeout])
      return { record: this.records.get(id) as VideoJobRecord, timedOut: result === 'timeout' }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Ask the server to stop, then mark the record cancelled. */
  async cancel(id: string): Promise<VideoJobRecord> {
    const record = this.records.get(id)
    if (record === undefined) throw new Error(`job ${id} is unknown to this host; video_status lists the ids it tracks.`)
    if (isTerminalStatus(record.status)) return record
    const client = await this.options.client()
    try {
      await cancelVideo(client, id)
    } catch (error) {
      const code = (error as { code?: string })?.code ?? ''
      if (code !== 'http_404' && code !== 'http_409') {
        throw new Error(`could not cancel ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const cancelled: VideoJobRecord = { ...record, status: 'cancelled', updatedAt: this.now(), completedAt: this.now(), stage: 'cancelled' }
    this.records.set(id, cancelled)
    await this.persist()
    return cancelled
  }

  /** Rewrite the history file, keeping the newest `history` records. */
  private async persist(): Promise<void> {
    const jobs = this.list(this.options.history)
    const payload = JSON.stringify({ version: 1, jobs })
    const file = join(this.dir, HISTORY_FILE)
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(`${file}.tmp`, payload)
      await rename(`${file}.tmp`, file)
    } catch (error) {
      this.log(`video job history could not be written: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
