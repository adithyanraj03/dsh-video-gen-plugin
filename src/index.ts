/** Video-generation bundle for DeepSeek Harness, over any OpenAI-style async video API. */
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Config, resolveVideoTarget, toolNames } from './config.js'
import { requireApiKey, resolveApiKey } from './credentials.js'
import { VideoJobStore, toJobView, type SubmitRequest } from './jobs.js'
import { createClient, getModels, getVideo, type NinferError } from './ninfer.js'
import { resolveReference } from './reference-image.js'
import { describeSettingsHealth, serveSettingsHealth } from './settings-health.js'
import { credentialPorts, serveCredential, serveModels } from './settings-route.js'
import {
  CANCEL_ROUTE,
  CREDENTIAL_ROUTE,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WORKSPACE_FOLDER,
  ENHANCE_MODES,
  JOBS_ROUTE,
  MODELS_ROUTE,
  ORIENTATIONS,
  SETTINGS_HEALTH_ROUTE,
  TEST_CONNECTION_ROUTE,
  THUMB_ROUTE,
  VIDEO_GENERATION_NAMESPACE,
  VIDEO_ROUTE,
  WAIT_MODES,
  clampFps,
  clampSeconds,
  formatDuration,
  normalizeVideoSize,
  sizeFromReference,
  type EnhanceMode,
  type Orientation,
  type SettingsHealth,
  type VideoJobRecord,
  type WaitMode,
} from './shared.js'
import { serveCancel, serveJobFile, serveJobs, serveTestConnection } from './video-route.js'
import { withWebAdmission, type WebAdmission } from './web-route.js'
import { dshHome, getDshWorkspaceRoots, saveVideoToWorkspace, selectWorkspaceRoot } from './workspace-save.js'

export { Config } from './config.js'
export { VIDEO_ROUTE, THUMB_ROUTE, JOBS_ROUTE, CANCEL_ROUTE, MODELS_ROUTE, CREDENTIAL_ROUTE, TEST_CONNECTION_ROUTE, SETTINGS_HEALTH_ROUTE } from './shared.js'

export const name = 'dsh-video-gen'
export const inject = ['tools', 'attachments', 'credentials']

/** Arguments of `generate_video`, as the tool schema describes them. */
interface GenerateArgs {
  prompt: string
  seconds?: number | undefined
  size?: string | undefined
  orientation?: Orientation | undefined
  fps?: number | undefined
  seed?: number | undefined
  enhance?: EnhanceMode | undefined
  negative_prompt?: string | undefined
  model?: string | undefined
  image_url?: string | undefined
  source_attachment_id?: string | undefined
  source_path?: string | undefined
  wait?: WaitMode | undefined
}

/** One finished or running clip, as reported to the model and the toolview. */
interface VideoResult {
  jobId: string
  status: string
  progress: number
  prompt: string
  model: string
  seconds: number
  size: string
  fps?: number
  seed?: number
  fromPicture: boolean
  waitedMs: number
  videoPath?: string
  thumbPath?: string
  videoBytes?: number
  savedTo?: string
  thumbSavedTo?: string
  queuePosition?: number
  stage?: string
  error?: string
  note?: string
}

/** Settings hooks shape shared by both dsh-settings API generations. */
interface SettingsHooks {
  setSource: (source: () => Config) => void
  onChange: () => void
}

/** The `settings` Context service as typed by dsh-settings 0.1.2-0.1.6. */
interface SettingsSectionInstaller {
  installSection(ctx: Context, namespace: unknown, schema: unknown, entry: unknown, hooks: SettingsHooks): void
}

/** One-line status of a record, for tool text. */
export function describeRecord(record: VideoJobRecord): string {
  const parts = [`${record.id}: ${record.status}`, `${String(record.progress)}%`]
  if (record.stage !== undefined) parts.push(`stage ${record.stage}`)
  if (record.queuePosition !== undefined && record.status !== 'completed') parts.push(`queue ${String(record.queuePosition)}`)
  return parts.join(', ')
}

/** Render the human/agent-facing text of one video outcome. */
export function renderVideoResult(value: VideoResult): string {
  const spec = `${String(value.seconds)}s at ${value.size}${value.fps === undefined ? '' : `, ${String(value.fps)} fps`}${value.fromPicture ? ', first frame from the supplied picture' : ''}`
  if (value.status === 'completed') {
    const lines = [`Video ready (${spec}) as job ${value.jobId}${value.waitedMs > 0 ? ` after ${formatDuration(value.waitedMs)}` : ''}.`]
    if (value.savedTo !== undefined) lines.push(`Saved to ${value.savedTo}`)
    else if (value.videoPath !== undefined) lines.push(`Stored at ${value.videoPath}`)
    if (value.thumbPath !== undefined) lines.push(`Thumbnail: ${value.thumbPath}`)
    lines.push(`The clip plays inline in the tool card. Prompt: ${value.prompt}`)
    return lines.join('\n')
  }
  if (value.status === 'failed' || value.status === 'cancelled' || value.status === 'interrupted') {
    return `Video job ${value.jobId} ${value.status} (${spec}): ${value.error ?? 'no detail from the server'}\nPrompt: ${value.prompt}`
  }
  return `Video job ${value.jobId} is still ${value.status} (${String(value.progress)}%${value.stage === undefined ? '' : `, ${value.stage}`}${value.queuePosition === undefined ? '' : `, queue ${String(value.queuePosition)}`}).\nCall check_video with job_id "${value.jobId}" to follow it, or cancel_video to stop it. The clip is stored on this host when it finishes.\nPrompt: ${value.prompt}`
}

/** Leaf name of a stored path, for the tool result card. */
function fileBase(path: string): string {
  return path.split(/[\\/]/).pop() ?? 'video.mp4'
}

/** Project a record into the tool result. */
function toResult(record: VideoJobRecord, waitedMs: number): VideoResult {
  return {
    jobId: record.id,
    status: record.status,
    progress: record.progress,
    prompt: record.prompt,
    model: record.model,
    seconds: record.seconds,
    size: record.size,
    ...(record.fps === undefined ? {} : { fps: record.fps }),
    ...(record.seed === undefined ? {} : { seed: record.seed }),
    fromPicture: record.fromPicture,
    waitedMs,
    ...(record.videoFile === undefined ? {} : { videoPath: record.videoFile }),
    ...(record.thumbFile === undefined ? {} : { thumbPath: record.thumbFile }),
    ...(record.videoBytes === undefined ? {} : { videoBytes: record.videoBytes }),
    ...(record.savedTo === undefined ? {} : { savedTo: record.savedTo }),
    ...(record.thumbSavedTo === undefined ? {} : { thumbSavedTo: record.thumbSavedTo }),
    ...(record.queuePosition === undefined ? {} : { queuePosition: record.queuePosition }),
    ...(record.stage === undefined ? {} : { stage: record.stage }),
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

/** Output schema shared by every tool of this plugin. */
const VIDEO_OUTPUT_PROPERTIES = {
  jobId: { type: 'string', required: true },
  status: { type: 'string', required: true },
  progress: { type: 'integer', required: true },
  prompt: { type: 'string', required: true },
  model: { type: 'string', required: true },
  seconds: { type: 'integer', required: true },
  size: { type: 'string', required: true },
  fps: { type: 'integer' },
  seed: { type: 'integer' },
  fromPicture: { type: 'boolean', required: true },
  waitedMs: { type: 'integer', required: true },
  videoPath: { type: 'string' },
  thumbPath: { type: 'string' },
  videoBytes: { type: 'integer' },
  savedTo: { type: 'string' },
  thumbSavedTo: { type: 'string' },
  queuePosition: { type: 'integer' },
  stage: { type: 'string' },
  error: { type: 'string' },
  note: { type: 'string' },
} as const

export function apply(ctx: Context, config: Config = {}): void {
  // DSH 0.1.7 resolves every `.volatile()` schema field into a stable box whose
  // `.get()` returns the current snapshot, so a settings edit lands without
  // restarting this fiber. Unbox on every read; older hosts hand over plain
  // values, which the same walk returns untouched.
  const plainConfig = (source: Config): Config => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      out[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get(): unknown }).get()
        : value
    }
    return out as Config
  }
  let current: () => Config = () => plainConfig(config)

  /** Clip directory: configured override, else the plugin's own DSH_HOME folder. */
  const videosDir = (): string => {
    const configured = (current().videosDir ?? '').trim()
    return configured.length > 0 ? resolve(configured) : join(dshHome(), 'plugins', 'video-gen', 'videos')
  }
  const knownWorkspaceRoots = new Set<string>()
  /**
   * Workspace of the session that most recently called a video tool. A clip
   * that finishes while no turn is waiting still lands in the workspace the
   * user was working in, not in whichever root the store happens to see first.
   */
  let lastSessionRoot: string | undefined
  /** Remember the calling session's workspace so background copies land there. */
  const noteSession = (exec: { agent?: { session: { header?: { cwd?: string } } } }): void => {
    const cwd = exec.agent?.session.header?.cwd
    if (cwd === undefined || cwd.trim().length === 0) return
    const resolved = resolve(cwd)
    lastSessionRoot = resolved
    knownWorkspaceRoots.add(resolved)
  }

  /** Build a client for the active endpoint, resolving its token on the spot. */
  const makeClient = async (tool?: string, modelOverride?: string) => {
    const target = resolveVideoTarget(current(), undefined, modelOverride)
    const token = await requireApiKey(ctx, tool, target.keyRef)
    return { client: createClient({ baseURL: target.baseURL, token }), target }
  }

  /** Copy a finished clip into the session workspace exactly once. */
  const ensureWorkspaceCopy = async (record: VideoJobRecord): Promise<VideoJobRecord> => {
    const config = current()
    if (config.saveToWorkspace === false || record.videoFile === undefined || record.savedTo !== undefined) return record
    const roots = new Set([...knownWorkspaceRoots, ...(await getDshWorkspaceRoots().catch(() => []))])
    const root = lastSessionRoot ?? await selectWorkspaceRoot(roots)
    if (root === undefined) return record
    const folder = config.workspaceFolder ?? DEFAULT_WORKSPACE_FOLDER
    const savedTo = await saveVideoToWorkspace(record.videoFile, root, folder)
    knownWorkspaceRoots.add(root)
    const thumbSavedTo = record.thumbFile === undefined
      ? undefined
      : await saveVideoToWorkspace(record.thumbFile, root, folder).catch(() => undefined)
    return { ...record, savedTo, ...(thumbSavedTo === undefined ? {} : { thumbSavedTo }) }
  }

  const store = new VideoJobStore({
    dir: videosDir,
    client: async () => (await makeClient()).client,
    log: message => ctx.logger.info(`dsh-video-gen: ${message}`),
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    jobTimeoutMs: config.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    ...(config.maxVideoBytes === undefined ? {} : { maxVideoBytes: config.maxVideoBytes }),
    ...(config.saveThumbnail === undefined ? {} : { saveThumbnail: config.saveThumbnail }),
    ...(config.jobHistory === undefined ? {} : { history: config.jobHistory }),
    afterComplete: ensureWorkspaceCopy,
  })

  // Re-attach to renders the previous host started. Best effort by design: a
  // failure here must never keep the plugin from loading.
  ctx.effect(() => {
    if (current().resumeJobs === false) return () => undefined
    void store.resume().catch(error => ctx.logger.warn(`dsh-video-gen: could not resume jobs (${error instanceof Error ? error.message : String(error)})`))
    return () => undefined
  }, 'dsh-video-gen: resume unfinished jobs')

  const settingsHealth = installVideoSettings(ctx, config, {
    setSource: source => { current = source },
    onChange: () => undefined,
  })

  const names = toolNames(current())

  /** Register a tool, naming the fix when another plugin already owns the name. */
  const registerTool = (tool: Parameters<Context['tools']['register']>[0]): void => {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message} — another plugin owns that tool name. Set toolNameSet to "ninfer" in Settings > Plugins > Video generation and restart the host to register this plugin's tools as ninfer_video_* instead.`)
    }
  }

  registerTool(defineTool({
    name: names.generate,
    description: 'Generate a short video with audio from a prompt via Ninfer LTX-2.5. Use when the user asks for a video, clip, or animation; pass image_url, source_attachment_id, or source_path to animate a still picture as the first frame. Describe subject, motion, camera, lighting, and the sound or dialogue you want. Long renders return a job id: follow it with check_video, stop it with cancel_video. Do not call read or glob to verify the result; the clip plays in the tool card.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Complete shot description: subject, motion, camera, lighting, and the ambient sound or dialogue the clip should carry.' },
      seconds: { type: 'integer', description: 'Clip length in whole seconds, 1-30. Omit to use the configured default (5).' },
      size: { type: 'string', description: 'Resolution tier 480p, 720p, or 1080p, or an exact WxH such as 1280x704 (edges snap to multiples of 64, max 1920x1088). Omit to use the configured default.' },
      orientation: { type: 'string', enum: [...ORIENTATIONS], description: 'Force landscape or portrait. Omit to keep the aspect ratio implied by size, or to match the supplied first frame.' },
      fps: { type: 'integer', description: 'Frame rate 8-50. Omit to use 24.' },
      seed: { type: 'integer', description: 'Optional seed for a reproducible shot; reuse a seed to iterate on the same framing.' },
      enhance: { type: 'string', enum: [...ENHANCE_MODES], description: 'default follows the saved setting; on runs the server prompt enhancer first (adds 1-2 minutes), off skips it.' },
      negative_prompt: { type: 'string', description: 'What to keep out of the shot, e.g. "no text, no watermark, no camera shake".' },
      model: { type: 'string', description: 'Optional model id for this call only; omit to use the configured model (ltx-2.5).' },
      image_url: { type: 'string', description: 'http(s) URL of a PNG/JPEG/WebP picture to use as the first frame; the clip animates from it.' },
      source_attachment_id: { type: 'string', description: 'Attachment id of an image already in this conversation, used as the first frame.' },
      source_path: { type: 'string', description: 'Path inside the session workspace to a PNG/JPEG/WebP picture, used as the first frame.' },
      wait: { type: 'string', enum: [...WAIT_MODES], description: 'auto holds the turn for the configured grace window (default 2 minutes) and returns a job id if the render is slower; until_done waits for the whole render (up to an hour); none returns the job id immediately.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: VIDEO_OUTPUT_PROPERTIES },
      render: (_args: unknown, value: VideoResult) => [{ type: 'text' as const, text: renderVideoResult(value) }],
      presentationMeta: (_args: unknown, value: VideoResult) => ({
        kind: 'dsh-video-gen',
        jobId: value.jobId,
        status: value.status,
        prompt: value.prompt,
        seconds: value.seconds,
        size: value.size,
        ...(value.videoPath === undefined ? {} : { videoName: fileBase(value.videoPath) }),
        ...(value.thumbPath === undefined ? {} : { thumbName: fileBase(value.thumbPath) }),
        ...(value.savedTo === undefined ? {} : { savedTo: value.savedTo }),
        ...(value.error === undefined ? {} : { error: value.error }),
      }),
    },
    async execute(args, exec): Promise<VideoResult> {
      const input = args as GenerateArgs
      const prompt = input.prompt.trim()
      if (prompt.length === 0) throw new Error('video generation needs a non-empty prompt; describe the shot, the motion, and the sound.')
      noteSession(exec)
      const config = current()
      const { target } = await makeClient(names.generate, input.model)
      const model = target.model
      const enhance = input.enhance === 'on' ? true : input.enhance === 'off' ? false : target.defaultEnhance
      const orientation: Orientation | undefined = input.orientation ?? target.defaultOrientation
      const reference = await resolveReference({
        attachments: ctx.attachments,
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        ...(input.image_url === undefined ? {} : { imageUrl: input.image_url }),
        ...(input.source_attachment_id === undefined ? {} : { sourceAttachmentId: input.source_attachment_id }),
        ...(input.source_path === undefined ? {} : { sourcePath: input.source_path }),
        signal: exec.signal,
      })
      const seconds = clampSeconds(input.seconds, target.defaultSeconds)
      const fps = clampFps(input.fps, target.defaultFps)
      const size = reference !== undefined && (reference.width === undefined || reference.height === undefined)
        ? normalizeVideoSize(input.size, orientation, target.defaultSize)
        : reference !== undefined
          ? sizeFromReference(reference.width as number, reference.height as number, input.size, orientation, target.defaultSize)
          : normalizeVideoSize(input.size, orientation, target.defaultSize)
      const negativePrompt = (input.negative_prompt ?? '').trim() || target.negativePrompt
      const request: SubmitRequest = {
        model,
        prompt,
        seconds,
        size,
        ...(input.fps === undefined && config.defaultFps === undefined ? {} : { fps }),
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        enhance,
        ...(negativePrompt === undefined || negativePrompt.length === 0 ? {} : { negativePrompt }),
        ...(reference === undefined ? {} : { reference }),
      }
      const submitted = await store.submit(request, exec.signal)
      const waitMode: WaitMode = input.wait ?? 'auto'
      const grace = waitMode === 'none' ? 0 : waitMode === 'until_done' ? target.jobTimeoutMs : Math.min(target.waitGraceMs, target.jobTimeoutMs)
      let record: VideoJobRecord = submitted
      let timedOut = false
      try {
        const outcome = await store.waitFor(submitted.id, grace, exec.signal)
        record = outcome.record
        timedOut = outcome.timedOut
      } catch (error) {
        if (exec.signal.aborted) {
          await store.cancel(submitted.id).catch(() => undefined)
          throw new Error(`${names.generate} was stopped, so job ${submitted.id} was cancelled on the server. Call check_video to confirm its state.`)
        }
        throw error
      }
      const result = toResult(record, target.jobTimeoutMs - Math.max(0, target.jobTimeoutMs - (Date.now() - submitted.createdAt)))
      if (timedOut && record.status !== 'completed') {
        result.note = `still rendering; poll check_video with job_id "${record.id}".`
      }
      return result
    },
  }))

  registerTool(defineTool({
    name: names.status,
    description: 'Check one video job, or list the recent ones, on this host and on the Ninfer server. Use after generate_video returns a job id, when the user asks whether a clip is ready, or to recover a job when the tool call was interrupted. Returns status, progress, stage, queue position, the stored file paths, and the failure reason when a job failed.',
    parameters: {
      job_id: { type: 'string', description: 'Job id such as video_1a2b3c4d5e6f. Omit to list the most recent jobs.' },
      limit: { type: 'integer', description: 'How many recent jobs to list when job_id is omitted; default 5, max 20.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false, properties: {
          jobs: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: VIDEO_OUTPUT_PROPERTIES } },
        },
      },
      render: (_args: unknown, value: { jobs: VideoResult[] }) => [
        { type: 'text' as const, text: value.jobs.length === 0 ? 'No video jobs are recorded on this host yet.' : value.jobs.map(renderVideoResult).join('\n\n') },
      ],
      presentationMeta: (_args: unknown, value: { jobs: VideoResult[] }) => ({
        kind: 'dsh-video-gen-list',
        jobs: value.jobs.map(job => ({
          jobId: job.jobId,
          status: job.status,
          prompt: job.prompt,
          seconds: job.seconds,
          size: job.size,
          ...(job.videoPath === undefined ? {} : { videoName: fileBase(job.videoPath) }),
          ...(job.thumbPath === undefined ? {} : { thumbName: fileBase(job.thumbPath) }),
          ...(job.error === undefined ? {} : { error: job.error }),
        })),
      }),
    },
    async execute(args, exec): Promise<{ jobs: VideoResult[] }> {
      noteSession(exec)
      const input = args as { job_id?: string | undefined; limit?: number | undefined }
      const id = (input.job_id ?? '').trim()
      if (id.length > 0) {
        let record = store.get(id)
        if (record === undefined) {
          // A job this host never saw: ask the server once and adopt it.
          const { client } = await makeClient(names.status)
          const job = await getVideo(client, id)
          const now = Date.now()
          record = await store.remember({
            id: job.id,
            provider: 'ninfer',
            model: job.model ?? current().model ?? 'ltx-2.5',
            prompt: job.prompt ?? '',
            status: job.status === 'completed' ? 'completed' : job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'cancelled' : job.status === 'queued' ? 'queued' : 'in_progress',
            progress: Math.round(job.progress ?? 0),
            ...(job.stage === undefined ? {} : { stage: job.stage }),
            ...(job.queuePosition === undefined ? {} : { queuePosition: job.queuePosition }),
            seconds: job.seconds ?? 5,
            size: job.size ?? '',
            ...(job.seed === undefined ? {} : { seed: job.seed }),
            enhance: false,
            fromPicture: job.fromPicture === true,
            createdAt: job.createdAt ?? now,
            updatedAt: now,
            ...(job.error?.message === undefined ? {} : { error: job.error.message }),
          })
        }
        return { jobs: [toResult(record, 0)] }
      }
      const limit = Math.max(1, Math.min(20, Math.round(input.limit ?? 5)))
      const records = store.list(limit)
      // Late completions still get their workspace copy, exactly once.
      for (const record of records) {
        if (record.status !== 'completed' || record.savedTo !== undefined || record.videoFile === undefined) continue
        if (current().saveToWorkspace === false) continue
        void ensureWorkspaceCopy(record).then(copied => store.remember(copied)).catch(() => undefined)
      }
      return { jobs: records.map(record => toResult(record, 0)) }
    },
  }))

  registerTool(defineTool({
    name: names.cancel,
    description: 'Cancel a queued or running video job on the Ninfer server so it stops occupying the GPU. Use when the user abandons a clip or wants the engine free for another render. A finished job is returned unchanged.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id to cancel, such as video_1a2b3c4d5e6f.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: VIDEO_OUTPUT_PROPERTIES },
      render: (_args: unknown, value: VideoResult) => [{ type: 'text' as const, text: value.status === 'cancelled' ? `Cancelled video job ${value.jobId}.` : renderVideoResult(value) }],
      presentationMeta: (_args: unknown, value: VideoResult) => ({
        kind: 'dsh-video-gen',
        jobId: value.jobId,
        status: value.status,
        prompt: value.prompt,
        seconds: value.seconds,
        size: value.size,
        ...(value.videoPath === undefined ? {} : { videoName: fileBase(value.videoPath) }),
        ...(value.savedTo === undefined ? {} : { savedTo: value.savedTo }),
        ...(value.error === undefined ? {} : { error: value.error }),
      }),
    },
    async execute(args): Promise<VideoResult> {
      const input = args as { job_id: string }
      const id = input.job_id.trim()
      if (id.length === 0) throw new Error('cancel_video needs the job id returned by generate_video; check_video lists the ids this host tracks.')
      const record = await store.cancel(id)
      return toResult(record, 0)
    },
  }))

  // Browser surfaces. Every route is gated by the connection's trust decision
  // first, so a foreign page cannot read clips or job state.
  let webAdmission: WebAdmission | undefined
  ctx.inject(['connection'], connectionCtx => {
    webAdmission = request => connectionCtx.connection.requestRejection(request)
  })
  ctx.inject(['webServer'], webCtx => {
    const register = (route: WebRoute) => webCtx.webServer.register(withWebAdmission(route, () => webAdmission))
    webCtx.effect(() => register({
      kind: 'exact',
      path: SETTINGS_HEALTH_ROUTE,
      handler: (req, res) => serveSettingsHealth(req, res, settingsHealth()),
    }), 'dsh-video-gen: settings health')
    webCtx.effect(() => register({
      kind: 'exact',
      path: VIDEO_ROUTE,
      handler: (req, res) => void serveJobFile(req, res, { dir: videosDir(), kind: 'video', store }),
    }), 'dsh-video-gen: clip route')
    webCtx.effect(() => register({
      kind: 'exact',
      path: THUMB_ROUTE,
      handler: (req, res) => void serveJobFile(req, res, { dir: videosDir(), kind: 'thumbnail', store }),
    }), 'dsh-video-gen: thumbnail route')
    webCtx.effect(() => register({
      kind: 'exact',
      path: JOBS_ROUTE,
      handler: (req, res) => serveJobs(req, res, { list: limit => store.list(limit).map(toJobView) }),
    }), 'dsh-video-gen: jobs route')
    webCtx.effect(() => register({
      kind: 'exact',
      path: CANCEL_ROUTE,
      handler: (req, res) => void serveCancel(req, res, { cancel: id => store.cancel(id) }),
    }), 'dsh-video-gen: cancel route')
    webCtx.effect(() => register({
      kind: 'exact',
      path: MODELS_ROUTE,
      handler: (req, res) => void serveModels(req, res, { resolveKey: ref => resolveApiKey(ctx, ref) }),
    }), 'dsh-video-gen: model probe route')
    webCtx.effect(() => register({
      kind: 'exact',
      path: CREDENTIAL_ROUTE,
      handler: (req, res) => void serveCredential(req, res, credentialPorts(ctx)),
    }), 'dsh-video-gen: credential route')
    webCtx.effect(() => register({
      kind: 'exact',
      path: TEST_CONNECTION_ROUTE,
      handler: (req, res) => void serveTestConnection(req, res, {
        probe: async () => {
          const { client, target } = await makeClient()
          const models = await getModels(client)
          return { baseUrl: target.baseURL, model: target.model, models }
        },
      }),
    }), 'dsh-video-gen: test route')
  })
}

/**
 * Wire the settings namespace across both dsh-settings API generations.
 *
 * The probe reads the HOST's `settings` service, never the bundled dsh-settings
 * module: the build inlines that module, so its exports always look like the
 * compile-time generation while only the service handed to this fiber reflects
 * the running host. dsh-settings 0.1.2-0.1.6 put `installSection` on the
 * service; DSH 0.1.7 replaced it with schema-derived forms keyed by entry id, so
 * its service carries no installer and a host without any settings service
 * simply never runs the callback.
 */
function installVideoSettings(ctx: Context, config: Config, hooks: SettingsHooks): () => SettingsHealth {
  let service: unknown
  ctx.inject(['settings'], settingsCtx => {
    const settings = settingsCtx.settings as SettingsForms & Partial<SettingsSectionInstaller>
    service = settings
    const health = describeSettingsHealth(settings, Config)
    if (health.settings === 'live' && !health.liveSchema) {
      ctx.logger.warn('dsh-video-gen: the loaded schema lacks volatile fields required by this DSH settings service. Install @deepseek-ai/schemastery >=3.18.4 <4 in the plugin profile and check which copy the plugin resolves; settings cannot be saved with this schema.')
    }
    if (typeof settings.installSection === 'function') {
      settings.installSection(ctx, VIDEO_GENERATION_NAMESPACE, Config, config, hooks)
    }
    return () => { service = undefined }
  })
  return () => describeSettingsHealth(service, Config)
}

/** Exported for tests: the pure parts of this fiber. */
export type { VideoResult }
export type { NinferError }
