/** Bundle configuration: a list of user-supplied video endpoints. */
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_FPS,
  DEFAULT_JOB_HISTORY,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SECONDS,
  DEFAULT_SIZE,
  DEFAULT_WORKSPACE_FOLDER,
  MAX_FPS,
  MAX_POLL_INTERVAL_MS,
  MAX_SECONDS,
  MIN_FPS,
  ORIENTATIONS,
  TOOL_NAME_SET_VALUES,
  defaultKeyRef,
  type Orientation,
  type ToolNameSet,
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

/**
 * One user-supplied video endpoint. The API it must speak is the OpenAI-style
 * asynchronous video API (`POST /videos`, `GET /videos/{id}`, `GET
 * /videos/{id}/content`), which is what the harness renders, not a vendor.
 */
export interface VideoConnection {
  /** Stable id; also the credential-key segment when no ref is given. */
  id: string
  label?: string
  /** API root including its version prefix, e.g. `https://host/v1`. */
  baseUrl: string
  /** Model id sent with each job. */
  model: string
  /** Credential reference the bearer token resolves through. */
  apiKeyRef?: string
  /** Per-endpoint overrides of the global defaults. */
  seconds?: number
  size?: string
  fps?: number
  orientation?: Orientation
  enhance?: boolean
}

export interface Config {
  /**
   * Deprecated: kept so an existing `cordis.patch.yml` row still validates.
   * The endpoint shape is always the OpenAI-style video API.
   */
  provider?: string
  /** Endpoints the user configured in Settings. Empty out of the box. */
  connections?: VideoConnection[]
  /** Id of the connection tool calls use; empty means the first one. */
  activeConnection?: string
  /**
   * Single-endpoint fallback for a config-only setup, used when `connections`
   * is empty. Blank means no endpoint at all, which is the shipped state:
   * nothing here names a vendor.
   */
  baseUrl?: string
  model?: string
  /** Credential reference for the fallback endpoint. */
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
  /** How long `generate_video` waits before handing back a job id. */
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
  /** `generic` claims the verb family; `ninfer` prefixes every tool name. */
  toolNameSet?: ToolNameSet
}

// The schema of one endpoint row. Its fields are deliberately NOT volatile:
// schemastery allows volatile only on a fixed object path, so the enclosing
// `connections` array carries the live box and every row travels with it.
const CONNECTION_SCHEMA = z.object({
  id: z.string().default(''),
  label: z.string().default(''),
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  apiKeyRef: z.string().default(''),
  seconds: z.number().min(1).max(MAX_SECONDS),
  size: z.string().default(''),
  fps: z.number().min(MIN_FPS).max(MAX_FPS),
  orientation: z.union(ORIENTATIONS),
  enhance: z.boolean(),
})

export const Config = z.object({
  provider: volatile(z.string().default('custom')),
  connections: volatile(z.array(CONNECTION_SCHEMA).default([])),
  activeConnection: volatile(z.string().default('')),
  baseUrl: volatile(z.string().default('')),
  model: volatile(z.string().default('')),
  apiKeyRef: volatile(z.string().default('')),
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

/** One configured endpoint with its defaults already merged. */
export interface VideoTarget {
  connectionId: string
  label: string
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

/** Settings-page guidance shared by every "nothing configured" error. */
export const NO_ENDPOINT_HINT = 'Add one in Settings > Plugins > Video generation: base URL, API key, and model. The endpoint must speak the OpenAI-style video API (POST /videos).'

/** Keep only usable connections and trim their fields. */
export function usableConnections(config: Config): VideoConnection[] {
  const rows: VideoConnection[] = []
  for (const raw of config.connections ?? []) {
    const baseUrl = (raw.baseUrl ?? '').trim()
    if (baseUrl.length === 0) continue
    const id = (raw.id ?? '').trim() || baseUrl
    rows.push({
      id,
      ...((raw.label ?? '').trim() === '' ? {} : { label: (raw.label ?? '').trim() }),
      baseUrl,
      model: (raw.model ?? '').trim(),
      ...((raw.apiKeyRef ?? '').trim() === '' ? {} : { apiKeyRef: (raw.apiKeyRef ?? '').trim() }),
      ...(raw.seconds === undefined ? {} : { seconds: raw.seconds }),
      ...((raw.size ?? '').trim() === '' ? {} : { size: (raw.size ?? '').trim() }),
      ...(raw.fps === undefined ? {} : { fps: raw.fps }),
      ...(raw.orientation === undefined ? {} : { orientation: raw.orientation }),
      ...(raw.enhance === undefined ? {} : { enhance: raw.enhance }),
    })
  }
  // The config-only fallback still works for a hand-written cordis.patch.yml.
  const legacyUrl = (config.baseUrl ?? '').trim()
  if (rows.length === 0 && legacyUrl.length > 0) {
    rows.push({
      id: 'default',
      label: 'Configured endpoint',
      baseUrl: legacyUrl,
      model: (config.model ?? '').trim(),
      ...((config.apiKeyRef ?? '').trim() === '' ? {} : { apiKeyRef: (config.apiKeyRef ?? '').trim() }),
    })
  }
  return rows
}

/** Normalize and validate one API root. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`unsupported protocol ${parsed.protocol}`)
  } catch {
    throw new Error(`the video API base URL "${raw}" is not a valid http(s) URL; include the version prefix, for example https://host/v1.`)
  }
  return trimmed
}

/** Credential reference that belongs to one connection. */
export function connectionKeyRef(connection: Pick<VideoConnection, 'id' | 'apiKeyRef'>): string {
  const explicit = (connection.apiKeyRef ?? '').trim()
  return explicit.length > 0 ? explicit : `VIDEO_GEN_KEY_${defaultKeyRef(connection.id)}`
}

/**
 * Resolve the endpoint a tool call should use.
 *
 * Throws with settings guidance when nothing is configured: the plugin ships
 * without a vendor, so the first thing a new user sees must be the fix, not a
 * request to a host they never chose.
 */
export function resolveVideoTarget(config: Config, connectionId?: string, modelOverride?: string): VideoTarget {
  const rows = usableConnections(config)
  if (rows.length === 0) throw new Error(`No video endpoint is configured. ${NO_ENDPOINT_HINT}`)
  const wanted = (connectionId ?? config.activeConnection ?? '').trim()
  const picked = (wanted.length === 0 ? rows[0] : rows.find(row => row.id === wanted) ?? rows[0])
  if (picked === undefined) throw new Error(`No video endpoint is configured. ${NO_ENDPOINT_HINT}`)
  const baseURL = normalizeBaseUrl(picked.baseUrl)
  const model = (modelOverride ?? picked.model ?? '').trim()
  if (model.length === 0) {
    throw new Error(`The video endpoint "${picked.label ?? picked.id}" has no model id. Fetch the model list on that settings row, or type the model name.`)
  }
  const orientation = picked.orientation ?? config.defaultOrientation
  return {
    connectionId: picked.id,
    label: picked.label ?? picked.id,
    baseURL,
    model,
    keyRef: connectionKeyRef(picked),
    defaultSeconds: picked.seconds ?? config.defaultSeconds ?? DEFAULT_SECONDS,
    defaultSize: (picked.size ?? '').trim() || (config.defaultSize ?? DEFAULT_SIZE).trim() || DEFAULT_SIZE,
    defaultFps: picked.fps ?? config.defaultFps ?? DEFAULT_FPS,
    ...(orientation === undefined ? {} : { defaultOrientation: orientation }),
    defaultEnhance: picked.enhance ?? config.defaultEnhance ?? false,
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
  return config.toolNameSet === 'ninfer'
    ? { generate: 'ninfer_generate_video', status: 'ninfer_check_video', cancel: 'ninfer_cancel_video' }
    : { generate: 'generate_video', status: 'check_video', cancel: 'cancel_video' }
}
