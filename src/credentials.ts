/** BYOK token resolution shared by the Agent tools and the test-connection route. */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { NINFER_API_KEY_ENV, PROVIDER_DISPLAY_NAMES } from './shared.js'

/**
 * Resolve the stored Ninfer token to a non-blank value. Blank never counts as
 * configured: the host treats an empty stored value as absent, and a
 * whitespace-only token is never sent upstream.
 */
export async function resolveApiKey(ctx: Context, keyRef: string = NINFER_API_KEY_ENV): Promise<string | undefined> {
  const credential = await ctx.credentials.resolve(credentialRef(keyRef))
  const value = credential?.value.trim() ?? ''
  return value.length > 0 ? value : undefined
}

/**
 * Resolve the token or fail with a message naming the fix. Passing `tool`
 * selects the Agent-facing English wording; without it the browser-facing
 * route reports the same problem.
 */
export async function requireApiKey(ctx: Context, tool?: string, keyRef: string = NINFER_API_KEY_ENV): Promise<string> {
  const value = await resolveApiKey(ctx, keyRef)
  if (value !== undefined) return value
  throw new Error(tool === undefined
    ? `${PROVIDER_DISPLAY_NAMES.ninfer} has no stored token; save it for credential ${keyRef} in Settings > Plugins > Video generation.`
    : `${tool} requires the ${PROVIDER_DISPLAY_NAMES.ninfer} token; save it for credential ${keyRef} in Settings > Plugins > Video generation.`)
}
