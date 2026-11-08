/** Bundle configuration for the Ninfer video backend. */
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_FPS,
  DEFAULT_JOB_HISTORY,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_NINFER_BASE_URL,
  DEFAULT_NINFER_MODEL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SECONDS,
  DEFAULT_SIZE,
  DEFAULT_WORKSPACE_FOLDER,
  MAX_FPS,
  MAX_POLL_INTERVAL_MS,
  MAX_SECONDS,
  MIN_FPS,
  NINFER_API_KEY_ENV,
  ORIENTATIONS,
  TOOL_NAME_SET_VALUES,
  VIDEO_GENERATION_ENTRY_ID,
  VIDEO_PROVIDERS,
  type Orientation,
  type ToolNameSet,
  type VideoProvider,
} from './shared.js'

/**
 * Mark a schema field live for DSH 0.1.7+: the host serves a plugin's settings
 * form only for `.volatile()` fields and hands `apply` a `Volatile` box per
 * field (unwrapped at the entry). Hosts at or below 0.1.6 ship a schemastery
 * without the method, so marking is conditional; an unmarked schema stays
 * plain there and the old settings relay keeps working.
 */
function volatile<T extends z>(schema: T): T {
  const mark = (schema as unknown as { volatile?: () => T }).volatile
  return typeof mark === 'function' ? mark.call(schema) : schema
}

/** Cordis configuration schema; the plain type is `Config`. */
export interface Config {
  provider?: VideoProvider
  /** Video API root, including the `/v1` prefix. */
  baseUrl?: string
  /** Video model id served by that root; `ltx-2.5` is the current one. */
  model?: string
  /** Credential reference the bearer token is resolved through. */
  apiKeyRef?: string
  defaultSeconds?: number
  /** Tier name (`480p`/`720p`/`1080p`) or exact `WxH`. */
  defaultSize?: string
  defaultOrientation?: Orientation
  defaultFps?: number
  /** Ask the server's prompt enhancer before rendering (adds 1-2 minutes). */
  defaultEnhance?: boolean
  /** Negative prompt merged into every job unless the call passes its own. */
  negativePrompt?: string
  pollIntervalMs?: number
  /** How long `video_generate` waits before handing back a job id. */
  waitGraceMs?: number
  /** Overall budget for one job before it is abandoned as timed out. */
  jobTimeoutMs?: number
  /** Refuse a download larger than this many bytes. */
  maxVideoBytes?: number
  /** Also copy finished clips into the session workspace. */
  saveToWorkspace?: boolean
  /** Workspace subfolder receiving the copies; empty means the workspace root. */
  workspaceFolder?: string
  /** Canonical clip directory override; empty keeps the DSH_HOME default. */
  videosDir?: string
  /** Fetch and store the server's middle-frame JPEG next to each clip. */
  saveThumbnail?: boolean
  /** Re-attach to jobs that were still running when the host last stopped. */
  resumeJobs?: boolean
  /** Finished job records kept in the on-disk history. */
  jobHistory?: number
  /** `generic` claims video_generate; `ninfer` keeps both video plugins usable. */
  toolNameSet?: ToolNameSet
}

export const Config = z.object({
  provider: volatile(z.union(VIDEO_PROVIDERS).default('ninfer')),
  baseUrl: volatile(z.string().default(DEFAULT_NINFER_BASE_URL)),
  model: volatile(z.string().default(DEFAULT_NINFER_MODEL)),
  apiKeyRef: volatile(z.string().default(NINFER_API_KEY_ENV)),
  defaultSeconds: volatile(z.number().min(1).max(MAX_SECONDS).default(DEFAULT_SECONDS)),
  defaultSize: volatile(z.string().default(DEFAULT_SIZE)),
  defaultOrientation: volatile(z.union(ORIENTATIONS)),
  defaultFps: volatile(z.number().min(MIN_FPS).max(MAX_FPS).default(DEFAULT_FPS)),
  defaultEnhance: volatile(z.boolean().default(false)),
  negativePrompt: volatile(z.string().default('')),
  pollIntervalMs: volatile(z.number().min(1_000).max(MAX_POLL_INTERVAL_MS).default(DEFAULT_POLL_INTERVAL_MS)),
  waitGraceMs: volatile(z.number().min(0).max(1_800_000).default(120_000)),
  jobTimeoutMs: volatile(z.number().min(60_000).max(6 * 3_600_000).default(DEFAULT_JOB_TIMEOUT_MS)),
  maxVideoBytes: volatile(z.number().min(1_048_576).default(DEFAULT_MAX_VIDEO_BYTES)),
  saveToWorkspace: volatile(z.boolean().default(true)),
  workspaceFolder: volatile(z.string().default(DEFAULT_WORKSPACE_FOLDER)),
  videosDir: volatile(z.string().default('')),
  saveThumbnail: volatile(z.boolean().default(true)),
  resumeJobs: volatile(z.boolean().default(true)),
  jobHistory: volatile(z.number().min(5).max(500).default(DEFAULT_JOB_HISTORY)),
  toolNameSet: volatile(z.union(TOOL_NAME_SET_VALUES).default('generic')),
}) as unknown as z<Config>

/** Fully resolved video backend profile for one tool call. */
export interface VideoTarget {
  provider: VideoProvider
  baseURL: string
  model: string
  keyRef: string
  defaultSeconds: number
  defaultSize: string
  defaultFps: number
  defaultOrientation?: Orientation
  defaultEnhance: boolean
  negativePrompt?: string
  pollIntervalMs: number
  waitGraceMs: number
  jobTimeoutMs: number
  maxVideoBytes: number
  saveThumbnail: boolean
}

/** Resolve the configured backend, refusing an empty endpoint with a fix hint. */
export function resolveVideoTarget(config: Config): VideoTarget {
  const baseURL = (config.baseUrl ?? DEFAULT_NINFER_BASE_URL).trim().replace(/\/+$/, '')
  if (baseURL.length === 0) {
    throw new Error('Ninfer video provider requires an API base URL; set it in Settings > Plugins > Video generation.')
  }
  try {
    const parsed = new URL(baseURL)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`unsupported protocol ${parsed.protocol}`)
    }
  } catch {
    throw new Error(`Ninfer video base URL "${config.baseUrl ?? ''}" is not a valid http(s) URL; set it in Settings > Plugins > Video generation.`)
  }
  const model = (config.model ?? DEFAULT_NINFER_MODEL).trim()
  if (model.length === 0) {
    throw new Error('Ninfer video provider requires a model id (GET /v1/models lists what the server serves); set it in Settings > Plugins > Video generation.')
  }
  return {
    provider: config.provider ?? 'ninfer',
    baseURL,
    model,
    keyRef: (config.apiKeyRef ?? NINFER_API_KEY_ENV).trim() || NINFER_API_KEY_ENV,
    defaultSeconds: config.defaultSeconds ?? DEFAULT_SECONDS,
    defaultSize: (config.defaultSize ?? DEFAULT_SIZE).trim() || DEFAULT_SIZE,
    defaultFps: config.defaultFps ?? DEFAULT_FPS,
    ...(config.defaultOrientation === undefined ? {} : { defaultOrientation: config.defaultOrientation }),
    defaultEnhance: config.defaultEnhance ?? false,
    ...(typeof config.negativePrompt === 'string' && config.negativePrompt.trim().length > 0
      ? { negativePrompt: config.negativePrompt.trim() }
      : {}),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    waitGraceMs: config.waitGraceMs ?? 120_000,
    jobTimeoutMs: config.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    maxVideoBytes: config.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES,
    saveThumbnail: config.saveThumbnail ?? true,
  }
}

/** Tool names this build registers. */
export function toolNames(config: Config): { generate: string; status: string; cancel: string } {
  const set = config.toolNameSet === 'ninfer' ? 'ninfer' : 'generic'
  return set === 'ninfer'
    ? { generate: 'ninfer_video_generate', status: 'ninfer_video_status', cancel: 'ninfer_video_cancel' }
    : { generate: 'video_generate', status: 'video_status', cancel: 'video_cancel' }
}

/** Apply a per-call model override on top of the saved config. */
export function withVideoModelOverride(config: Config, model?: string): Config {
  const trimmed = model?.trim() ?? ''
  return trimmed.length === 0 ? config : { ...config, model: trimmed }
}
