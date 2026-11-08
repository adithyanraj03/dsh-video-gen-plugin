/** Browser half: the endpoint settings card and the video tool result card. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { VIDEO_GENERATION_NAMESPACE, type SettingsHealth } from '../shared.js'
import { VideoSettingsCard, type SettingsScope, type VideoSettings } from './settings-card.js'
import { VideoResultCard, languageOf, type VideoCardFace } from './video-toolview.js'

export { VideoResultCard } from './video-toolview.js'
export { VideoSettingsCard } from './settings-card.js'

export const name = 'dsh-video-gen/client'
export const inject = ['slots', 'locale']

/** Every tool name that renders the result card, including the prefixed family. */
const TOOL_KEYS = ['generate_video', 'check_video', 'cancel_video', 'videogen_generate_video', 'videogen_check_video', 'videogen_cancel_video'] as const

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

  for (const key of TOOL_KEYS) {
    tryRegister('tool.call.toolview', {
      name: 'tool.call.toolview',
      key,
      inject: (): VideoCardFace => ({ lang: language() }),
    }, VideoResultCard)
  }
}
