import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { CANCEL_ROUTE, CREDENTIAL_ROUTE, JOBS_ROUTE, MODELS_ROUTE, SETTINGS_HEALTH_ROUTE, TEST_CONNECTION_ROUTE, THUMB_ROUTE, VIDEO_ROUTE } from '../src/shared.js'

/** Minimal cordis Context with just the surfaces this fiber touches. */
function fakeContext(options: { withWeb?: boolean; settingsInstaller?: boolean } = {}) {
  const tools: Record<string, { name: string; description: string; parameters: Record<string, unknown>; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = {}
  const routes: { path: string; kind: string }[] = []
  const effects: string[] = []
  const warnings: string[] = []
  const sections: unknown[] = []
  const ctx: Record<string, unknown> = {
    tools: { register: (tool: never) => { const record = tool as unknown as { name: string }; tools[record.name] = tool as never } },
    attachments: { readImage: async () => { throw new Error('no attachment store in this test') } },
    credentials: { resolve: async () => ({ value: ' test-token ' }) },
    logger: { info: () => undefined, warn: (message: string) => warnings.push(message), error: () => undefined, debug: () => undefined },
    inject: (names: string[], callback: (ctx: unknown) => unknown) => {
      if (!names.every(name => name in ctx)) return undefined
      return callback(ctx)
    },
    effect: (run: () => unknown, label?: string) => {
      effects.push(label ?? 'effect')
      const cleanup = run()
      return typeof cleanup === 'function' ? cleanup : () => undefined
    },
    connection: { requestRejection: () => undefined },
    get: () => undefined,
    slots: {
      register: () => () => undefined,
      inject: (_key: string, callback: () => unknown) => {
        callback()
        return () => undefined
      },
    },
  }
  if (options.withWeb !== false) {
    ctx.webServer = { register: (route: { path: string; kind: string }) => { routes.push(route); return () => undefined } }
  }
  if (options.settingsInstaller === true) {
    ctx.settings = {
      describe: () => undefined,
      installSection: (...args: unknown[]) => { sections.push(args) },
    }
  }
  return { ctx: ctx as never, tools, routes, effects, warnings, sections }
}

describe('fiber registration', () => {
  it('registers the three generic tools with concrete descriptions', () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, {})
    expect(Object.keys(tools).sort()).toEqual(['cancel_video', 'check_video', 'generate_video'])
    for (const tool of Object.values(tools)) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.description.length).toBeLessThan(1200)
    }
    expect(Object.keys((tools.generate_video!.parameters as { properties: Record<string, unknown> }).properties)).toContain('prompt')
  })

  it('never exposes a boolean tool parameter, which the harness refuses to model well', () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, {})
    const walk = (schema: Record<string, unknown>): void => {
      for (const field of Object.values(schema)) {
        const descriptor = field as Record<string, unknown>
        expect(descriptor.type).not.toBe('boolean')
        if (typeof descriptor.items === 'object' && descriptor.items !== null) walk(descriptor.items as Record<string, unknown>)
        if (typeof descriptor.properties === 'object' && descriptor.properties !== null) walk(descriptor.properties as Record<string, unknown>)
      }
    }
    for (const tool of Object.values(tools)) walk(tool.parameters)
  })

  it('honours the prefixed tool-name family', () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, { toolNameSet: 'prefixed' })
    expect(Object.keys(tools).sort()).toEqual(['videogen_cancel_video', 'videogen_check_video', 'videogen_generate_video'])
  })

  it('registers every browser route exactly once', () => {
    const { ctx, routes } = fakeContext()
    apply(ctx, {})
    const paths = routes.map(route => route.path).sort()
    expect(paths).toEqual([CANCEL_ROUTE, CREDENTIAL_ROUTE, JOBS_ROUTE, MODELS_ROUTE, SETTINGS_HEALTH_ROUTE, TEST_CONNECTION_ROUTE, THUMB_ROUTE, VIDEO_ROUTE].sort())
  })

  it('still loads without a web server, so headless profiles keep the tools', () => {
    const { ctx, tools, routes } = fakeContext({ withWeb: false })
    apply(ctx, {})
    expect(Object.keys(tools)).toHaveLength(3)
    expect(routes).toHaveLength(0)
  })

  it('installs the settings section only when the host exposes the old installer', () => {
    const withoutInstaller = fakeContext()
    apply(withoutInstaller.ctx, {})
    expect(withoutInstaller.sections).toHaveLength(0)

    const withInstaller = fakeContext({ settingsInstaller: true })
    apply(withInstaller.ctx, {})
    expect(withInstaller.sections).toHaveLength(1)
    expect(withInstaller.sections[0]).toHaveLength(5)
  })
})

describe('tool execute guards', () => {
  it('refuses an empty prompt before touching the network', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, {})
    await expect(tools.generate_video!.execute({ prompt: '   ' }, { signal: new AbortController().signal }))
      .rejects.toThrow(/non-empty prompt/)
  })

  it('asks for a job id when cancel_video is called without one', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, {})
    await expect(tools.cancel_video!.execute({ job_id: ' ' }, { signal: new AbortController().signal }))
      .rejects.toThrow(/needs the job id/)
  })

  it('reports a job id this host and the server both miss', async () => {
    const { ctx, tools } = fakeContext()
    apply(ctx, {})
    await expect(tools.check_video!.execute({ job_id: 'video_missing' }, { signal: new AbortController().signal }))
      .rejects.toThrow()
  })
})

describe('renderers', () => {
  it('describe a completed clip with its workspace path', async () => {
    const module = await import('../src/index.js')
    expect(typeof module.describeRecord).toBe('function')
    const { renderVideoResult } = module
    const text = renderVideoResult({
      jobId: 'video_abc', status: 'completed', progress: 100, prompt: 'a cat surfing',
      model: 'video-model', seconds: 5, size: '1280x704', fromPicture: false, waitedMs: 42_000,
      savedTo: 'C:\\ws\\videos\\clip.mp4', videoPath: 'C:\\dsh\\clip.mp4',
    })
    expect(text).toMatch(/Video ready/)
    expect(text).toMatch(/after 42s/)
    expect(text).toMatch(/Saved to C:\\ws\\videos\\clip\.mp4/)
    expect(text).toMatch(/a cat surfing/)
  })

  it('describe a running clip with the follow-up tool', async () => {
    const { renderVideoResult } = await import('../src/index.js')
    const text = renderVideoResult({
      jobId: 'video_abc', status: 'in_progress', progress: 40, prompt: 'p', model: 'video-model',
      seconds: 5, size: '1280x704', fromPicture: true, waitedMs: 0, queuePosition: 1, stage: 'render',
    })
    expect(text).toMatch(/still in_progress/)
    expect(text).toMatch(/check_video/)
  })
})

