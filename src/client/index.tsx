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

/** Every tool name that renders the result card, including the `ninfer` family. */
const TOOL_KEYS = ['generate_video', 'ninfer_generate_video', 'check_video', 'cancel_video', 'ninfer_check_video', 'ninfer_cancel_video'] as const

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
  // hosts at or below 0.1.5. The slot-name union in the published types does
  // not enumerate these two seats, so the registration goes through the same
  // cast the sibling plugins use rather than pinning a stale list.
  const register = ctx.slots.register.bind(ctx.slots) as unknown as (options: object, component: unknown) => () => void
  const injectSlot = ctx.slots.inject as unknown as (key: string, factory: () => (() => void) | Iterable<() => void>) => void
  injectSlot('plugins.bundle.config', () => register({
    name: 'plugins.bundle.config',
    key: 'dsh-video-gen',
    inject: () => ({ scope, health: health() }),
  }, VideoSettingsCard))
  injectSlot('settings.plugin.item', () => register({
    name: 'settings.plugin.item',
    key: VIDEO_GENERATION_NAMESPACE,
    inject: () => ({ scope, health: health() }),
  }, VideoSettingsCard))

  for (const key of TOOL_KEYS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key,
      inject: (): VideoCardFace => ({ lang: language() }),
    }, VideoResultCard))
  }
}
