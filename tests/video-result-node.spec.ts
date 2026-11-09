import { describe, expect, it } from 'vitest'
import {
  VIDEO_RESULT_NODE_KIND,
  createVideoResultDefinition,
  videoResultsFromMeta,
  videoResultsFromPtcDispatch,
  type VideoResultPresentation,
} from '../src/client/video-result-node.js'
import { readVideoArgs, videoMetaFromPresentation } from '../src/client/video-toolview.js'

const meta = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'dsh-video-gen',
  jobId: 'video_1a2b3c4d5e6f',
  status: 'completed',
  prompt: 'a robot docks in for the night shift',
  model: 'ltx-2',
  seconds: 5,
  size: '1280x704',
  createdAt: 19700121182333000,
  ...overrides,
})

describe('videoResultsFromMeta', () => {
  it('accepts every job state the plugin reports', () => {
    for (const status of ['queued', 'in_progress', 'completed', 'failed', 'cancelled', 'interrupted']) {
      const [result] = videoResultsFromMeta(meta({ status }))
      expect(result?.jobId).toBe('video_1a2b3c4d5e6f')
      expect(result?.status).toBe(status)
    }
  })

  it('keeps the optional fields only when present', () => {
    const [result] = videoResultsFromMeta(meta({ seed: 7, savedTo: 'B:\\x\\clip.mp4' }))
    expect(result?.seed).toBe(7)
    expect(result?.savedTo).toBe('B:\\x\\clip.mp4')
    const [plain] = videoResultsFromMeta(meta({}))
    expect(plain?.seed).toBeUndefined()
    expect(plain?.savedTo).toBeUndefined()
  })

  it('rejects the other presentation kinds, missing ids, and unknown states', () => {
    expect(videoResultsFromMeta(meta({ kind: 'dsh-video-gen-check' }))).toEqual([])
    expect(videoResultsFromMeta(meta({ kind: 'dsh-video-gen-list', jobs: [] }))).toEqual([])
    expect(videoResultsFromMeta(meta({ jobId: undefined }))).toEqual([])
    expect(videoResultsFromMeta(meta({ status: 'bogus' }))).toEqual([])
    expect(videoResultsFromMeta(undefined)).toEqual([])
    expect(videoResultsFromMeta('video_1a2b3c4d5e6f')).toEqual([])
  })
})

describe('videoResultsFromPtcDispatch', () => {
  const dispatch = (text: string, overrides: Record<string, unknown> = {}): { type: string; seq: number; data: Record<string, unknown> } => ({
    type: 'tool/ptc-dispatch',
    seq: 9,
    data: {
      subCallId: 'sub-1',
      name: 'generate_video',
      isError: false,
      content: [{ type: 'text', text }],
      arguments: { prompt: 'a lighthouse in a storm', seconds: 5, size: '720p', seed: 11 },
      ...overrides,
    },
  })

  it('parses a completed PTC summary', () => {
    const text = 'Video ready (5s at 1280x704) as job video_1a2b3c4d5e6f after 0m 41s.\nSaved to B:\\x\\clip.mp4\nThe clip plays inline in the tool card. Prompt: a lighthouse in a storm'
    const [result] = videoResultsFromPtcDispatch(dispatch(text))
    expect(result).toMatchObject({ jobId: 'video_1a2b3c4d5e6f', status: 'completed', prompt: 'a lighthouse in a storm', seconds: 5, seed: 11 })
  })

  it('parses an in-flight PTC summary', () => {
    const [queued] = videoResultsFromPtcDispatch(dispatch('Video job video_1a2b3c4d5e6f is still queued (0%).\nCall check_video with job_id "video_1a2b3c4d5e6f" to follow it.'))
    expect(queued?.status).toBe('queued')
    const [working] = videoResultsFromPtcDispatch(dispatch('Video job video_1a2b3c4d5e6f is still in_progress (42%, KSamplerAdvanced).'))
    expect(working?.status).toBe('in_progress')
  })

  it('parses a failed PTC summary', () => {
    const [failed] = videoResultsFromPtcDispatch(dispatch('Video job video_1a2b3c4d5e6f failed (5s at 1280x704): timeout\nPrompt: a lighthouse in a storm'))
    expect(failed?.status).toBe('failed')
  })

  it('ignores errors, foreign tools, and summaries without a job id', () => {
    expect(videoResultsFromPtcDispatch(dispatch('Video ready (5s at 720p) as job video_1a2b3c4d5e6f.', { isError: true }))).toEqual([])
    expect(videoResultsFromPtcDispatch(dispatch('Video ready (5s at 720p) as job video_1a2b3c4d5e6f.', { name: 'generate_image' }))).toEqual([])
    expect(videoResultsFromPtcDispatch(dispatch('Nothing to see here.'))).toEqual([])
    expect(videoResultsFromPtcDispatch({ type: 'tool/result', seq: 1, data: {} })).toEqual([])
  })
})

describe('createVideoResultDefinition', () => {
  const definition = createVideoResultDefinition()
  const resultEvent = (seq: number, withMeta = true): { type: string; seq: number; data: Record<string, unknown> } => ({
    type: 'tool/result',
    seq,
    data: { turn: 3, ...(withMeta ? { meta: meta({}) } : {}) },
  })

  it('matches tool/result events carrying a plugin video meta, with or without a turn', () => {
    expect(definition.kind).toBe(VIDEO_RESULT_NODE_KIND)
    expect(definition.target).toBe('chat')
    expect(definition.match(resultEvent(11))).toEqual({ id: 'result:11', role: 'start' })
    expect(definition.match(resultEvent(12, false))).toBeNull()
    // Live results may arrive before the harness stamps a turn; the row is
    // still created at that seq (the key does not depend on the turn).
    expect(definition.match({ type: 'tool/result', seq: 13, data: { meta: meta({}) } })).toEqual({ id: 'result:13', role: 'start' })
    expect(definition.match({ type: 'chat/text', seq: 14, data: {} })).toBeNull()
  })

  it('starts a turn-less result without a turn in its state', () => {
    const event = { type: 'tool/result', seq: 15, data: { meta: meta({}) } }
    const state = definition.start({ key: 'k', id: 'n', matches: [], start: { event, location: undefined } }, { event, location: undefined }, undefined)
    expect(state.turn).toBeUndefined()
    expect(state.results[0]?.jobId).toBe('video_1a2b3c4d5e6f')
  })

  it('matches successful PTC dispatches keyed by sub-call', () => {
    const event = {
      type: 'tool/ptc-dispatch',
      seq: 21,
      data: {
        subCallId: 'sub-9',
        name: 'generate_video',
        isError: false,
        content: [{ type: 'text', text: 'Video ready (5s at 720p) as job video_1a2b3c4d5e6f.' }],
      },
    }
    expect(definition.match(event)).toEqual({ id: 'ptc:sub-9', role: 'start' })
  })

  it('starts a native result with its turn and seq-stamped results', () => {
    const state = definition.start({ key: 'k', id: 'n', matches: [], start: { event: resultEvent(11), location: undefined } }, { event: resultEvent(11), location: undefined }, undefined)
    expect(state.turn).toBe(3)
    expect(state.results).toHaveLength(1)
    expect(state.results[0]).toMatchObject({ jobId: 'video_1a2b3c4d5e6f', seq: 11 })
  })

  it('starts a PTC result without a turn', () => {
    const match = {
      event: {
        type: 'tool/ptc-dispatch',
        seq: 21,
        data: {
          subCallId: 'sub-9',
          name: 'generate_video',
          isError: false,
          content: [{ type: 'text', text: 'Video ready (5s at 720p) as job video_1a2b3c4d5e6f.' }],
        },
      },
      location: undefined,
    }
    const state = definition.start({ key: 'k', id: 'n', matches: [], start: match }, match, undefined)
    expect(state.turn).toBeUndefined()
    expect(state.results[0].status).toBe('completed')
  })

  it('merges PTC re-dispatches without duplicating a job', () => {
    const first = definition.start(
      { key: 'k', id: 'n', matches: [], start: { event: resultEvent(11), location: undefined } },
      { event: resultEvent(11), location: undefined },
      undefined,
    )
    const ptcMatch = {
      event: {
        type: 'tool/ptc-dispatch',
        seq: 22,
        data: {
          subCallId: 'sub-9',
          name: 'generate_video',
          isError: false,
          content: [{ type: 'text', text: 'Video ready (5s at 720p) as job video_1a2b3c4d5e6f.' }],
        },
      },
      location: undefined,
    }
    const updated = definition.update({ ...{ key: 'k', id: 'n', matches: [], start: { event: resultEvent(11), location: undefined } }, state: first }, ptcMatch)
    expect(updated.results).toHaveLength(1)
  })

  it('builds a session-located chat node anchored at its first event', () => {
    const state = definition.start(
      { key: 'k', id: 'n', matches: [], start: { event: resultEvent(11), location: undefined } },
      { event: resultEvent(11), location: undefined },
      undefined,
    )
    const node = definition.buildViewNode({ key: 'k', id: 'n', matches: [], state })
    expect(node).toMatchObject({
      kind: VIDEO_RESULT_NODE_KIND,
      id: 'n',
      target: 'chat',
      anchorSeq: 11,
      location: { kind: 'session' },
      visibility: 'visible',
    })
    expect(node?.data).toMatchObject({ turn: 3 })
    const results = (node?.data as { results: VideoResultPresentation[] }).results
    expect(results).toHaveLength(1)
    expect(results[0]).not.toHaveProperty('seq')
  })

  it('builds nothing without state', () => {
    expect(definition.buildViewNode({ key: 'k', id: 'n', matches: [] })).toBeNull()
  })
})

describe('readVideoArgs', () => {
  it('parses a running-stage block', () => {
    expect(readVideoArgs({ callId: 'c1', argsRaw: '{"prompt":"a lighthouse","seconds":5,"size":"720p","seed":3}' }))
      .toEqual({ prompt: 'a lighthouse', seconds: 5, size: '720p', seed: 3 })
  })

  it('keeps only the known numeric and string fields', () => {
    expect(readVideoArgs({ argsRaw: '{"prompt":"x","seconds":"5","size":42,"seed":"7","wait":"auto"}' })).toEqual({ prompt: 'x' })
  })

  it('tolerates still-streaming or foreign argument blobs', () => {
    expect(readVideoArgs({ argsRaw: '{"prompt":"a robo' })).toBeUndefined()
    expect(readVideoArgs({ argsRaw: '{"prompt":""}' })).toBeUndefined()
    expect(readVideoArgs({ argsRaw: '{"seconds":5}' })).toBeUndefined()
    expect(readVideoArgs({ meta: {} })).toBeUndefined()
    expect(readVideoArgs(undefined)).toBeUndefined()
  })
})

describe('videoMetaFromPresentation', () => {
  it('maps a stored presentation onto the card meta shape', () => {
    const result = videoMetaFromPresentation({ jobId: 'video_1', status: 'in_progress', prompt: 'p', seconds: 5, size: '720p', seed: 9, createdAt: 123, savedTo: 'B:\\x\\v.mp4' })
    expect(result).toEqual({
      kind: 'dsh-video-gen',
      jobId: 'video_1',
      status: 'in_progress',
      prompt: 'p',
      seconds: 5,
      size: '720p',
      seed: 9,
      createdAt: 123,
      savedTo: 'B:\\x\\v.mp4',
    })
  })
})
