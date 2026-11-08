import { describe, expect, it } from 'vitest'
import { Config, resolveVideoTarget, toolNames, withVideoModelOverride } from '../src/config.js'
import type { Config as ConfigShape } from '../src/config.js'

/**
 * Unwrap the volatile boxes a 0.1.7 host hands over. This mirrors the
 * `plainConfig` walk in `src/index.ts`; a test that skipped it would read
 * `{ get: [Function] }` where the fiber reads a value, so keeping the helper
 * here also keeps the two in step.
 */
function plain(source: unknown): ConfigShape {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    out[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get(): unknown }).get()
      : value
  }
  return out as ConfigShape
}

const resolved = (input: unknown): ConfigShape => plain(Config(input as never))

describe('Config schema', () => {
  it('hands every field over as a live volatile box', () => {
    const raw = Config({ provider: 'ninfer' }) as unknown as Record<string, unknown>
    expect(typeof (raw.provider as { get?: unknown }).get).toBe('function')
  })

  it('accepts the row the bundle patch ships', () => {
    const config = resolved({ provider: 'ninfer' })
    expect(config.provider).toBe('ninfer')
    expect(config.baseUrl).toBe('https://ninfer.neronexusai.com/v1')
    expect(config.model).toBe('ltx-2.5')
    expect(config.defaultSize).toBe('720p')
    expect(config.toolNameSet).toBe('generic')
    expect(config.saveToWorkspace).toBe(true)
  })

  it('accepts an empty row and an undefined row', () => {
    expect(resolved({}).provider).toBe('ninfer')
    expect(resolved(undefined).model).toBe('ltx-2.5')
  })

  it('rejects an unknown provider or tool-name family', () => {
    expect(() => Config({ provider: 'openai' } as never)).toThrow()
    expect(() => Config({ toolNameSet: 'other' } as never)).toThrow()
  })

  it('marks every field volatile, which the 0.1.7 settings form needs', () => {
    const fields = Object.values(Config.dict ?? {})
    expect(fields.length).toBeGreaterThan(10)
    for (const field of fields) expect(field.meta.volatile).toBe(true)
  })
})

describe('resolveVideoTarget', () => {
  it('resolves the defaults', () => {
    const target = resolveVideoTarget(resolved({}))
    expect(target).toMatchObject({
      provider: 'ninfer',
      baseURL: 'https://ninfer.neronexusai.com/v1',
      model: 'ltx-2.5',
      keyRef: 'NINFER_API_KEY',
      pollIntervalMs: 3_000,
      waitGraceMs: 120_000,
      jobTimeoutMs: 3_600_000,
    })
  })

  it('trims a trailing slash off the endpoint', () => {
    expect(resolveVideoTarget(resolved({ baseUrl: 'https://example.test/v1///' })).baseURL).toBe('https://example.test/v1')
  })

  it('refuses a blank endpoint or model with a settings hint', () => {
    expect(() => resolveVideoTarget({ baseUrl: '   ' })).toThrow(/base URL/)
    expect(() => resolveVideoTarget({ baseUrl: 'not a url' })).toThrow(/valid http\(s\) URL/)
    expect(() => resolveVideoTarget({ model: '  ' })).toThrow(/requires a model id/)
  })

  it('keeps an optional orientation only when it is set', () => {
    expect(resolveVideoTarget(resolved({})).defaultOrientation).toBeUndefined()
    expect(resolveVideoTarget(resolved({ defaultOrientation: 'portrait' })).defaultOrientation).toBe('portrait')
  })
})

describe('tool names', () => {
  it('claims the generic family by default', () => {
    expect(toolNames(resolved({}))).toEqual({ generate: 'video_generate', status: 'video_status', cancel: 'video_cancel' })
  })

  it('falls back to the ninfer family when asked', () => {
    expect(toolNames(resolved({ toolNameSet: 'ninfer' }))).toEqual({
      generate: 'ninfer_video_generate', status: 'ninfer_video_status', cancel: 'ninfer_video_cancel',
    })
  })
})

describe('withVideoModelOverride', () => {
  it('overrides only when a model was passed', () => {
    expect(withVideoModelOverride({ model: 'a' }, ' b ').model).toBe('b')
    expect(withVideoModelOverride({ model: 'a' }, '  ').model).toBe('a')
    expect(withVideoModelOverride({ model: 'a' }, undefined).model).toBe('a')
  })
})
