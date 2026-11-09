import { describe, expect, it } from 'vitest'
import {
  Config,
  connectionKeyRef,
  normalizeBaseUrl,
  resolveVideoTarget,
  toolNames,
  usableConnections,
} from '../src/config.js'
import type { Config as ConfigShape } from '../src/config.js'
import { connectionSlug, defaultKeyRef } from '../src/shared.js'

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

const endpoint = (overrides: Record<string, unknown> = {}) => ({
  id: 'host-a', label: 'Host A', baseUrl: 'https://video.test/v1', model: 'video-model', apiKeyRef: '',
  ...overrides,
})

describe('Config schema', () => {
  it('ships without any endpoint, so nothing names a vendor', () => {
    const config = resolved({})
    expect(config.connections).toEqual([])
    expect(config.baseUrl).toBe('')
    expect(config.model).toBe('')
    expect(config.provider).toBe('custom')
  })

  it('hands every field over as a live volatile box', () => {
    const raw = Config({}) as unknown as Record<string, unknown>
    expect(typeof (raw.connections as { get?: unknown }).get).toBe('function')
  })

  it('accepts endpoint rows and keeps their fields', () => {
    const config = resolved({ connections: [endpoint({ seconds: 8, size: '1080p' })] })
    const rows = usableConnections(config)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'host-a', baseUrl: 'https://video.test/v1', model: 'video-model', seconds: 8, size: '1080p' })
  })

  it('marks every field volatile, which the 0.1.7 settings form needs', () => {
    const fields = Object.values(Config.dict ?? {})
    expect(fields.length).toBeGreaterThan(10)
    for (const field of fields) expect(field.meta.volatile).toBe(true)
  })

  it('rejects an unknown tool-name family', () => {
    expect(() => Config({ toolNameSet: 'other' } as never)).toThrow()
  })
})

describe('resolveVideoTarget', () => {
  it('refuses to guess when no endpoint is configured', () => {
    expect(() => resolveVideoTarget(resolved({}))).toThrow(/No video endpoint is configured/)
  })

  it('resolves the first endpoint and its defaults', () => {
    const target = resolveVideoTarget(resolved({ connections: [endpoint()] }))
    expect(target).toMatchObject({
      connectionId: 'host-a',
      label: 'Host A',
      baseURL: 'https://video.test/v1',
      model: 'video-model',
      keyRef: 'VIDEO_GEN_KEY_HOST_A',
      pollIntervalMs: 3_000,
      waitGraceMs: 120_000,
    })
  })

  it('honours the active endpoint and per-endpoint overrides', () => {
    const target = resolveVideoTarget(resolved({
      connections: [endpoint(), endpoint({ id: 'host-b', label: 'B', baseUrl: 'https://b.test/v1', seconds: 10, fps: 30 })],
      activeConnection: 'host-b',
      defaultSeconds: 5,
    }))
    expect(target.connectionId).toBe('host-b')
    expect(target.defaultSeconds).toBe(10)
    expect(target.defaultFps).toBe(30)
  })

  it('falls back to the first endpoint when the active id is stale', () => {
    expect(resolveVideoTarget(resolved({ connections: [endpoint()], activeConnection: 'gone' })).connectionId).toBe('host-a')
  })

  it('uses the config-only fallback when no endpoint rows exist', () => {
    const target = resolveVideoTarget(resolved({ baseUrl: 'https://legacy.test/v1', model: 'm' }))
    expect(target.connectionId).toBe('default')
    expect(target.baseURL).toBe('https://legacy.test/v1')
  })

  it('takes a per-call model override', () => {
    expect(resolveVideoTarget(resolved({ connections: [endpoint()] }), undefined, 'other-model').model).toBe('other-model')
  })

  it('names the missing model', () => {
    expect(() => resolveVideoTarget(resolved({ connections: [endpoint({ model: '  ' })] }))).toThrow(/no model id/)
  })

  it('ignores endpoint rows with a blank URL', () => {
    expect(usableConnections(resolved({ connections: [endpoint({ baseUrl: '   ' })] }))).toEqual([])
  })
})

describe('normalizeBaseUrl', () => {
  it('trims a trailing slash', () => {
    expect(normalizeBaseUrl('https://x.test/v1///')).toBe('https://x.test/v1')
  })

  it('rejects a non-URL or a non-http scheme', () => {
    expect(() => normalizeBaseUrl('not a url')).toThrow(/not a valid http\(s\) URL/)
    expect(() => normalizeBaseUrl('ftp://x.test/v1')).toThrow(/not a valid http\(s\) URL/)
  })
})

describe('credential naming', () => {
  it('derives a stable per-endpoint reference', () => {
    expect(connectionKeyRef({ id: 'host-a', apiKeyRef: '' })).toBe('VIDEO_GEN_KEY_HOST_A')
    expect(connectionKeyRef({ id: 'my host', apiKeyRef: '' })).toBe('VIDEO_GEN_KEY_MY_HOST')
  })

  it('keeps an explicit reference', () => {
    expect(connectionKeyRef({ id: 'host-a', apiKeyRef: 'MY_EXISTING_KEY' })).toBe('MY_EXISTING_KEY')
  })

  it('upper-cases and truncates the derived segment', () => {
    expect(defaultKeyRef('a'.repeat(80))).toHaveLength(40)
    expect(defaultKeyRef('')).toBe('DEFAULT')
  })

  it('builds collision-free slugs', () => {
    expect(connectionSlug('My endpoint')).toBe('my-endpoint')
    expect(connectionSlug('My endpoint', ['my-endpoint'])).toBe('my-endpoint-2')
  })
})

describe('tool names', () => {
  it('claims the generic family by default', () => {
    expect(toolNames(resolved({}))).toEqual({ generate: 'generate_video', status: 'check_video', cancel: 'cancel_video' })
  })

  it('namespaces the tool names when asked', () => {
    const prefixed = { generate: 'videogen_generate_video', status: 'videogen_check_video', cancel: 'videogen_cancel_video' }
    expect(toolNames(resolved({ toolNameSet: 'prefixed' }))).toEqual(prefixed)
  })
})

