/** Browser half: the endpoint settings card and the video tool result card. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { VIDEO_GENERATION_NAMESPACE, type SettingsHealth } from '../shared.js'
import { VideoSettingsCard, type SettingsScope, type VideoSettings } from './settings-card.js'
import { PromotedVideoResultNode, VideoResultCard, languageOf, type VideoCardFace } from './video-toolview.js'
import { VIDEO_RESULT_NODE_KIND, createVideoResultDefinition } from './video-result-node.js'

export { VideoResultCard } from './video-toolview.js'
export { VideoSettingsCard } from './settings-card.js'

export const name = 'dsh-video-gen-plugin/client'
export const inject = ['slots', 'locale']

/** Every tool name that renders the result card, including the prefixed family. */
const TOOL_KEYS = ['generate_video', 'check_video', 'cancel_video', 'videogen_generate_video', 'videogen_check_video', 'videogen_cancel_video'] as const

/** Tool names that start a render; their settled results promote to a chat row. */
const GENERATE_KEYS = new Set<string>(['generate_video', 'videogen_generate_video'])

/**
 * Runtime face of DSH's `uiConversation` service (the promoted-result
 * mechanism). Kept local and duck-typed: hosts without the service never
 * reach this code (deferred inject).
 */
interface ModernUiConversation {
  events: { register(definition: ReturnType<typeof createVideoResultDefinition>): () => void }
}

function asModernUiConversation(value: unknown): ModernUiConversation | undefined {
  const candidate = value as { events?: { register?: unknown } } | null
  if (candidate === null || typeof candidate !== 'object') return undefined
  if (typeof candidate.events?.register !== 'function') return undefined
  return candidate as unknown as ModernUiConversation
}

type SlotInject = (key: string, factory: () => () => void) => void

/** Read-only view of the host's settings scope for this plugin's entry. */
interface ConfigFormsApi {
  get<T>(entryId: string): SettingsScope<T> | undefined
}

interface SettingsScopeApi {
  bind<T>(options: { namespace: string }): SettingsScope<T>
}

/** Scope that accepts nothing, used when a host exposes no settings service. */
function degradedScope<T>(): SettingsScope<T> {
  return {
    getSnapshot: () => ({ value: undefined, writable: false, status: 'unavailable' }),
    subscribe: () => () => undefined,
    set: async () => false,
  }
}

export function apply(ctx: Context): void {
  // Probe instead of inject: 0.1.7+ resolves `configForms`, older hosts fall
  // back to `settingsScope`, and `ctx.get` reads undefined for a service the
  // host never declared.
  const configForms = ctx.get('configForms') as ConfigFormsApi | undefined
  const settingsScopeApi = configForms === undefined ? ctx.get('settingsScope') as SettingsScopeApi | undefined : undefined
  const scope = configForms?.get<VideoSettings>('video-gen')
    ?? settingsScopeApi?.bind<VideoSettings>({ namespace: VIDEO_GENERATION_NAMESPACE })
    ?? degradedScope<VideoSettings>()
  const language = (): VideoCardFace['lang'] => languageOf(ctx.locale?.getSnapshot?.())
  // The card only needs the host's health when it can read it; a probe failure
  // must not block the form, so the face stays optional and empty here.
  const health = (): SettingsHealth | undefined => undefined

  // The settings card sits on this plugin's own page in the plugin manager,
  // keyed by bundle package name, with the legacy per-plugin seat kept for
  // hosts at or below 0.1.5. Both seats are optional: a host that does not
  // declare them must still get the tool card, so each registration is
  // contained instead of aborting this bundle's activation.
  const register = ctx.slots.register.bind(ctx.slots) as unknown as (options: object, component: unknown) => () => void
  // `slots.inject` reads its own registry through `this`, so it must stay bound
  // to the service; an unbound copy throws "reading 'ctx'" on every use.
  const injectSlot = ctx.slots.inject.bind(ctx.slots) as unknown as (key: string, factory: () => (() => void) | Iterable<() => void>) => void
  const tryRegister = (slot: string, options: object, component: unknown): void => {
    try {
      injectSlot(slot, () => register(options, component))
    } catch (error) {
      console.warn(`dsh-video-gen: the "${slot}" slot is unavailable (${error instanceof Error ? error.message : String(error)}); that card stays hidden`)
    }
  }
  tryRegister('plugins.bundle.config', {
    name: 'plugins.bundle.config',
    key: 'dsh-video-gen',
    inject: () => ({ scope, health: health() }),
  }, VideoSettingsCard)
  tryRegister('settings.plugin.item', {
    name: 'settings.plugin.item',
    key: VIDEO_GENERATION_NAMESPACE,
    inject: () => ({ scope, health: health() }),
  }, VideoSettingsCard)

  // Promoted results: on hosts with the uiConversation service, a settled
  // generate_video result becomes a session-located chat row (kind
  // dsh-video-result) and stays visible when the Tool process folds. The
  // generate tool cards then carry a short notice. Legacy hosts never reach
  // this code and keep the full card inside the tool call.
  const promotion = { enabled: false }
  ;(ctx.inject as unknown as (services: string[], callback: (owner: Context) => void) => void)(
    ['uiConversation'],
    owner => {
      const uiConversation = asModernUiConversation(owner.get('uiConversation'))
      if (uiConversation === undefined) {
        throw new Error('dsh-video-gen: uiConversation has an incompatible interface')
      }
      promotion.enabled = true
      const ownerRegister = owner.slots.register.bind(owner.slots) as unknown as (options: object, component: unknown) => () => void
      owner.effect(
        () => uiConversation.events.register(createVideoResultDefinition()),
        'dsh-video-gen: promoted video result node',
      )
      ;(owner.slots.inject as unknown as SlotInject)('conversation.chat.node', () => ownerRegister({
        name: 'conversation.chat.node',
        key: VIDEO_RESULT_NODE_KIND,
        inject: () => ({ lang: language() }),
      }, PromotedVideoResultNode))
    },
  )

  for (const key of TOOL_KEYS) {
    tryRegister('tool.call.toolview', {
      name: 'tool.call.toolview',
      key,
      inject: (): VideoCardFace => GENERATE_KEYS.has(key)
        ? { lang: language(), promoted: promotion.enabled }
        : { lang: language() },
    }, VideoResultCard)
  }
}
