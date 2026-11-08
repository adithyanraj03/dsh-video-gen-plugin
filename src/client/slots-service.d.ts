/**
 * Ambient typing for the browser services this plugin's client half touches.
 *
 * DSH 0.1.5 stopped publishing `@deepseek-ai/dsh-client-runtime`; the host
 * bundles the slot runtime internally, so the `declare module '@deepseek-ai/
 * cordis'` augmentation that used to arrive transitively no longer resolves.
 * This local declaration restores exactly the surface used here: `register`
 * (the SlotCore typed API) and `inject` (declaration-lifetime effects), plus a
 * read-only locale snapshot for language selection.
 */
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Slot registry provided by the DSH browser runtime (host-internal since 0.1.5). */
    slots: {
      register: SlotCore['register']
      inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
    }
    /** Locale service; optional so a preview core without one still loads. */
    locale?: {
      register(namespace: string, dictionaries: Record<string, Record<string, string>>): void
      getSnapshot(): { active?: string | undefined } | undefined
    }
  }
}
