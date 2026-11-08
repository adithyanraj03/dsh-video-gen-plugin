/**
 * Same-origin HTTP surface of the plugin: clip bytes with Range support, job
 * state for the toolview, cancel, and the settings connectivity probe.
 *
 * Bytes travel over these routes instead of being base64'd into tool output:
 * a browser <video> element needs a URL it can seek in, and seeking means the
 * server has to answer `Range` requests.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { safeFileName, type VideoJobView } from './shared.js'

/** Cap on any JSON body these routes accept. */
const MAX_BODY_BYTES = 64 * 1024

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** Reply with a JSON error body and no caching. */
export function jsonError(res: ServerResponse, status: number, code: string, message?: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(message === undefined ? { error: code } : { error: code, message }))
}

/** Query parameters of the current request, or undefined when there are none. */
export function queryOf(req: IncomingMessage): URLSearchParams | undefined {
  const raw = req.url ?? ''
  const index = raw.indexOf('?')
  if (index < 0) return undefined
  try {
    return new URLSearchParams(raw.slice(index + 1))
  } catch {
    return undefined
  }
}

/**
 * Reject a cross-site caller. Browsers omit `Origin` on same-origin GETs
 * (`<video src>`, `<img src>`), so a missing header is not an attack; a present
 * header must name this exact host.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read a small JSON body; undefined when the body is absent or not an object. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Resolved byte window of one response: a whole file, a slice, or a refusal. */
export type ByteRange = { start: number; end: number } | undefined | 'invalid'

/**
 * Parse one `Range` header against the file size.
 *
 * Only the single-range form is supported, which is all a browser player sends.
 * An unparsable or unsatisfiable range returns `'invalid'` so the caller can
 * answer 416 instead of silently sending the whole file.
 */
export function parseRange(header: string | string[] | undefined, size: number): ByteRange {
  if (typeof header !== 'string' || header.length === 0) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return 'invalid'
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'invalid'
  if (size === 0) return 'invalid'
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/** True when `child` sits at or under `parent`. */
function inside(parent: string, child: string): boolean {
  const base = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(base)
}

/**
 * Stream one stored file with `Range`, `ETag`, and `304` support.
 *
 * The file name is resolved strictly inside the configured directory: these
 * routes serve only what this plugin wrote, never an arbitrary host path.
 */
export async function serveStoredFile(req: IncomingMessage, res: ServerResponse, options: {
  dir: string
  file: string | undefined
}): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD')
    jsonError(res, 405, 'method_not_allowed')
    return
  }
  if (options.file === undefined || options.file.length === 0) {
    jsonError(res, 404, 'not_found', 'no clip requested; pass ?job=<id> or ?name=<file>')
    return
  }
  const dir = resolve(options.dir)
  const target = resolve(dir, safeFileName(options.file))
  if (!inside(dir, target)) {
    jsonError(res, 404, 'not_found', 'the requested file is outside the plugin clip directory')
    return
  }
  const extension = extname(target).toLowerCase()
  if (CONTENT_TYPES[extension] === undefined) {
    jsonError(res, 404, 'not_found', 'only stored clips and thumbnails are served from this route')
    return
  }
  const info = await stat(target).catch(() => undefined)
  if (info === undefined || !info.isFile()) {
    jsonError(res, 404, 'not_found', 'the clip file is no longer on disk; the plugin directory may have been cleaned — generate the clip again.')
    return
  }
  const etag = `"${String(info.size)}-${String(Math.round(info.mtimeMs))}"`
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('etag', etag)
  res.setHeader('cache-control', 'private, max-age=31536000, immutable')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-type', CONTENT_TYPES[extension] as string)
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }
  const range = parseRange(req.headers.range, info.size)
  if (range === 'invalid') {
    res.statusCode = 416
    res.setHeader('content-range', `bytes */${String(info.size)}`)
    res.end()
    return
  }
  if (range === undefined) {
    res.statusCode = 200
    res.setHeader('content-length', String(info.size))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(target)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }
  res.statusCode = 206
  res.setHeader('content-range', `bytes ${String(range.start)}-${String(range.end)}/${String(info.size)}`)
  res.setHeader('content-length', String(range.end - range.start + 1))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(target, { start: range.start, end: range.end })
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/** What the clip routes need to turn a job id into a stored file name. */
export interface JobFileSource {
  get(id: string): { videoFile?: string; thumbFile?: string } | undefined
}

/** Serve the clip (or thumbnail) of one job, or a named file in the directory. */
export async function serveJobFile(req: IncomingMessage, res: ServerResponse, options: {
  dir: string
  kind: 'video' | 'thumbnail'
  store: JobFileSource
}): Promise<void> {
  const query = queryOf(req)
  const jobId = query?.get('job')?.trim() ?? ''
  let file: string | undefined
  if (jobId.length > 0) {
    const record = options.store.get(jobId)
    if (record === undefined) {
      jsonError(res, 404, 'unknown_job', `this host does not track job ${jobId}; the clip is only served while the job stays in the local history.`)
      return
    }
    const stored = options.kind === 'video' ? record.videoFile : record.thumbFile
    if (stored === undefined) {
      jsonError(res, 404, options.kind === 'video' ? 'not_ready' : 'no_thumbnail', options.kind === 'video'
        ? 'this job has no stored clip yet; it is still rendering or the download failed.'
        : 'this job has no stored thumbnail; set saveThumbnail in Settings > Plugins > Video generation to keep one.')
      return
    }
    file = stored.split(/[\\/]/).pop()
  } else {
    file = query?.get('name')?.trim()
  }
  await serveStoredFile(req, res, { dir: options.dir, file })
}

/** List recent jobs for the toolview's live progress panel. */
export function serveJobs(req: IncomingMessage, res: ServerResponse, options: {
  list: (limit?: number) => VideoJobView[]
}): void {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET')
    jsonError(res, 405, 'method_not_allowed')
    return
  }
  const query = queryOf(req)
  const rawLimit = query?.get('limit') ?? ''
  const parsed = rawLimit === '' ? Number.NaN : Number(rawLimit)
  const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.round(parsed))) : 10
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ jobs: options.list(limit) }))
}

/** Cancel one job on the server and in the local history. */
export async function serveCancel(req: IncomingMessage, res: ServerResponse, options: {
  cancel: (id: string) => Promise<{ id: string; status: string }>
}): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    jsonError(res, 405, 'method_not_allowed')
    return
  }
  if (!sameOrigin(req)) {
    jsonError(res, 403, 'cross_origin', 'cancel requests must come from the harness page itself')
    return
  }
  const query = queryOf(req)
  const body = await readJsonBody(req).catch(() => undefined)
  const id = (query?.get('id') ?? (typeof body?.id === 'string' ? body.id : '')).trim()
  if (id.length === 0) {
    jsonError(res, 400, 'missing_id', 'pass the job id as ?id=<video id> or in the JSON body')
    return
  }
  try {
    const record = await options.cancel(id)
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, id: record.id, status: record.status }))
  } catch (error) {
    jsonError(res, 400, 'cancel_failed', error instanceof Error ? error.message : String(error))
  }
}

/** Probe the configured endpoint and token from the settings page. */
export async function serveTestConnection(req: IncomingMessage, res: ServerResponse, options: {
  probe: () => Promise<{ baseUrl: string; model: string; models: string[] }>
}): Promise<void> {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    jsonError(res, 405, 'method_not_allowed')
    return
  }
  if (!sameOrigin(req)) {
    jsonError(res, 403, 'cross_origin', 'connectivity checks must come from the harness page itself')
    return
  }
  try {
    const result = await options.probe()
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ ok: true, ...result }))
  } catch (error) {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({
      ok: false,
      code: (error as { code?: string }).code ?? 'probe_failed',
      message: error instanceof Error ? error.message : String(error),
    }))
  }
}
