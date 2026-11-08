/** Resolve the caller's start-frame picture into validated bytes for the API. */
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { MAX_REFERENCE_BYTES, REFERENCE_MEDIA_TYPES, type ReferenceMediaType } from './shared.js'
import type { ReferenceImage } from './ninfer.js'

/** A resolved start frame, with the metadata the size matcher and form need. */
export interface ResolvedReference extends ReferenceImage {
  /** Where it came from, for logs and tool output. */
  source: string
  /** Pixel size when it could be read, used to pick the clip's aspect ratio. */
  width?: number
  height?: number
}

/** The small DSH session surface this plugin depends on. */
export interface ReferenceAgent {
  session: {
    deriveMessages(): readonly Message[]
    header?: { cwd?: string }
  }
}

/** The small DSH attachment surface this plugin depends on. */
export interface ReferenceStore {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

/** Recognised magic numbers, in preference order. */
export function sniffMediaType(data: Uint8Array): ReferenceMediaType | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}

/** Pixel dimensions of a PNG/JPEG/WebP buffer without decoding it. */
export function imageSize(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.byteLength < 24) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const mediaType = sniffMediaType(data)
  if (mediaType === 'image/png') {
    if (view.getUint32(12) !== 0x49484452) return undefined
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (mediaType === 'image/jpeg') {
    let offset = 2
    while (offset + 9 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) {
        offset += 1
        continue
      }
      const marker = view.getUint8(offset + 1)
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isStartOfFrame) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      offset += 2 + view.getUint16(offset + 2)
    }
    return undefined
  }
  if (mediaType === 'image/webp') {
    const fourcc = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15))
    if (fourcc === 'VP8X' && view.byteLength >= 30) {
      return {
        width: 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)),
        height: 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)),
      }
    }
    if (fourcc === 'VP8 ' && view.byteLength >= 30) {
      return { width: view.getUint16(26) & 0x3fff, height: view.getUint16(28) & 0x3fff }
    }
    if (fourcc === 'VP8L' && view.byteLength >= 25) {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return undefined
  }
  return undefined
}

/** Reject anything the API would refuse, with the fix in the message. */
export function validateReference(data: Uint8Array, source: string): { mediaType: ReferenceMediaType; width?: number; height?: number } {
  if (data.byteLength === 0) throw new Error(`the start-frame picture from ${source} is empty.`)
  if (data.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error(`the start-frame picture from ${source} is ${String(Math.round(data.byteLength / 1_048_576))} MB; Ninfer accepts one PNG/JPEG/WebP up to 20 MB — downscale it first.`)
  }
  const mediaType = sniffMediaType(data)
  if (mediaType === undefined) {
    throw new Error(`the start-frame picture from ${source} is not a PNG, JPEG, or WebP image; convert it and try again.`)
  }
  const size = imageSize(data)
  return { mediaType, ...(size === undefined ? {} : size) }
}

/** File name suited to the multipart part for a media type. */
export function referenceFileName(mediaType: ReferenceMediaType, id: string): string {
  const extension = mediaType === 'image/png' ? 'png' : mediaType === 'image/jpeg' ? 'jpg' : 'webp'
  return `reference-${id.replace(/[^a-z0-9]/gi, '').slice(-12) || 'frame'}.${extension}`
}

/** Build the validated reference payload from raw bytes. */
export function referenceFromBytes(data: Uint8Array, source: string, id: string): ResolvedReference {
  const checked = validateReference(data, source)
  return {
    data,
    mediaType: checked.mediaType,
    name: referenceFileName(checked.mediaType, id),
    source,
    ...(checked.width === undefined ? {} : { width: checked.width }),
    ...(checked.height === undefined ? {} : { height: checked.height }),
  }
}

/** Media types the API accepts, for tool descriptions and errors. */
export const ACCEPTED_REFERENCE_TYPES: readonly string[] = REFERENCE_MEDIA_TYPES

/** True when `child` equals `parent` or lives underneath it (lexically). */
function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Compare an attachment id with or without its `sha256:` prefix. */
export function attachmentIdsEqual(actual: string, requested: string): boolean {
  if (actual === requested) return true
  const digest = (value: string): string | undefined => /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value.trim())?.[1]?.toLowerCase()
  const left = digest(actual)
  return left !== undefined && left === digest(requested)
}

/** True when a block carries an image the API can animate. */
function imageBlockRef(block: ContentBlock): ImageAttachmentRef | undefined {
  if (block.type !== 'image') return undefined
  const mediaType = block.attachment.mediaType
  if (!(REFERENCE_MEDIA_TYPES as readonly string[]).includes(mediaType)) return undefined
  return block.attachment
}

/** Newest image in the conversation, or the one matching `attachmentId`. */
export function findReferenceImage(messages: readonly Message[], attachmentId?: string): ImageAttachmentRef | undefined {
  const walk = (blocks: readonly ContentBlock[]): ImageAttachmentRef | undefined => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]
      if (block === undefined) continue
      const ref = imageBlockRef(block)
      if (ref !== undefined) {
        if (attachmentId === undefined || attachmentIdsEqual(String(ref.attachmentId), attachmentId)) return ref
        continue
      }
      // Legacy hosts nest tool results as blocks carrying their own content array.
      const nested = (block as { content?: unknown }).content
      if (Array.isArray(nested)) {
        const found = walk(nested as ContentBlock[])
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const found = walk(messages[index]?.content ?? [])
    if (found !== undefined) return found
  }
  return undefined
}

/** Read the picture the conversation already holds. */
export async function referenceFromAttachment(input: {
  agent: ReferenceAgent
  attachments: ReferenceStore
  attachmentId: string
  signal?: AbortSignal
}): Promise<ResolvedReference> {
  const id = input.attachmentId.trim()
  if (id.length === 0) throw new Error('source_attachment_id is empty; pass the attachment id of an image already in this conversation.')
  const ref = findReferenceImage(input.agent.session.deriveMessages(), id)
  if (ref === undefined) {
    throw new Error(`no image attachment ${id} is in this conversation; pass an id from an image the user sent, or use image_url / source_path for a file.`)
  }
  const stored = await input.attachments.readImage(ref, input.signal)
  const resolved = referenceFromBytes(stored.data, `attachment ${id}`, id)
  return {
    ...resolved,
    ...(ref.width === undefined || ref.height === undefined ? {} : { width: ref.width, height: ref.height }),
  }
}

/** Read a picture from a path inside the session workspace. */
export async function referenceFromPath(input: {
  agent: ReferenceAgent
  sourcePath: string
  signal?: AbortSignal
}): Promise<ResolvedReference> {
  const requested = input.sourcePath.trim()
  if (requested.length === 0) throw new Error('source_path is empty; pass a file path to a PNG/JPEG/WebP image.')
  const workspaceRoot = input.agent.session.header?.cwd
  if (workspaceRoot === undefined) {
    throw new Error('source_path needs an active DSH session workspace; pass image_url or source_attachment_id instead.')
  }
  const root = resolve(workspaceRoot)
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested)
  if (!containsPath(root, candidate)) {
    throw new Error(`source_path "${requested}" must stay inside the session workspace; move the picture into ${root} or pass image_url.`)
  }
  let realRoot: string
  let realCandidate: string
  try {
    ;[realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)])
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`source_path "${requested}" does not exist in the session workspace ${root}.`)
    }
    throw error
  }
  if (!containsPath(realRoot, realCandidate)) {
    throw new Error(`source_path "${requested}" resolves outside the session workspace through a symlink.`)
  }
  const info = await stat(realCandidate)
  if (!info.isFile()) throw new Error(`source_path "${requested}" is not a file.`)
  const data = new Uint8Array(await readFile(realCandidate, { ...(input.signal === undefined ? {} : { signal: input.signal }) }))
  return referenceFromBytes(data, realCandidate, realCandidate)
}

/** Fetch a public picture URL into a validated reference. */
export async function referenceFromUrl(url: string, fetchFn: (input: string, init?: RequestInit) => Promise<Response> = fetch): Promise<ResolvedReference> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`image_url "${url}" is not a valid URL; pass an http(s) link to a PNG/JPEG/WebP picture.`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`image_url must be an http(s) URL (got ${parsed.protocol}); pass source_attachment_id or source_path for local pictures.`)
  }
  const response = await fetchFn(parsed.href, { method: 'GET', redirect: 'follow' })
  if (!response.ok) throw new Error(`could not download the start-frame picture from ${parsed.href}: HTTP ${String(response.status)}.`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_REFERENCE_BYTES) {
    throw new Error(`the start-frame picture at ${parsed.href} is ${String(Math.round(declared / 1_048_576))} MB; Ninfer accepts one PNG/JPEG/WebP up to 20 MB.`)
  }
  return referenceFromBytes(new Uint8Array(await response.arrayBuffer()), parsed.href, parsed.hostname)
}

/**
 * Resolve the start frame from the tool arguments. Exactly one source may be
 * given: mixing them means the caller was unsure, so say which to drop.
 */
export async function resolveReference(input: {
  agent?: ReferenceAgent | undefined
  attachments: ReferenceStore
  imageUrl?: string | undefined
  sourceAttachmentId?: string | undefined
  sourcePath?: string | undefined
  signal?: AbortSignal | undefined
}): Promise<ResolvedReference | undefined> {
  const selectors = [
    input.imageUrl?.trim() ?? '',
    input.sourceAttachmentId?.trim() ?? '',
    input.sourcePath?.trim() ?? '',
  ].filter(value => value.length > 0)
  const chosen = selectors[0]
  if (chosen === undefined) return undefined
  if (selectors.length > 1) {
    throw new Error('pass only one start-frame source: image_url, source_attachment_id, or source_path.')
  }
  if (input.imageUrl?.trim() === chosen) {
    return await referenceFromUrl(chosen)
  }
  if (input.agent === undefined) {
    throw new Error('resolving a conversation image needs an active DSH agent session; pass image_url or source_path instead.')
  }
  if (input.sourceAttachmentId !== undefined && input.sourceAttachmentId.trim().length > 0) {
    return await referenceFromAttachment({
      agent: input.agent,
      attachments: input.attachments,
      attachmentId: input.sourceAttachmentId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
  }
  return await referenceFromPath({
    agent: input.agent,
    sourcePath: input.sourcePath ?? '',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
}
