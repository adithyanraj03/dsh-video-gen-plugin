import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VideoJobStore, applyJobPayload, mapStatus, toJobView } from '../src/jobs.js'
import type { NinferClient } from '../src/ninfer.js'
import type { VideoJobRecord } from '../src/shared.js'

const record = (overrides: Partial<VideoJobRecord> = {}): VideoJobRecord => ({
  id: 'video_abc', provider: 'ninfer', model: 'ltx-2.5', prompt: 'a cat surfing', status: 'in_progress',
  progress: 10, seconds: 5, size: '1280x704', enhance: false, fromPicture: false,
  createdAt: 1_000, updatedAt: 1_000, ...overrides,
})

/** Canned server: one create call, then the polled states, then the MP4. */
function fakeClient(states: string[], clip = new Uint8Array([1, 2, 3, 4])): { client: NinferClient; polls: () => number } {
  let polls = 0
  const client: NinferClient = {
    baseURL: 'https://ninfer.test/v1',
    token: 't',
    fetchFn: async (url) => {
      if (url.endsWith('/videos') ) {
        return new Response(JSON.stringify({ id: 'video_abc', status: 'queued', progress: 0, seconds: '5', size: '1280x704' }), { status: 200 })
      }
      if (url.includes('/content?variant=thumbnail')) {
        return new Response(new Uint8Array([9, 9]), { status: 200 })
      }
      if (url.endsWith('/content')) {
        return new Response(clip, { status: 200 })
      }
      const status = states[Math.min(polls, states.length - 1)]
      polls += 1
      const body = status === 'completed'
        ? { id: 'video_abc', status, progress: 100, seconds: '5', size: '1280x704', file: 'video_abc.mp4', thumb: 'video_abc.jpg' }
        : status === 'failed'
          ? { id: 'video_abc', status, progress: 100, error: { code: 'timeout', message: 'took too long' } }
          : { id: 'video_abc', status, progress: 40, stage: 'render', queue_position: 1 }
      return new Response(JSON.stringify(body), { status: 200 })
    },
  }
  return { client, polls: () => polls }
}

const noSleep = async (): Promise<void> => undefined

describe('mapStatus', () => {
  it('folds the API vocabulary into the store vocabulary', () => {
    expect(mapStatus('queued')).toBe('queued')
    expect(mapStatus('processing')).toBe('in_progress')
    expect(mapStatus('in-progress')).toBe('in_progress')
    expect(mapStatus('succeeded')).toBe('completed')
    expect(mapStatus('error')).toBe('failed')
    expect(mapStatus('canceled')).toBe('cancelled')
    expect(mapStatus('something new')).toBe('in_progress')
  })
})

describe('applyJobPayload', () => {
  it('carries progress, stage, and queue position forward', () => {
    const next = applyJobPayload(record(), { id: 'video_abc', status: 'in_progress', progress: 61, stage: 'decode', queuePosition: 2 }, 2_000)
    expect(next).toMatchObject({ status: 'in_progress', progress: 61, stage: 'decode', queuePosition: 2, updatedAt: 2_000 })
    expect(next.completedAt).toBeUndefined()
  })

  it('stamps completion time and explains failures', () => {
    const done = applyJobPayload(record(), { id: 'video_abc', status: 'completed', progress: 100 }, 2_000)
    expect(done.completedAt).toBe(2_000)
    const failed = applyJobPayload(record(), { id: 'video_abc', status: 'failed', progress: 100, error: { code: 'timeout', message: 'slow' } }, 3_000)
    expect(failed.status).toBe('failed')
    expect(failed.errorCode).toBe('timeout')
    expect(failed.error).toMatch(/timed out/)
  })
})

describe('toJobView', () => {
  it('hides host paths from the browser', () => {
    const view = toJobView(record({ videoFile: 'C:\\Users\\x\\.dsh\\plugins\\video-gen\\videos\\clip.mp4', savedTo: 'C:\\ws\\videos\\clip.mp4' }))
    expect(view.videoName).toBe('clip.mp4')
    expect(JSON.stringify(view)).not.toContain('Users')
  })
})

describe('VideoJobStore', () => {
  it('submits, polls to completion, stores the clip, and persists history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-jobs-'))
    const { client } = fakeClient(['queued', 'in_progress', 'completed'])
    const store = new VideoJobStore({ dir, client: async () => client, sleep: noSleep })
    const submitted = await store.submit({ model: 'ltx-2.5', prompt: 'a cat surfing', seconds: 5, size: '1280x704', enhance: false })
    expect(submitted.id).toBe('video_abc')

    const outcome = await store.waitFor('video_abc', 5_000)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.record.status).toBe('completed')
    expect(outcome.record.videoFile).toBeDefined()
    expect(outcome.record.videoBytes).toBe(4)

    const files = await readdir(dir)
    expect(files.some(name => name.endsWith('.mp4'))).toBe(true)
    expect(files.some(name => name.endsWith('.jpg'))).toBe(true)

    const history = JSON.parse(await readFile(join(dir, 'jobs.json'), 'utf8')) as { jobs: VideoJobRecord[] }
    expect(history.jobs[0]?.status).toBe('completed')

    const reopened = new VideoJobStore({ dir, client: async () => client, sleep: noSleep })
    await reopened.load()
    expect(reopened.get('video_abc')?.status).toBe('completed')
  })

  it('marks a terminal failure with the actionable server reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-jobs-'))
    const { client } = fakeClient(['failed'])
    const store = new VideoJobStore({ dir, client: async () => client, sleep: noSleep })
    await store.submit({ model: 'ltx-2.5', prompt: 'p', seconds: 5, size: '1280x704', enhance: false })
    const outcome = await store.waitFor('video_abc', 5_000)
    expect(outcome.record.status).toBe('failed')
    expect(outcome.record.error).toMatch(/shorter clip|fewer seconds|timed out/)
  })

  it('returns a job id immediately when the grace window is zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-jobs-'))
    const { client } = fakeClient(['in_progress', 'completed'])
    const store = new VideoJobStore({ dir, client: async () => client, sleep: noSleep })
    await store.submit({ model: 'ltx-2.5', prompt: 'p', seconds: 5, size: '1280x704', enhance: false })
    const outcome = await store.waitFor('video_abc', 0)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.record.status).not.toBe('completed')
  })

  it('cancels a running job and records the outcome', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-jobs-'))
    const { client } = fakeClient(['in_progress'])
    const store = new VideoJobStore({ dir, client: async () => client, sleep: noSleep })
    await store.submit({ model: 'ltx-2.5', prompt: 'p', seconds: 5, size: '1280x704', enhance: false })
    const cancelled = await store.cancel('video_abc')
    expect(cancelled.status).toBe('cancelled')
    await expect(store.cancel('video_unknown')).rejects.toThrow(/unknown to this host/)
  })

  it('turns a non-terminal leftover into an interrupted record on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-jobs-'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'jobs.json'), JSON.stringify({
      version: 1,
      jobs: [{ ...record({ status: 'in_progress' }), createdAt: 5, updatedAt: 6 }],
    }))
    const { client } = fakeClient(['in_progress'])
    const store = new VideoJobStore({ dir, client: async () => client, sleep: noSleep })
    await store.load()
    expect(store.get('video_abc')?.status).toBe('interrupted')
  })

  it('runs the completion hook exactly once per finished clip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-jobs-'))
    const { client } = fakeClient(['completed'])
    let calls = 0
    const store = new VideoJobStore({
      dir,
      client: async () => client,
      sleep: noSleep,
      afterComplete: async finished => {
        calls += 1
        return { ...finished, savedTo: join(dir, 'copy.mp4') }
      },
    })
    await store.submit({ model: 'ltx-2.5', prompt: 'p', seconds: 5, size: '1280x704', enhance: false })
    const outcome = await store.waitFor('video_abc', 5_000)
    expect(calls).toBe(1)
    expect(outcome.record.savedTo).toBe(join(dir, 'copy.mp4'))
  })
})
