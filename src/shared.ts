/** Values shared by the host fiber, its same-origin routes, and the browser toolview. */

/** Cordis row id of this plugin; also the settings storage key. Never rename after a release. */
export const VIDEO_GENERATION_ENTRY_ID = 'video-gen'

/** Settings namespace this plugin's generated form stores under. */
export const VIDEO_GENERATION_NAMESPACE = 'video-generation'

/** Same-origin route streaming one generated MP4; supports Range requests. */
export const VIDEO_ROUTE = '/plugins/dsh-video-gen/video'
/** Same-origin route serving the stored middle-frame JPEG. */
export const THUMB_ROUTE = '/plugins/dsh-video-gen/thumb'
/** Same-origin route listing recent jobs; the toolview polls it for live progress. */
export const JOBS_ROUTE = '/plugins/dsh-video-gen/jobs'
/** Same-origin route cancelling one queued or running job. */
export const CANCEL_ROUTE = '/plugins/dsh-video-gen/cancel'
/** Same-origin route probing Ninfer reachability and the stored token. */
export const TEST_CONNECTION_ROUTE = '/plugins/dsh-video-gen/test'
/** Non-secret settings capability probe, served even when the host cannot build a form. */
export const SETTINGS_HEALTH_ROUTE = '/plugins/dsh-video-gen/settings-health'

/** What the host's settings service can currently offer this plugin. */
export interface SettingsHealth {
  settings: 'unavailable' | 'legacy' | 'live'
  liveSchema: boolean
}

/** Every video backend this build can talk to. */
export const VIDEO_PROVIDERS = ['ninfer'] as const
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number]

/** Locale-neutral provider names for tool errors and status lines. */
export const PROVIDER_DISPLAY_NAMES: Record<VideoProvider, string> = {
  ninfer: 'Ninfer LTX-2.5',
}

/** Default Ninfer endpoint, model, and the credential reference its token lives under. */
export const DEFAULT_NINFER_BASE_URL = 'https://ninfer.neronexusai.com/v1'
export const DEFAULT_NINFER_MODEL = 'ltx-2.5'
export const NINFER_API_KEY_ENV = 'NINFER_API_KEY'

/** Clip length, frame rate, and prompt limits enforced by the API. */
export const MIN_SECONDS = 1
export const MAX_SECONDS = 30
export const DEFAULT_SECONDS = 5
export const MIN_FPS = 8
export const MAX_FPS = 50
export const DEFAULT_FPS = 24
export const MAX_PROMPT_CHARS = 8000

/** One start-frame picture per job, at most this big, in one of these formats. */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
export const REFERENCE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ReferenceMediaType = (typeof REFERENCE_MEDIA_TYPES)[number]

/** Named resolution tiers, with the pixel box the server snaps each one to. */
export const SIZE_TIERS: Record<string, { width: number; height: number }> = {
  '480p': { width: 896, height: 512 },
  '720p': { width: 1280, height: 704 },
  '1080p': { width: 1920, height: 1088 },
}
export const SIZE_TIER_VALUES = ['480p', '720p', '1080p'] as const
export const DEFAULT_SIZE = '720p'
/** The engine renders on a 64-pixel lattice and refuses anything above this box. */
export const SIZE_SNAP = 64
export const MIN_DIMENSION = 64
export const MAX_WIDTH = 1920
export const MAX_HEIGHT = 1088

export const ORIENTATIONS = ['landscape', 'portrait'] as const
export type Orientation = (typeof ORIENTATIONS)[number]

/** Poll cadence and job budgets. A queued job can legitimately sit for a while. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000
export const MAX_POLL_INTERVAL_MS = 30_000
export const DEFAULT_WAIT_GRACE_MS = 120_000
export const DEFAULT_JOB_TIMEOUT_MS = 3_600_000
export const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024
/** Request timeout for one control-plane call; the download has its own budget. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000

/** Workspace subfolder that receives copies of finished clips. */
export const DEFAULT_WORKSPACE_FOLDER = 'videos'
/** How many finished job records the store keeps on disk. */
export const DEFAULT_JOB_HISTORY = 50

/** Tool name families. `generic` owns the plain verbs; `ninfer` coexists with other video plugins. */
export const TOOL_NAME_SET_VALUES = ['generic', 'ninfer'] as const
export type ToolNameSet = (typeof TOOL_NAME_SET_VALUES)[number]
export const TOOL_NAME_SETS: Record<ToolNameSet, { generate: string; status: string; cancel: string }> = {
  generic: { generate: 'generate_video', status: 'check_video', cancel: 'cancel_video' },
  ninfer: { generate: 'ninfer_generate_video', status: 'ninfer_check_video', cancel: 'ninfer_cancel_video' },
}

/** How long the generate call holds the turn before handing back a job id. */
export const WAIT_MODES = ['auto', 'until_done', 'none'] as const
export type WaitMode = (typeof WAIT_MODES)[number]

/** Prompt-enhancer control. `default` defers to the configured default. */
export const ENHANCE_MODES = ['default', 'on', 'off'] as const
export type EnhanceMode = (typeof ENHANCE_MODES)[number]

/** Job status vocabulary: the API's four states plus local outcomes the API never reports. */
export const JOB_STATUSES = ['queued', 'in_progress', 'completed', 'failed', 'cancelled', 'interrupted'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

/** One video job as the store keeps it. Paths are absolute host paths. */
export interface VideoJobRecord {
  id: string
  provider: VideoProvider
  model: string
  prompt: string
  status: JobStatus
  progress: number
  stage?: string
  queuePosition?: number
  seconds: number
  size: string
  fps?: number
  seed?: number
  enhance: boolean
  negativePrompt?: string
  fromPicture: boolean
  createdAt: number
  updatedAt: number
  completedAt?: number
  videoFile?: string
  thumbFile?: string
  videoBytes?: number
  savedTo?: string
  thumbSavedTo?: string
  error?: string
  errorCode?: string
}

/** Browser-safe projection of a job record: no host paths, only file names. */
export interface VideoJobView {
  id: string
  model: string
  prompt: string
  status: JobStatus
  progress: number
  stage?: string
  queuePosition?: number
  seconds: number
  size: string
  seed?: number
  fromPicture: boolean
  createdAt: number
  updatedAt: number
  videoName?: string
  thumbName?: string
  error?: string
}

/** True when no further polling can change this job's state. */
export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

/** Clip length in whole seconds, falling back when the caller sent junk. */
export function clampSeconds(value: unknown, fallback: number = DEFAULT_SECONDS): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(parsed)))
}

/** Frame rate inside the engine's supported window. */
export function clampFps(value: unknown, fallback: number = DEFAULT_FPS): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(parsed)))
}

/** Parse an exact `WxH` string; undefined when it is not two positive integers. */
export function parseExactSize(raw: string): { width: number; height: number } | undefined {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(raw.trim())
  if (match === null) return undefined
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_DIMENSION || height < MIN_DIMENSION) return undefined
  return { width, height }
}

/**
 * Round each edge to the nearest 64-pixel step, then fit the box inside the
 * engine limits. The limits bind on the long edge (1920) and the short edge
 * (1088) separately, so a portrait box is not squeezed by the landscape cap.
 */
export function snapSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const scale = Math.min(1, MAX_WIDTH / long, MAX_HEIGHT / short)
  const snapped = (value: number): number => Math.max(MIN_DIMENSION, Math.round((value * scale) / SIZE_SNAP) * SIZE_SNAP)
  return { width: snapped(width), height: snapped(height) }
}

/** Orient a box so its long edge matches the requested orientation. */
export function orientSize(width: number, height: number, orientation: Orientation | undefined): { width: number; height: number } {
  if (orientation === undefined) return { width, height }
  const landscape = width >= height
  if (orientation === 'landscape' && !landscape) return { width: height, height: width }
  if (orientation === 'portrait' && landscape) return { width: height, height: width }
  return { width, height }
}

/**
 * Resolve the caller's `size` request into the exact pixel box sent upstream.
 * Accepts a tier name or `WxH`; `orientation` flips the box rather than
 * overriding an explicit `WxH`'s own aspect ratio.
 */
export function normalizeVideoSize(size: string | undefined, orientation?: Orientation, fallback: string = DEFAULT_SIZE): string {
  const requested = (size ?? fallback).trim()
  const tier = SIZE_TIERS[requested.toLowerCase()]
  const base = tier ?? parseExactSize(requested)
  if (base === undefined) {
    throw new Error(`video size "${requested}" is not understood: use 480p, 720p, 1080p, or an exact WxH such as 1280x704`)
  }
  const oriented = orientSize(base.width, base.height, orientation)
  const snapped = snapSize(oriented.width, oriented.height)
  return `${String(snapped.width)}x${String(snapped.height)}`
}

/** Pick the 720p box oriented like the start-frame picture. */
const LANDSCAPE_BOX = { width: 1280, height: 704 }
const PORTRAIT_BOX = { width: 704, height: 1280 }

/** Pick the tier whose aspect ratio is closest to the start-frame picture's. */
export function sizeFromReference(width: number, height: number, size: string | undefined, orientation: Orientation | undefined, fallback: string = DEFAULT_SIZE): string {
  if (size !== undefined && size.trim() !== '') return normalizeVideoSize(size, orientation, fallback)
  if (!(width > 0) || !(height > 0)) return normalizeVideoSize(undefined, orientation, fallback)
  const base = width >= height ? LANDSCAPE_BOX : PORTRAIT_BOX
  const oriented = orientSize(base.width, base.height, orientation ?? (width >= height ? 'landscape' : 'portrait'))
  const snapped = snapSize(oriented.width, oriented.height)
  return `${String(snapped.width)}x${String(snapped.height)}`
}

/**
 * Sortable, collision-free stem for one clip: `video-<utc-stamp>-<job suffix>`.
 * The job id is server-generated and unique, so the suffix alone keeps names
 * stable across restarts and re-downloads.
 */
export function videoFileStem(record: { id: string; createdAt?: number }, now: number = Date.now()): string {
  const stamp = new Date(record.createdAt ?? now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const suffix = record.id.replace(/^video_/, '').slice(-8)
  return `video-${stamp}-${suffix}`
}

/** Whitespace- and case-folded prompt text, for matching a tool call to a job. */
export function foldPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** True when a job's prompt is the call's prompt (exact, or one truncated by the wire). */
export function jobMatchesPrompt(record: { prompt: string }, prompt: string): boolean {
  const job = foldPrompt(record.prompt)
  const call = foldPrompt(prompt)
  if (job.length === 0 || call.length === 0) return false
  return job === call || job.startsWith(call.slice(0, 120)) || call.startsWith(job.slice(0, 120))
}

/**
 * Attribute a running tool call to one job record so the toolview can show its
 * progress. A prompt match wins; otherwise a single unambiguous active job is
 * used, and anything more ambiguous renders no progress rather than the wrong
 * clip's numbers.
 */
export function selectJobForCall<T extends { id: string; prompt: string; status: JobStatus; createdAt: number }>(
  jobs: readonly T[],
  prompt: string,
): T | undefined {
  const active = jobs.filter(job => !isTerminalStatus(job.status)).sort((a, b) => b.createdAt - a.createdAt)
  if (active.length === 0) return undefined
  const matched = active.filter(job => jobMatchesPrompt(job, prompt))
  if (matched.length > 0) return matched[0]
  return active.length === 1 ? active[0] : undefined
}

/** Compact `m:ss`/`s s` rendering for elapsed budgets shown in tool output. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${String(minutes)}m${String(seconds).padStart(2, '0')}s` : `${String(seconds)}s`
}

/** Sanitize a server-supplied file name for one path segment. */
export function safeFileName(raw: string): string {
  const base = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\.\.+?/g, '').trim()
  return base.length === 0 ? 'video.mp4' : base.slice(0, 120)
}
