import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { serveCredential, serveModels } from '../src/settings-route.js'

const servers: Server[] = []

/** Start one fake endpoint and return its base URL. */
async function endpoint(handler: (url: string, authorization: string | undefined) => { status: number; body: unknown }): Promise<string> {
  const server = createServer((req, res) => {
    const authorization = req.headers.authorization
    const answer = handler(req.url ?? '/', typeof authorization === 'string' ? authorization : undefined)
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer.body))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}`
}

/** Start one harness-side route and return its base URL. */
async function harness(handler: (req: never, res: never) => void | Promise<void>): Promise<string> {
  const server = createServer((req, res) => { void handler(req as never, res as never) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

const stored = new Map<string, string>([])
const ports = {
  describe: async (ref: string) => ({ configured: stored.has(ref), writable: true }),
  set: async (ref: string, value: string) => { stored.set(ref, value) },
  unset: async (ref: string) => { stored.delete(ref) },
}

describe('serveModels', () => {
  it('lists the models of an endpoint using the stored key', async () => {
    const api = await endpoint(() => ({ status: 200, body: { data: [{ id: 'video-model', type: 'video' }, { id: 'other', type: 'image' }] } }))
    const base = await harness((req, res) => serveModels(req, res, { resolveKey: async () => 'token' }))
    const response = await fetch(`${base}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: `${api}/v1`, apiKeyRef: 'VIDEO_GEN_KEY_TEST' }),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; models: string[] }
    expect(body.ok).toBe(true)
    expect(body.models).toEqual(['video-model'])
  })

  it('uses a key the caller just pasted, before it is stored', async () => {
    const seen: (string | undefined)[] = []
    const api = await endpoint((_url, authorization) => {
      seen.push(authorization)
      return { status: 200, body: { data: [{ id: 'm', type: 'video' }] } }
    })
    const base = await harness((req, res) => serveModels(req, res, { resolveKey: async () => undefined }))
    const response = await fetch(`${base}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: `${api}/v1`, keyValue: 'fresh-token' }),
    })
    expect((await response.json() as { ok: boolean }).ok).toBe(true)
    expect(seen[0]).toBe('Bearer fresh-token')
  })

  it('explains a missing key and a bad URL instead of throwing', async () => {
    const base = await harness((req, res) => serveModels(req, res, { resolveKey: async () => undefined }))
    const missing = await fetch(`${base}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://x.test/v1', apiKeyRef: 'VIDEO_GEN_KEY_TEST' }),
    })
    const missingBody = await missing.json() as { ok: boolean; code: string; message: string }
    expect(missingBody).toMatchObject({ ok: false, code: 'missing_key' })
    expect(missingBody.message).toMatch(/Settings > Plugins > Video generation/)

    const badUrl = await fetch(`${base}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'nope' }),
    })
    expect((await badUrl.json() as { code: string }).code).toBe('invalid_url')
  })

  it('reports an endpoint that answers with an error', async () => {
    const api = await endpoint(() => ({ status: 401, body: { error: { message: 'bad token' } } }))
    const base = await harness((req, res) => serveModels(req, res, { resolveKey: async () => 'expired' }))
    const response = await fetch(`${base}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: `${api}/v1`, apiKeyRef: 'VIDEO_GEN_KEY_TEST' }),
    })
    const body = await response.json() as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message).toMatch(/rejected the bearer token/)
  })

  it('refuses a cross-origin probe', async () => {
    const base = await harness((req, res) => serveModels(req, res, { resolveKey: async () => 't' }))
    const response = await fetch(`${base}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
      body: JSON.stringify({ baseUrl: 'https://x.test/v1' }),
    })
    expect(response.status).toBe(403)
  })
})

describe('serveCredential', () => {
  it('stores, describes, and clears one key', async () => {
    stored.clear()
    const base = await harness((req, res) => serveCredential(req, res, ports))

    const saved = await fetch(`${base}/credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'VIDEO_GEN_KEY_A', value: 'secret-value' }),
    })
    expect(await saved.json() as unknown).toMatchObject({ ok: true, configured: true })
    expect(stored.get('VIDEO_GEN_KEY_A')).toBe('secret-value')

    const described = await fetch(`${base}/credential?ref=VIDEO_GEN_KEY_A`)
    expect(await described.json() as unknown).toMatchObject({ ref: 'VIDEO_GEN_KEY_A', configured: true })

    const cleared = await fetch(`${base}/credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'VIDEO_GEN_KEY_A', value: '' }),
    })
    expect(await cleared.json() as unknown).toMatchObject({ ok: true, configured: false })
    expect(stored.has('VIDEO_GEN_KEY_A')).toBe(false)
  })

  it('rejects a malformed reference', async () => {
    const base = await harness((req, res) => serveCredential(req, res, ports))
    const response = await fetch(`${base}/credential?ref=not%20a%20name`)
    expect(response.status).toBe(400)
  })

  it('refuses a cross-origin write', async () => {
    const base = await harness((req, res) => serveCredential(req, res, ports))
    const response = await fetch(`${base}/credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
      body: JSON.stringify({ ref: 'VIDEO_GEN_KEY_A', value: 'x' }),
    })
    expect(response.status).toBe(403)
  })
})

