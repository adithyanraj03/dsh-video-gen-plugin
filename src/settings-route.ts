/**
 * Settings-card HTTP surface.
 *
 * Two capabilities a settings form cannot do by itself: probe an endpoint the
 * user is still typing (base URL + key, before anything is saved), and store a
 * key without the browser ever holding one. Both run on the host, so the token
 * never appears in page state.
 */
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeBaseUrl } from './config.js'
import { KEY_SETTINGS_HINT } from './credentials.js'
import { VideoApiError, createClient, getModels } from './video-api.js'
import { jsonError, readJsonBody, sameOrigin, queryOf } from './video-route.js'

/** Largest token a settings form may submit. */
const MAX_KEY_BYTES = 8 * 1024

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(body))
}

/** Read one string field of an untrusted JSON body. */
function field(body: Record<string, unknown> | undefined, name: string): string {
  const value = body?.[name]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Probe one endpoint and list the models it serves.
 *
 * A `keyValue` in the body wins over the stored credential, so the card can
 * test a key the user just pasted before saving it.
 */
export async function serveModels(req: IncomingMessage, res: ServerResponse, options: {
  resolveKey: (ref: string) => Promise<string | undefined>
}): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    jsonError(res, 405, 'method_not_allowed')
    return
  }
  if (!sameOrigin(req)) {
    jsonError(res, 403, 'cross_origin', 'model probing must come from the harness page itself')
    return
  }
  const body = await readJsonBody(req).catch(() => undefined)
  const rawUrl = field(body, 'baseUrl')
  let baseURL: string
  try {
    baseURL = normalizeBaseUrl(rawUrl)
  } catch (error) {
    respond(res, 200, { ok: false, code: 'invalid_url', message: error instanceof Error ? error.message : String(error) })
    return
  }
  const keyRef = field(body, 'apiKeyRef')
  const keyValue = field(body, 'keyValue')
  let token = keyValue
  if (token.length === 0) {
    if (!isCredentialRefName(keyRef)) {
      respond(res, 200, {
        ok: false,
        code: 'missing_key',
        message: 'save the API key for this endpoint first, or paste it in the key field before testing',
      })
      return
    }
    token = await options.resolveKey(keyRef) ?? ''
  }
  if (token.length === 0) {
    respond(res, 200, {
      ok: false,
      code: 'missing_key',
      message: `no API key is stored under ${keyRef || 'the endpoint credential'}. Paste the key and save it in ${KEY_SETTINGS_HINT}.`,
    })
    return
  }
  try {
    const client = createClient({ baseURL, token })
    const models = await getModels(client)
    respond(res, 200, { ok: true, baseUrl: baseURL, models })
  } catch (error) {
    const failure = error instanceof VideoApiError ? error : undefined
    respond(res, 200, {
      ok: false,
      code: failure?.code ?? 'probe_failed',
      status: failure?.status ?? 0,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Describe or replace one stored API key.
 *
 * GET reports presence and writability, never the value. POST stores a new
 * token, or removes the record when the submitted value is blank.
 */
export async function serveCredential(req: IncomingMessage, res: ServerResponse, options: {
  describe: (ref: string) => Promise<{ configured: boolean; writable: boolean }>
  set: (ref: string, value: string) => Promise<void>
  unset: (ref: string) => Promise<void>
}): Promise<void> {
  const query = queryOf(req)
  if (req.method === 'GET') {
    const ref = (query?.get('ref') ?? '').trim()
    if (!isCredentialRefName(ref)) {
      jsonError(res, 400, 'invalid_ref', 'pass ?ref=NAME where NAME is an upper-case credential name such as VIDEO_GEN_KEY_MYENDPOINT')
      return
    }
    try {
      const info = await options.describe(ref)
      respond(res, 200, { ref, configured: info.configured, writable: info.writable })
    } catch (error) {
      jsonError(res, 400, 'describe_failed', error instanceof Error ? error.message : String(error))
    }
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST')
    jsonError(res, 405, 'method_not_allowed')
    return
  }
  if (!sameOrigin(req)) {
    jsonError(res, 403, 'cross_origin', 'writing a key must come from the harness page itself')
    return
  }
  const body = await readJsonBody(req).catch(() => undefined)
  const ref = field(body, 'ref')
  const value = field(body, 'value')
  if (!isCredentialRefName(ref)) {
    jsonError(res, 400, 'invalid_ref', 'the credential name must be an upper-case identifier such as VIDEO_GEN_KEY_MYENDPOINT')
    return
  }
  if (value.length > MAX_KEY_BYTES) {
    jsonError(res, 413, 'key_too_large', 'that value is too long to be an API key')
    return
  }
  try {
    if (value.length === 0) {
      await options.unset(ref)
      respond(res, 200, { ok: true, ref, configured: false })
      return
    }
    await options.set(ref, value)
    respond(res, 200, { ok: true, ref, configured: true })
  } catch (error) {
    jsonError(res, 400, 'write_failed', error instanceof Error ? error.message : String(error))
  }
}

/** Credential helpers the routes need, bound to the host service. */
export function credentialPorts(ctx: {
  credentials: {
    describe(ref: ReturnType<typeof credentialRef>): Promise<{ configured: boolean; writable: boolean }>
    set(ref: ReturnType<typeof credentialRef>, value: string): Promise<void>
    unset(ref: ReturnType<typeof credentialRef>): Promise<void>
  }
}): {
  describe: (ref: string) => Promise<{ configured: boolean; writable: boolean }>
  set: (ref: string, value: string) => Promise<void>
  unset: (ref: string) => Promise<void>
} {
  return {
    describe: async ref => ctx.credentials.describe(credentialRef(ref)),
    set: async (ref, value) => { await ctx.credentials.set(credentialRef(ref), value) },
    unset: async ref => { await ctx.credentials.unset(credentialRef(ref)) },
  }
}
