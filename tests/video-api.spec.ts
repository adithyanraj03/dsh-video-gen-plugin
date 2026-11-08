import { describe, expect, it } from 'vitest'
import {
  buildCreateBody,
  buildReferenceForm,
  createClient,
  createVideo,
  describeJob,
  describeJobFailure,
  downloadContent,
  mapFailure,
  parseJob,
  pollDelay,
  referenceDataUrl,
  toVideoApiError,
} from '../src/video-api.js'

const reference = {
  data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  mediaType: 'image/png',
  name: 'reference-frame.png',
}

describe('buildCreateBody', () => {
  it('sends seconds as the string the server echoes back', () => {
    const body = buildCreateBody({ model: 'ltx-2.5', prompt: 'a cat surfing', seconds: 5 })
    expect(body).toMatchObject({ model: 'ltx-2.5', prompt: 'a cat surfing', seconds: '5' })
  })

  it('carries every optional field it was given and nothing else', () => {
    const body = buildCreateBody({
      model: 'ltx-2.5', prompt: 'p', seconds: 8, size: '1280x704', orientation: 'landscape',
      fps: 24, seed: 7, enhance: true, negativePrompt: ' no text ',
    })
    expect(body).toMatchObject({
      size: '1280x704', orientation: 'landscape', fps: 24, seed: 7, enhance: true, negative_prompt: 'no text',
    })
    expect(Object.keys(body).sort()).toEqual(['enhance', 'fps', 'model', 'negative_prompt', 'orientation', 'prompt', 'seconds', 'seed', 'size'].sort())
  })

  it('refuses an empty prompt with an actionable message', () => {
    expect(() => buildCreateBody({ model: 'ltx-2.5', prompt: '   ' })).toThrow(/non-empty prompt/)
  })

  it('refuses a prompt beyond the server limit', () => {
    expect(() => buildCreateBody({ model: 'ltx-2.5', prompt: 'x'.repeat(8001) })).toThrow(/documented limit is 8000/)
  })

  it('refuses seconds and fps outside the documented windows', () => {
    expect(() => buildCreateBody({ model: 'm', prompt: 'p', seconds: 31 })).toThrow(/seconds must be/)
    expect(() => buildCreateBody({ model: 'm', prompt: 'p', seconds: 5, fps: 60 })).toThrow(/fps must be/)
    expect(() => buildCreateBody({ model: 'm', prompt: 'p', seconds: 5, seed: 1.5 })).toThrow(/seed must be an integer/)
  })
})

describe('reference payloads', () => {
  it('builds a data URL from the bytes', () => {
    expect(referenceDataUrl(reference)).toBe('data:image/png;base64,iVBORw==')
  })

  it('puts the picture in the multipart input_reference part', async () => {
    const form = buildReferenceForm({ model: 'ltx-2.5', prompt: 'p', seconds: '5' }, reference)
    const part = form.get('input_reference')
    expect(part).toBeInstanceOf(Blob)
    expect((part as Blob).type).toBe('image/png')
    expect(form.get('model')).toBe('ltx-2.5')
    expect(form.get('input_reference')).not.toBeNull()
  })
})

describe('mapFailure', () => {
  it('maps auth failures to the token fix', () => {
    expect(mapFailure(401, '', '', 'POST /videos').message).toMatch(/rejected the bearer token/)
    expect(mapFailure(403, '', '', 'POST /videos').retryable).toBe(false)
  })

  it('maps bad requests and unknown models', () => {
    expect(mapFailure(400, '', 'invalid size', 'POST /videos').message).toMatch(/invalid size/)
    expect(mapFailure(404, 'model_not_found', '', 'POST /videos').message).toMatch(/Fetch the model list/)
  })

  it('tells the reader a 404 job id means a restarted server', () => {
    expect(mapFailure(404, '', '', 'GET /videos/x').message).toMatch(/forget jobs on restart/)
  })

  it('treats 409 as retryable and 413 as a picture-size problem', () => {
    expect(mapFailure(409, '', '', 'GET /content').retryable).toBe(true)
    expect(mapFailure(413, '', '', 'POST /videos').message).toMatch(/20 MB/)
  })

  it('maps unavailable engines and 5xx as retryable', () => {
    expect(mapFailure(503, 'engine_missing', '', 'POST /videos').message).toMatch(/engine behind this endpoint is unavailable/)
    expect(mapFailure(500, '', 'boom', 'POST /videos').retryable).toBe(true)
  })
})

describe('describeJobFailure', () => {
  it('names an action for every documented failure code', () => {
    for (const code of ['models_missing', 'engine_refused', 'engine_error', 'timeout', 'no_video', 'runner_failed', 'internal']) {
      const text = describeJobFailure(code, 'detail', { seconds: 5, size: '1280x704' })
      expect(text.length).toBeGreaterThan(20)
      expect(text).toMatch(/detail/)
    }
    expect(describeJobFailure('cancelled', 'stopped', {})).toMatch(/cancelled/)
    expect(describeJobFailure(undefined, 'odd', {})).toMatch(/failed/)
  })
})

describe('parseJob', () => {
  it('decodes the documented create/poll payload', () => {
    const job = parseJob({
      id: 'video_1a2b3c4d5e6f', object: 'video', status: 'in_progress', progress: 42,
      seconds: '5', size: '1280x704', seed: 11, queue_position: 2, stage: 'render',
      from_picture: true, file: 'video_1a2b3c4d5e6f.mp4', thumb: 'video_1a2b3c4d5e6f.jpg',
      timing: { render_s: 12.5 }, created_at: 1_700_000_000,
    })
    expect(job).toMatchObject({
      id: 'video_1a2b3c4d5e6f', status: 'in_progress', progress: 42, seconds: 5,
      size: '1280x704', seed: 11, queuePosition: 2, stage: 'render', fromPicture: true,
    })
    expect(job.timing).toEqual({ render_s: 12.5 })
    expect(job.createdAt).toBe(1_700_000_000)
  })

  it('keeps a failed job error readable', () => {
    const job = parseJob({ id: 'video_x', status: 'failed', error: { code: 'timeout', message: 'took too long' } })
    expect(job.error).toEqual({ code: 'timeout', message: 'took too long' })
  })

  it('rejects a payload without a job id', () => {
    expect(() => parseJob({ status: 'queued' })).toThrow(/without a job id/)
  })

  it('describes itself in one line', () => {
    expect(describeJob(parseJob({ id: 'video_x', status: 'queued', progress: 0, queue_position: 3 })))
      .toBe('video_x: queued, progress 0%, queue position 3')
  })
})

/** Minimal fetch stand-in that records the request it was handed. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response): { calls: { url: string; init?: RequestInit }[]; fetchFn: (url: string, init?: RequestInit) => Promise<Response> } {
  const calls: { url: string; init?: RequestInit }[] = []
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push(init === undefined ? { url } : { url, init })
      return handler(url, init)
    },
  }
}

describe('createVideo', () => {
  it('posts JSON when there is no start frame', async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ id: 'video_a', status: 'queued' }), { status: 200 }))
    const client = createClient({ baseURL: 'https://video.test/v1', token: 't', fetchFn: fake.fetchFn })
    const job = await createVideo(client, { model: 'ltx-2.5', prompt: 'p', seconds: 5 })
    expect(job.id).toBe('video_a')
    const call = fake.calls[0]!
    expect(call.url).toBe('https://video.test/v1/videos')
    expect(call.init?.method).toBe('POST')
    expect((call.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer t')
  })

  it('posts multipart when a first frame is supplied', async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ id: 'video_b', status: 'queued', from_picture: true }), { status: 200 }))
    const client = createClient({ baseURL: 'https://video.test/v1', token: 't', fetchFn: fake.fetchFn })
    const job = await createVideo(client, { model: 'ltx-2.5', prompt: 'p', seconds: 5 }, { reference })
    expect(job.fromPicture).toBe(true)
    const call = fake.calls[0]!
    expect(call.init?.body).toBeInstanceOf(FormData)
    expect((call.init?.headers as Record<string, string>)['content-type']).toBeUndefined()
  })

  it('turns an HTTP failure into a VideoApiError with the fix attached', async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'no such model' } }), { status: 404 }))
    const client = createClient({ baseURL: 'https://video.test/v1', token: 't', fetchFn: fake.fetchFn })
    await expect(createVideo(client, { model: 'nope', prompt: 'p' })).rejects.toMatchObject({ code: 'model_not_found', retryable: false })
  })
})

describe('downloadContent', () => {
  it('returns the bytes of a finished clip', async () => {
    const fake = fakeFetch(() => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-length': '4' } }))
    const client = createClient({ baseURL: 'https://video.test/v1', token: 't', fetchFn: fake.fetchFn })
    const bytes = await downloadContent(client, 'video_a', { maxBytes: 1024 })
    expect([...bytes]).toEqual([1, 2, 3, 4])
    expect(fake.calls[0]!.url).toBe('https://video.test/v1/videos/video_a/content')
  })

  it('asks for the thumbnail variant', async () => {
    const fake = fakeFetch(() => new Response(new Uint8Array([9]), { status: 200 }))
    const client = createClient({ baseURL: 'https://video.test/v1', token: 't', fetchFn: fake.fetchFn })
    await downloadContent(client, 'video_a', { kind: 'thumbnail', maxBytes: 1024 })
    expect(fake.calls[0]!.url).toBe('https://video.test/v1/videos/video_a/content?variant=thumbnail')
  })

  it('refuses a clip over the configured byte budget', async () => {
    const fake = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '5000000' } }))
    const client = createClient({ baseURL: 'https://video.test/v1', token: 't', fetchFn: fake.fetchFn })
    await expect(downloadContent(client, 'video_a', { maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' })
  })

  it('reports a not-ready clip as retryable', async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'not ready' } }), { status: 409 }))
    const client = createClient({ baseURL: 'https://video.test/v1', token: 't', fetchFn: fake.fetchFn })
    await expect(downloadContent(client, 'video_a', { maxBytes: 1000 })).rejects.toMatchObject({ retryable: true })
  })

  it('reports an unreachable host as a retryable network failure', async () => {
    const client = createClient({
      baseURL: 'https://video.test/v1',
      token: 't',
      fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND') },
    })
    await expect(downloadContent(client, 'video_a', { maxBytes: 1000 })).rejects.toMatchObject({ code: 'network', retryable: true })
  })

  it('turns a non-JSON body into a typed error', async () => {
    const fake = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }))
    const client = createClient({ baseURL: 'https://video.test/v1', token: 't', fetchFn: fake.fetchFn })
    const response = new Response('<html>', { status: 200 })
    await expect(toVideoApiError(response, 'GET /x')).resolves.toMatchObject({ retryable: false })
    void fake
    void client
  })
})

describe('pollDelay', () => {
  it('backs off and then holds at the cap', () => {
    expect(pollDelay(0, 3000)).toBe(3000)
    expect(pollDelay(1, 3000)).toBe(6000)
    expect(pollDelay(2, 3000)).toBe(12000)
    expect(pollDelay(3, 3000)).toBe(24000)
    expect(pollDelay(9, 3000)).toBe(24000)
    expect(pollDelay(9, 20000)).toBe(30000)
  })
})
