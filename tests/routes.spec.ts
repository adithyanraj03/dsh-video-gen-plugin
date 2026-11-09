import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRange, sameOrigin, serveJobFile, serveJobs, serveStoredFile } from '../src/video-route.js'

const servers: Server[] = []

async function serve(
  handler: (req: Parameters<typeof serveStoredFile>[0], res: Parameters<typeof serveStoredFile>[1]) => void | Promise<void>,
): Promise<string> {
  const server = createServer((req, res) => { void handler(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('parseRange', () => {
  it('accepts the single-range forms a browser player sends', () => {
    expect(parseRange(undefined, 100)).toBeUndefined()
    expect(parseRange('bytes=0-49', 100)).toEqual({ start: 0, end: 49 })
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=90-1000', 100)).toEqual({ start: 90, end: 99 })
  })

  it('rejects unsatisfiable and malformed ranges', () => {
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=9-1', 100)).toBe('invalid')
    expect(parseRange('items=0-1', 100)).toBe('invalid')
    expect(parseRange('bytes=abc', 100)).toBe('invalid')
    expect(parseRange('bytes=0-1', 0)).toBe('invalid')
  })
})

describe('sameOrigin', () => {
  it('accepts a missing Origin, which same-origin media requests omit', () => {
    expect(sameOrigin({ headers: {} } as never)).toBe(true)
  })

  it('compares the Origin host with the request host', () => {
    expect(sameOrigin({ headers: { origin: 'http://127.0.0.1:53780', host: '127.0.0.1:53780' } } as never)).toBe(true)
    expect(sameOrigin({ headers: { origin: 'https://evil.test', host: '127.0.0.1:53780' } } as never)).toBe(false)
    expect(sameOrigin({ headers: { origin: 'not a url' } } as never)).toBe(false)
  })
})

describe('serveStoredFile', () => {
  it('serves the whole file, then honours Range and ETag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-route-'))
    const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 256)
    await writeFile(join(dir, 'video-test.mp4'), bytes)
    const base = await serve((req, res) => serveStoredFile(req, res, { dir, file: 'video-test.mp4' }))

    const whole = await fetch(`${base}/clip`)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect((await whole.arrayBuffer()).byteLength).toBe(1000)
    const etag = whole.headers.get('etag')
    expect(etag).toBeTruthy()

    const partial = await fetch(`${base}/clip`, { headers: { range: 'bytes=10-19' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect([...new Uint8Array(await partial.arrayBuffer())]).toEqual([...bytes.slice(10, 20)])

    const cached = await fetch(`${base}/clip`, { headers: { 'if-none-match': etag as string } })
    expect(cached.status).toBe(304)

    const bad = await fetch(`${base}/clip`, { headers: { range: 'bytes=5000-6000' } })
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe('bytes */1000')
  })

  it('refuses a path outside the clip directory and unknown extensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-route-'))
    const base = await serve((req, res) => serveStoredFile(req, res, { dir, file: '../../Windows/win.ini' }))
    expect((await fetch(`${base}/clip`)).status).toBe(404)

    const base2 = await serve((req, res) => serveStoredFile(req, res, { dir, file: 'notes.txt' }))
    expect((await fetch(`${base2}/clip`)).status).toBe(404)
  })

  it('reports a missing clip with a fix-naming message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-route-'))
    const base = await serve((req, res) => serveStoredFile(req, res, { dir, file: 'gone.mp4' }))
    const response = await fetch(`${base}/clip`)
    expect(response.status).toBe(404)
    const body = await response.json() as { error: string; message?: string }
    expect(body.error).toBe('not_found')
    expect(body.message).toMatch(/generate the clip again/)
  })

  it('answers 405 for a write attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-route-'))
    const base = await serve((req, res) => serveStoredFile(req, res, { dir, file: 'a.mp4' }))
    expect((await fetch(`${base}/clip`, { method: 'POST' })).status).toBe(405)
  })
})

describe('serveJobFile', () => {
  it('resolves a job id to its stored clip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-route-'))
    await writeFile(join(dir, 'video-20260101T000000-abcdef12.mp4'), Uint8Array.from([1, 2, 3]))
    const store = {
      get: (id: string) => (id === 'video_x' ? { videoFile: join(dir, 'video-20260101T000000-abcdef12.mp4') } : undefined),
    }
    const base = await serve((req, res) => serveJobFile(req, res, { dir, kind: 'video', store }))
    const ok = await fetch(`${base}/clip?job=video_x`)
    expect(ok.status).toBe(200)
    expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([1, 2, 3])

    const unknown = await fetch(`${base}/clip?job=video_missing`)
    expect(unknown.status).toBe(404)
    expect((await unknown.json() as { error: string }).error).toBe('unknown_job')

    const noClip = await fetch(`${base}/clip`)
    expect(noClip.status).toBe(404)
  })

  it('finds the clip by the job id suffix when the history lost the record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-route-'))
    await writeFile(join(dir, 'video-20260101T000000-abcdef12.mp4'), Uint8Array.from([7, 8, 9]))
    // A wiped history (another host overwrote jobs.json) leaves the store empty.
    const store = { get: () => undefined }
    const base = await serve((req, res) => serveJobFile(req, res, { dir, kind: 'video', store }))
    const recovered = await fetch(`${base}/clip?job=video_9f8e7d6cabcdef12`)
    expect(recovered.status).toBe(200)
    expect([...new Uint8Array(await recovered.arrayBuffer())]).toEqual([7, 8, 9])

    // A job id whose suffix matches nothing stays an honest 404.
    const gone = await fetch(`${base}/clip?job=video_9f8e7d6c00112233`)
    expect(gone.status).toBe(404)
    expect((await gone.json() as { error: string }).error).toBe('unknown_job')
  })

  it('explains a job that has no thumbnail yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-route-'))
    const store = { get: () => ({ videoFile: undefined }) }
    const base = await serve((req, res) => serveJobFile(req, res, { dir, kind: 'thumbnail', store }))
    const response = await fetch(`${base}/thumb?job=video_x`)
    expect(response.status).toBe(404)
    expect((await response.json() as { error: string }).error).toBe('no_thumbnail')
  })
})

describe('serveJobs', () => {
  it('lists the jobs it is given, capped and uncached', async () => {
    const base = await serve((req, res) => serveJobs(req, res, {
      list: limit => Array.from({ length: Math.min(limit ?? 10, 3) }, (_, index) => ({
        id: `video_${String(index)}`, model: 'ltx-2.5', prompt: 'p', status: 'completed' as const,
        progress: 100, seconds: 5, size: '1280x704', fromPicture: false, createdAt: 1, updatedAt: 2,
      })),
    }))
    const response = await fetch(`${base}/jobs?limit=2`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { jobs: { id: string }[] }
    expect(body.jobs).toHaveLength(2)
  })
})
