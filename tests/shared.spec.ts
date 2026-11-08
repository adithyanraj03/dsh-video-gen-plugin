import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FPS,
  DEFAULT_SECONDS,
  clampFps,
  clampSeconds,
  formatDuration,
  isTerminalStatus,
  jobMatchesPrompt,
  normalizeVideoSize,
  orientSize,
  parseExactSize,
  safeFileName,
  selectJobForCall,
  sizeFromReference,
  snapSize,
  videoFileStem,
} from '../src/shared.js'

describe('normalizeVideoSize', () => {
  it('maps every tier to the pixel box the engine uses', () => {
    expect(normalizeVideoSize('480p')).toBe('896x512')
    expect(normalizeVideoSize('720p')).toBe('1280x704')
    expect(normalizeVideoSize('1080p')).toBe('1920x1088')
  })

  it('is case-insensitive and falls back to the configured default', () => {
    expect(normalizeVideoSize('720P')).toBe('1280x704')
    expect(normalizeVideoSize(undefined, undefined, '1080p')).toBe('1920x1088')
  })

  it('flips a tier for portrait and snaps exact boxes onto the lattice', () => {
    expect(normalizeVideoSize('720p', 'portrait')).toBe('704x1280')
    expect(normalizeVideoSize('500x300')).toBe('512x320')
  })

  it('fits oversized boxes inside the engine limit', () => {
    expect(normalizeVideoSize('3840x2160')).toBe('1920x1088')
  })

  it('refuses an unintelligible size with an actionable message', () => {
    expect(() => normalizeVideoSize('huge')).toThrow(/480p, 720p, 1080p, or an exact WxH/)
  })
})

describe('orientation and snapping', () => {
  it('swaps only when the requested orientation disagrees', () => {
    expect(orientSize(1280, 704, 'landscape')).toEqual({ width: 1280, height: 704 })
    expect(orientSize(1280, 704, 'portrait')).toEqual({ width: 704, height: 1280 })
    expect(orientSize(704, 1280, undefined)).toEqual({ width: 704, height: 1280 })
  })

  it('never returns a zero edge', () => {
    expect(snapSize(10, 10)).toEqual({ width: 64, height: 64 })
  })

  it('parses exact sizes only when both edges are plausible', () => {
    expect(parseExactSize('1280x704')).toEqual({ width: 1280, height: 704 })
    expect(parseExactSize('1280')).toBeUndefined()
    expect(parseExactSize('0x704')).toBeUndefined()
  })
})

describe('sizeFromReference', () => {
  it('honours an explicit size over the picture', () => {
    expect(sizeFromReference(1000, 2000, '1080p', undefined, '720p')).toBe('1920x1088')
  })

  it('picks a portrait box for a tall picture', () => {
    expect(sizeFromReference(1080, 1920, undefined, undefined, '720p')).toBe('704x1280')
  })

  it('picks a landscape box for a wide picture', () => {
    expect(sizeFromReference(1920, 1080, undefined, undefined, '720p')).toBe('1280x704')
  })

  it('falls back when the picture size is unknown', () => {
    expect(sizeFromReference(0, 0, undefined, undefined, '480p')).toBe('896x512')
  })
})

describe('numeric clamping', () => {
  it('clamps seconds into 1..30 and rounds', () => {
    expect(clampSeconds(undefined)).toBe(DEFAULT_SECONDS)
    expect(clampSeconds(0)).toBe(1)
    expect(clampSeconds(99)).toBe(30)
    expect(clampSeconds(7.6)).toBe(8)
    expect(clampSeconds('12')).toBe(12)
    expect(clampSeconds('nonsense')).toBe(DEFAULT_SECONDS)
  })

  it('clamps fps into 8..50', () => {
    expect(clampFps(undefined)).toBe(DEFAULT_FPS)
    expect(clampFps(1)).toBe(8)
    expect(clampFps(120)).toBe(50)
  })
})

describe('job matching', () => {
  const jobs = [
    { id: 'video_a', prompt: 'a cat surfing', status: 'in_progress' as const, createdAt: 1 },
    { id: 'video_b', prompt: 'a dog skating', status: 'in_progress' as const, createdAt: 2 },
  ]

  it('matches on the folded prompt', () => {
    expect(jobMatchesPrompt({ prompt: '  A Cat   Surfing ' }, 'a cat surfing')).toBe(true)
    expect(jobMatchesPrompt({ prompt: 'a dog skating' }, 'a cat surfing')).toBe(false)
  })

  it('prefers the prompt match among active jobs', () => {
    expect(selectJobForCall(jobs, 'a cat surfing')?.id).toBe('video_a')
  })

  it('uses the only active job when the prompt is unfamiliar', () => {
    expect(selectJobForCall([jobs[0]!], 'something else')?.id).toBe('video_a')
  })

  it('refuses to guess between two active jobs', () => {
    expect(selectJobForCall(jobs, 'unrelated')).toBeUndefined()
  })

  it('ignores terminal jobs', () => {
    expect(selectJobForCall([{ ...jobs[0]!, status: 'completed' as const }], 'a cat surfing')).toBeUndefined()
  })
})

describe('file naming and misc helpers', () => {
  it('builds a sortable, unique stem', () => {
    expect(videoFileStem({ id: 'video_0123456789abcdef', createdAt: Date.UTC(2026, 0, 2, 3, 4, 5) })).toBe('video-20260102T030405-89abcdef')
  })

  it('strips path separators from server names', () => {
    expect(safeFileName('../../etc/passwd')).toBe('etcpasswd')
    expect(safeFileName('')).toBe('video.mp4')
  })

  it('formats durations compactly', () => {
    expect(formatDuration(9_500)).toBe('10s')
    expect(formatDuration(65_000)).toBe('1m05s')
  })

  it('knows which states are final', () => {
    expect(isTerminalStatus('completed')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('interrupted')).toBe(true)
    expect(isTerminalStatus('queued')).toBe(false)
    expect(isTerminalStatus('in_progress')).toBe(false)
  })
})
