/**
 * Client for the OpenAI-style asynchronous video API.
 *
 * The shape is what this plugin renders, not a vendor: `POST /videos` queues a
 * job, `GET /videos/{id}` is polled until the status leaves `queued`/
 * `in_progress`, and `GET /videos/{id}/content` streams the finished MP4. A
 * start-frame picture travels as the multipart `input_reference` field (or a
 * data URL in JSON mode) and becomes the clip's first frame.
 */
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_FPS,
  MAX_POLL_INTERVAL_MS,
  MAX_PROMPT_CHARS,
  MAX_SECONDS,
  MAX_WIDTH,
  MIN_FPS,
  MIN_SECONDS,
  type Orientation,
} from './shared.js'

/** Every control-plane call goes through this shape so tests can substitute it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** One video job as reported by the server, decoded defensively. */
export interface RemoteVideoJob {
  id: string
  status: string
  progress?: number
  stage?: string
  queuePosition?: number
  seconds?: number
  size?: string
  fps?: number
  seed?: number
  model?: string
  prompt?: string
  fromPicture?: boolean
  file?: string
  thumb?: string
  error?: { code?: string; message?: string }
  timing?: Record<string, number>
  createdAt?: number
}

/** A job that was created from a start-frame picture. */
export interface ReferenceImage {
  data: Uint8Array
  mediaType: string
  name: string
}

/** One API failure with the fix already spelled out for the reader. */
export class VideoApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly retryable: boolean) {
    super(message)
    this.name = 'VideoApiError'
  }
}

export interface VideoApiClient {
  baseURL: string
  token: string
  fetchFn: FetchLike
}

/** Host name of an endpoint, for messages that must name who refused. */
export function endpointLabel(baseURL: string): string {
  try {
    return new URL(baseURL).host
  } catch {
    return baseURL
  }
}

/** Build a client; the base URL must already be trimmed of trailing slashes. */
export function createClient(options: { baseURL: string; token: string; fetchFn?: FetchLike }): VideoApiClient {
  const baseURL = options.baseURL.trim().replace(/\/+$/, '')
  const token = options.token.trim()
  if (baseURL.length === 0) throw new VideoApiError('the video client needs a base URL.', 0, 'invalid_base_url', false)
  if (token.length === 0) throw new VideoApiError('the video client needs a bearer token.', 401, 'no_token', false)
  return { baseURL, token, fetchFn: options.fetchFn ?? ((input, init) => fetch(input, init)) }
}

/** Link an optional external abort to a hard per-call deadline. */
function deadline(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const timer = setTimeout(() => abort(new Error(`request timed out after ${String(timeoutMs)}ms`)), timeoutMs)
  const onAbort = (): void => abort(signal?.reason ?? new Error('aborted'))
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Explain one non-2xx response, mapping the documented codes to actions the
 * reader can take without reading this file.
 */
export async function toVideoApiError(response: Response, context: string): Promise<VideoApiError> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const errorRecord = typeof record.error === 'object' && record.error !== null ? record.error as Record<string, unknown> : record
  const serverCode = typeof errorRecord.code === 'string' ? errorRecord.code : ''
  const serverMessage = typeof errorRecord.message === 'string' ? errorRecord.message : ''
  const mapped = mapFailure(response.status, serverCode, serverMessage, context)
  return new VideoApiError(mapped.message, response.status, serverCode.length > 0 ? serverCode : `http_${String(response.status)}`, mapped.retryable)
}

/** Pure status/code → message mapping; every branch is covered by tests. */
export function mapFailure(status: number, code: string, message: string, context: string): { message: string; retryable: boolean } {
  const detail = message.length > 0 ? ` (${message})` : ''
  if (status === 401 || status === 403) {
    return { message: `${context}: the endpoint rejected the bearer token${detail}. Save the token for the endpoint's credential in Settings > Plugins > Video generation.`, retryable: false }
  }
  if (status === 400) {
    return { message: `${context}: the endpoint rejected the request${detail}. Check prompt, seconds (1-30), size, and fps (8-50).`, retryable: false }
  }
  if (status === 404 && code === 'model_not_found') {
    return { message: `${context}: the endpoint does not serve this model${detail}. Fetch the model list on the settings row and pick one of its ids.`, retryable: false }
  }
  if (status === 404) {
    return { message: `${context}: this job id is unknown to the endpoint${detail}. Servers forget jobs on restart, so submit the clip again.`, retryable: false }
  }
  if (status === 409) {
    return { message: `${context}: the clip is not ready to download yet${detail}. Poll the job until status is completed, then fetch /content again.`, retryable: true }
  }
  if (status === 413) {
    return { message: `${context}: the start-frame picture is too large${detail}. This plugin sends one PNG/JPEG/WebP under 20 MB — downscale it or crop to the frame you want to animate.`, retryable: false }
  }
  if (status === 503) {
    return { message: `${context}: the video engine behind this endpoint is unavailable${detail}. The server operator must enable it (codes: disabled, engine_missing, models_missing).`, retryable: true }
  }
  if (status >= 500) {
    return { message: `${context}: the endpoint returned HTTP ${String(status)}${detail}. The server may still be loading its video engine; retry shortly.`, retryable: true }
  }
  return { message: `${context}: the endpoint returned HTTP ${String(status)}${detail}.`, retryable: false }
}

/** Translate a failed job's `error.code` into an instruction the agent can act on. */
export function describeJobFailure(code: string | undefined, message: string | undefined, job: { seconds?: number; size?: string }): string {
  const detail = message ?? 'no message from the server'
  switch (code) {
    case 'models_missing':
      return `the endpoint has no video model loaded (${detail}); load one server-side, then retry.`
    case 'engine_refused':
      return `the endpoint's engine refused the job (${detail}); retry with a shorter clip or a smaller size.`
    case 'engine_error':
      return `the endpoint's engine failed while rendering (${detail}); simplify the prompt or lower the resolution and retry.`
    case 'timeout':
      return `the endpoint timed out rendering this clip (${detail}); retry with fewer seconds or a lower size.`
    case 'cancelled':
      return `the job was cancelled on the server${detail === undefined ? '' : ` (${detail})`}.`
    case 'no_video':
      return `the endpoint produced no video frames for this prompt (${detail}); describe visible motion and sound, then retry.`
    case 'runner_failed':
      return `the endpoint's render runner crashed (${detail}); retry once, then report it to the operator.`
    case 'internal':
      return `the endpoint reported an internal error (${detail}); retry once.`
    default:
      return `the job failed${code === undefined ? '' : ` with code ${code}`}: ${detail}${job.seconds === undefined ? '' : ` (asked for ${String(job.seconds)}s`}${job.size === undefined ? '' : ` at ${job.size})`}.`
  }
}

/** JSON body for `POST /videos`; validation happens here, not on the wire. */
export function buildCreateBody(request: {
  model: string
  prompt: string
  seconds?: number
  size?: string
  orientation?: Orientation
  fps?: number
  seed?: number
  enhance?: boolean
  negativePrompt?: string
  referenceDataUrl?: string
}): Record<string, unknown> {
  const prompt = request.prompt.trim()
  if (prompt.length === 0) throw new Error('video generation needs a non-empty prompt describing the motion and the sound.')
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`video prompt is ${String(prompt.length)} characters; this endpoint's documented limit is ${String(MAX_PROMPT_CHARS)} — shorten the shot description.`)
  }
  const seconds = request.seconds ?? 5
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    throw new Error(`seconds must be a whole number between ${String(MIN_SECONDS)} and ${String(MAX_SECONDS)} (got ${String(request.seconds)}).`)
  }
  const body: Record<string, unknown> = { model: request.model, prompt, seconds: String(Math.round(seconds)) }
  if (request.size !== undefined) body.size = request.size
  if (request.orientation !== undefined) body.orientation = request.orientation
  if (request.fps !== undefined) {
    if (!Number.isFinite(request.fps) || request.fps < MIN_FPS || request.fps > MAX_FPS) {
      throw new Error(`fps must be between ${String(MIN_FPS)} and ${String(MAX_FPS)} (got ${String(request.fps)}).`)
    }
    body.fps = Math.round(request.fps)
  }
  if (request.seed !== undefined) {
    if (!Number.isInteger(request.seed)) throw new Error(`seed must be an integer (got ${String(request.seed)}).`)
    body.seed = request.seed
  }
  if (request.enhance !== undefined) body.enhance = request.enhance
  const negative = request.negativePrompt?.trim() ?? ''
  if (negative.length > 0) body.negative_prompt = negative
  if (request.referenceDataUrl !== undefined) body.input_reference = request.referenceDataUrl
  return body
}

/** Multipart form carrying the start-frame picture as `input_reference`. */
export function buildReferenceForm(body: Record<string, unknown>, reference: ReferenceImage, FormDataImpl?: typeof FormData): FormData {
  const Impl = FormDataImpl ?? FormData
  const form = new Impl()
  for (const [key, value] of Object.entries(body)) {
    if (key === 'input_reference') continue
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const blob = new Blob([reference.data as unknown as ArrayBuffer], { type: reference.mediaType })
  form.append('input_reference', blob, reference.name)
  return form
}

/** `data:` URL form of the start frame, for JSON submissions. */
export function referenceDataUrl(reference: ReferenceImage): string {
  return `data:${reference.mediaType};base64,${Buffer.from(reference.data).toString('base64')}`
}

function decodeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function decodeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Decode one job payload; a payload without an id is not a job. */
export function parseJob(payload: unknown): RemoteVideoJob {
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const id = typeof record.id === 'string' ? record.id : ''
  if (id.length === 0) throw new VideoApiError('the endpoint replied without a job id.', 502, 'invalid_job', true)
  const errorRecord = typeof record.error === 'object' && record.error !== null ? record.error as Record<string, unknown> : undefined
  const timingRecord = typeof record.timing === 'object' && record.timing !== null ? record.timing as Record<string, unknown> : undefined
  const timing: Record<string, number> = {}
  for (const [key, value] of Object.entries(timingRecord ?? {})) {
    const number = decodeNumber(value)
    if (number !== undefined) timing[key] = number
  }
  const createdAt = decodeNumber(record.created_at)
  const job: RemoteVideoJob = {
    id,
    status: typeof record.status === 'string' ? record.status : 'queued',
    progress: decodeNumber(record.progress) ?? 0,
  }
  const stage = typeof record.stage === 'string' ? record.stage : undefined
  if (stage !== undefined) job.stage = stage
  const queuePosition = decodeNumber(record.queue_position)
  if (queuePosition !== undefined) job.queuePosition = queuePosition
  const seconds = decodeNumber(record.seconds)
  if (seconds !== undefined) job.seconds = seconds
  const size = typeof record.size === 'string' ? record.size : undefined
  if (size !== undefined) job.size = size
  const fps = decodeNumber(record.fps)
  if (fps !== undefined) job.fps = fps
  const seed = decodeNumber(record.seed)
  if (seed !== undefined) job.seed = seed
  const model = typeof record.model === 'string' ? record.model : undefined
  if (model !== undefined) job.model = model
  const prompt = typeof record.prompt === 'string' ? record.prompt : undefined
  if (prompt !== undefined) job.prompt = prompt
  const fromPicture = decodeBoolean(record.from_picture) ?? decodeBoolean(record.from_image)
  if (fromPicture !== undefined) job.fromPicture = fromPicture
  const file = typeof record.file === 'string' ? record.file : undefined
  if (file !== undefined) job.file = file
  const thumb = typeof record.thumb === 'string' ? record.thumb : undefined
  if (thumb !== undefined) job.thumb = thumb
  if (errorRecord !== undefined) {
    const code = typeof errorRecord.code === 'string' ? errorRecord.code : undefined
    const message = typeof errorRecord.message === 'string' ? errorRecord.message : undefined
    job.error = { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) }
  }
  if (Object.keys(timing).length > 0) job.timing = timing
  if (createdAt !== undefined) job.createdAt = createdAt
  return job
}

/** Low-level JSON call: attaches the bearer token and maps every failure. */
async function requestJson(client: VideoApiClient, method: string, path: string, options: {
  body?: unknown
  form?: FormData
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<unknown> {
  const timer = deadline(options.signal, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  const headers: Record<string, string> = { authorization: `Bearer ${client.token}`, accept: 'application/json' }
  let payload: BodyInit | undefined
  if (options.form !== undefined) {
    payload = options.form
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body)
    headers['content-type'] = 'application/json'
  }
  const init: RequestInit = { method, headers, signal: timer.signal, ...(payload === undefined ? {} : { body: payload }) }
  let response: Response
  try {
    response = await client.fetchFn(client.baseURL + path, init)
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    throw new VideoApiError(`${method} ${path} could not reach ${endpointLabel(client.baseURL)}: ${error instanceof Error ? error.message : String(error)}`, 0, 'network', true)
  } finally {
    timer.dispose()
  }
  if (!response.ok) throw await toVideoApiError(response, `${method} ${path}`)
  const text = await response.text()
  if (text.length === 0) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new VideoApiError(`${method} ${path} returned a body that is not JSON.`, 502, 'invalid_json', true)
  }
}

/** Queue one clip. A start frame travels as multipart; otherwise the JSON body is used. */
export async function createVideo(client: VideoApiClient, request: Parameters<typeof buildCreateBody>[0], options: {
  reference?: ReferenceImage
  signal?: AbortSignal
  FormDataImpl?: typeof FormData
} = {}): Promise<RemoteVideoJob> {
  const body = buildCreateBody(options.reference === undefined
    ? request
    : { ...request, referenceDataUrl: referenceDataUrl(options.reference) })
  const form = options.reference === undefined
    ? undefined
    : buildReferenceForm(body, options.reference, options.FormDataImpl)
  const payload = await requestJson(client, 'POST', '/videos', {
    ...(form === undefined ? { body } : { form }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  return parseJob(payload)
}

/** Read one job's current state. */
export async function getVideo(client: VideoApiClient, id: string, signal?: AbortSignal): Promise<RemoteVideoJob> {
  return parseJob(await requestJson(client, 'GET', `/videos/${encodeURIComponent(id)}`, { ...(signal === undefined ? {} : { signal }) }))
}

/** Most recent jobs the server still knows about. */
export async function listVideos(client: VideoApiClient, limit: number = 20, signal?: AbortSignal): Promise<RemoteVideoJob[]> {
  const payload = await requestJson(client, 'GET', `/videos?limit=${String(Math.max(1, Math.min(100, Math.round(limit))))}`, { ...(signal === undefined ? {} : { signal }) })
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const data = Array.isArray(record.data) ? record.data : []
  return data.map(item => parseJob(item))
}

/** Cancel a queued or running job; a finished one is a no-op upstream. */
export async function cancelVideo(client: VideoApiClient, id: string, signal?: AbortSignal): Promise<void> {
  await requestJson(client, 'DELETE', `/videos/${encodeURIComponent(id)}`, { ...(signal === undefined ? {} : { signal }) })
}

/** Model ids the server reports, filtered to the video kind when it labels them. */
export async function getModels(client: VideoApiClient, signal?: AbortSignal): Promise<string[]> {
  const payload = await requestJson(client, 'GET', '/models', { ...(signal === undefined ? {} : { signal }) })
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const data = Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : []
  const models: string[] = []
  for (const item of data) {
    const entry = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    const id = typeof entry.id === 'string' ? entry.id : typeof item === 'string' ? item : ''
    if (id.length === 0) continue
    const kind = typeof entry.type === 'string' ? entry.type : typeof entry.kind === 'string' ? entry.kind : ''
    if (kind.length > 0 && kind !== 'video') continue
    models.push(id)
  }
  return models
}

/** Fetch one clip's bytes; `thumbnail` asks for the server's middle-frame JPEG. */
export async function downloadContent(client: VideoApiClient, id: string, options: {
  kind?: 'video' | 'thumbnail'
  maxBytes: number
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<Uint8Array> {
  const kind = options.kind ?? 'video'
  const path = `/videos/${encodeURIComponent(id)}/content${kind === 'thumbnail' ? '?variant=thumbnail' : ''}`
  const timer = deadline(options.signal, options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS)
  let response: Response
  try {
    response = await client.fetchFn(client.baseURL + path, {
      method: 'GET',
      headers: { authorization: `Bearer ${client.token}`, accept: kind === 'thumbnail' ? 'image/jpeg' : 'video/mp4' },
      signal: timer.signal,
    })
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    throw new VideoApiError(`GET ${path} could not reach ${endpointLabel(client.baseURL)}: ${error instanceof Error ? error.message : String(error)}`, 0, 'network', true)
  } finally {
    timer.dispose()
  }
  if (!response.ok) throw await toVideoApiError(response, `GET ${path}`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new VideoApiError(`GET ${path}: the clip is ${String(Math.round(declared / 1_048_576))} MB, over the configured ${String(Math.round(options.maxBytes / 1_048_576))} MB limit. Lower size or seconds in Settings > Plugins > Video generation.`, 413, 'too_large', false)
  }
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength === 0) throw new VideoApiError(`GET ${path}: the endpoint returned an empty body.`, 502, 'empty_body', true)
  if (data.byteLength > options.maxBytes) {
    throw new VideoApiError(`GET ${path}: the clip is ${String(Math.round(data.byteLength / 1_048_576))} MB, over the configured ${String(Math.round(options.maxBytes / 1_048_576))} MB limit.`, 413, 'too_large', false)
  }
  return data
}

/** Backoff between polls: steady for the first attempts, capped while errors repeat. */
export function pollDelay(attempt: number, intervalMs: number): number {
  if (attempt <= 0) return intervalMs
  return Math.min(MAX_POLL_INTERVAL_MS, intervalMs * 2 ** Math.min(3, attempt))
}

/** One-line status string for a job, used in tool output and logs. */
export function describeJob(job: RemoteVideoJob): string {
  const parts = [`${job.id}: ${job.status}`, `progress ${String(Math.round(job.progress ?? 0))}%`]
  if (job.stage !== undefined) parts.push(`stage ${job.stage}`)
  if (job.queuePosition !== undefined) parts.push(`queue position ${String(job.queuePosition)}`)
  return parts.join(', ')
}
