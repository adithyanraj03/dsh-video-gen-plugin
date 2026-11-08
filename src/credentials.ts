/**
 * BYOK token resolution shared by the Agent tools and the settings routes.
 *
 * The plugin ships without a vendor: every endpoint names its own credential
 * reference, so nothing here assumes where the token came from.
 */
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_API_KEY_REF } from './shared.js'

/** True when a raw string can be used as a credential reference at all. */
export function validKeyRef(value: string): boolean {
  return isCredentialRefName(value.trim())
}

/** Where a user manages this plugin's keys, for every error message. */
export const KEY_SETTINGS_HINT = 'Settings > Plugins > Video generation'

/**
 * Resolve the stored token to a non-blank value. Blank never counts as
 * configured: the host treats an empty stored value as absent, and a
 * whitespace-only token is never sent upstream.
 */
export async function resolveApiKey(ctx: Context, keyRef: string = DEFAULT_API_KEY_REF): Promise<string | undefined> {
  const name = keyRef.trim()
  if (!validKeyRef(name)) return undefined
  const credential = await ctx.credentials.resolve(credentialRef(name))
  const value = credential?.value.trim() ?? ''
  return value.length > 0 ? value : undefined
}

/**
 * Resolve the token or fail with a message naming the fix. Passing `tool`
 * selects the Agent-facing English wording; without it the browser-facing
 * route reports the same problem.
 */
export async function requireApiKey(ctx: Context, tool?: string, keyRef: string = DEFAULT_API_KEY_REF): Promise<string> {
  const value = await resolveApiKey(ctx, keyRef)
  if (value !== undefined) return value
  const name = keyRef.trim() || DEFAULT_API_KEY_REF
  if (!validKeyRef(name)) {
    throw new Error(`"${name}" is not a valid credential name. Use an upper-case name such as VIDEO_GEN_KEY_MYENDPOINT in ${KEY_SETTINGS_HINT}.`)
  }
  throw new Error(tool === undefined
    ? `no API key is stored under ${name}. Paste the key into ${KEY_SETTINGS_HINT} and save it, or point the endpoint at a credential that already exists.`
    : `${tool} needs an API key: nothing is stored under ${name}. Save it in ${KEY_SETTINGS_HINT}, or set the endpoint's credential name to one that is already configured.`)
}
