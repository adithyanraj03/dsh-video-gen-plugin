/** Browser half: registers the video tool result card. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { VideoResultCard, languageOf, type VideoCardFace } from './video-toolview.js'

export { VideoResultCard } from './video-toolview.js'

export const name = 'dsh-video-gen/client'
export const inject = ['slots', 'locale']

/** Every tool name that renders this card, including the `ninfer` name family. */
const TOOL_KEYS = ['video_generate', 'ninfer_video_generate', 'video_status', 'video_cancel', 'ninfer_video_status', 'ninfer_video_cancel'] as const

export function apply(ctx: Context): void {
  const language = (): VideoCardFace['lang'] => languageOf(ctx.locale?.getSnapshot?.())
  for (const key of TOOL_KEYS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key,
      inject: (): VideoCardFace => ({ lang: language() }),
    }, VideoResultCard))
  }
}
