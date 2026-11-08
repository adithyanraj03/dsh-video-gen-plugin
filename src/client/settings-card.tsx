/**
 * The plugin's settings card: endpoints, keys, and defaults.
 *
 * Laid out like the sibling image plugin's card — a default-endpoint chooser,
 * one collapsible row per endpoint with a key badge, then defaults and a save
 * bar — because that is what a user of these plugins already knows how to
 * operate. Every endpoint is user-supplied: nothing here assumes a vendor.
 */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CREDENTIAL_ROUTE,
  KEY_REF_PREFIX,
  MAX_CONNECTIONS,
  MAX_SECONDS,
  MIN_SECONDS,
  MODELS_ROUTE,
  ORIENTATIONS,
  SIZE_TIER_VALUES,
  connectionSlug,
  defaultKeyRef,
  type Orientation,
  type SettingsHealth,
} from '../shared.js'
import type { VideoConnection } from '../config.js'

/** One endpoint row as the settings form edits it; every field may be blank. */
interface DraftConnection {
  id: string
  label?: string | undefined
  baseUrl: string
  model: string
  apiKeyRef?: string | undefined
  seconds?: number | undefined
  size?: string | undefined
  fps?: number | undefined
  orientation?: Orientation | undefined
  enhance?: boolean | undefined
}

/** Settings shape the card reads and writes; a subset of the host Config. */
export interface VideoSettings {
  connections?: DraftConnection[] | undefined
  activeConnection?: string | undefined
  defaultSeconds?: number | undefined
  defaultSize?: string | undefined
  defaultOrientation?: Orientation | undefined
  defaultFps?: number | undefined
  defaultEnhance?: boolean | undefined
  negativePrompt?: string | undefined
  saveToWorkspace?: boolean | undefined
  workspaceFolder?: string | undefined
  saveThumbnail?: boolean | undefined
  toolNameSet?: 'generic' | 'prefixed' | undefined
}

export interface SettingsScopeSnapshot<T> {
  value: T | undefined
  writable: boolean
  status?: 'loading' | 'ready' | 'unavailable'
  mode?: 'host' | 'memory'
}

export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean | void>
}

export interface SettingsCardFace {
  scope: SettingsScope<VideoSettings>
  health?: SettingsHealth | undefined
}

export type SettingsCardProps = InjectFace<SettingsCardFace>

/** Key presence for one credential reference, as the credential route reports it. */
interface KeyState {
  configured: boolean
  busy: boolean
  error?: string | undefined
}

/** Result of one endpoint probe. */
interface ProbeState {
  busy: boolean
  message?: string | undefined
  error?: boolean | undefined
  models?: string[] | undefined
}

const S = {
  card: { display: 'flex', flexDirection: 'column', gap: 18, width: '100%', maxWidth: 940, color: 'inherit' },
  heading: { margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' },
  lead: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.55, opacity: 0.75 },
  sectionTitle: { margin: 0, fontSize: 13, fontWeight: 700 },
  sectionLead: { margin: '2px 0 0', fontSize: 12, lineHeight: 1.5, opacity: 0.65 },
  chips: { display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginTop: 10 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
  chipOn: { borderColor: 'var(--dsh-accent, #4c8dff)', boxShadow: 'inset 0 0 0 1px var(--dsh-accent, #4c8dff)' },
  list: { display: 'flex', flexDirection: 'column' as const, marginTop: 12, border: '1px solid rgba(127,127,127,0.22)', borderRadius: 10, overflow: 'hidden' },
  item: { borderTop: '1px solid rgba(127,127,127,0.18)' },
  itemHead: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' },
  itemName: { flex: 1, display: 'flex', flexDirection: 'column' as const, gap: 2, minWidth: 0 },
  itemTitle: { fontSize: 13, fontWeight: 600 },
  itemSub: { fontSize: 11, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  badge: { fontSize: 10, padding: '2px 7px', borderRadius: 5, border: '1px solid currentColor', whiteSpace: 'nowrap' as const },
  good: { color: 'var(--dsh-success, #3fb950)' },
  bad: { color: 'var(--dsh-danger, #e5534b)' },
  neutral: { opacity: 0.65 },
  iconButton: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13, lineHeight: 1 },
  body: { display: 'flex', flexDirection: 'column' as const, gap: 14, padding: '4px 14px 16px' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 5 },
  label: { fontSize: 12, fontWeight: 600 },
  hint: { fontSize: 11, lineHeight: 1.5, opacity: 0.6 },
  input: { width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid rgba(127,127,127,0.3)', background: 'rgba(127,127,127,0.08)', color: 'inherit', font: 'inherit', fontSize: 12, boxSizing: 'border-box' as const },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
  inline: { display: 'flex', gap: 8, alignItems: 'center' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 },
  button: { padding: '6px 12px', borderRadius: 7, border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' as const },
  primary: { padding: '7px 16px', borderRadius: 7, border: '1px solid var(--dsh-accent, #4c8dff)', background: 'var(--dsh-accent, #4c8dff)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  danger: { padding: '5px 10px', borderRadius: 7, border: '1px solid rgba(229,83,75,0.45)', background: 'transparent', color: 'var(--dsh-danger, #e5534b)', cursor: 'pointer', fontSize: 11 },
  ok: { fontSize: 11, color: 'var(--dsh-success, #3fb950)' },
  warn: { fontSize: 11, color: 'var(--dsh-danger, #e5534b)' },
  divider: { height: 1, background: 'rgba(127,127,127,0.18)', margin: '2px 0' },
  saveBar: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const, paddingTop: 4 },
  models: { display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginTop: 6 },
  modelChip: { padding: '3px 9px', borderRadius: 999, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11 },
} as const

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOr(value: string, fallback?: number): number | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Host label for the row subtitle. */
function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.trim().length === 0 ? 'no base URL yet' : baseUrl.trim()
  }
}

/** Copy a snapshot value into an editable draft. */
export function normalizeDraft(value: VideoSettings | undefined): VideoSettings {
  const rows = (value?.connections ?? []).map(row => ({
    id: textOf(row.id),
    label: textOf(row.label),
    baseUrl: textOf(row.baseUrl),
    model: textOf(row.model),
    apiKeyRef: textOf(row.apiKeyRef),
    ...(row.seconds === undefined ? {} : { seconds: row.seconds }),
    ...((row.size ?? '').trim() === '' ? {} : { size: textOf(row.size) }),
    ...(row.fps === undefined ? {} : { fps: row.fps }),
    ...(row.orientation === undefined ? {} : { orientation: row.orientation }),
    ...(row.enhance === undefined ? {} : { enhance: row.enhance }),
  }))
  return {
    connections: rows,
    defaultSeconds: value?.defaultSeconds ?? 5,
    defaultSize: textOf(value?.defaultSize) || '720p',
    defaultFps: value?.defaultFps ?? 24,
    ...(value?.defaultOrientation === undefined ? {} : { defaultOrientation: value.defaultOrientation }),
    defaultEnhance: value?.defaultEnhance === true,
    negativePrompt: textOf(value?.negativePrompt),
    saveToWorkspace: value?.saveToWorkspace !== false,
    saveThumbnail: value?.saveThumbnail !== false,
    workspaceFolder: textOf(value?.workspaceFolder) || 'videos',
    toolNameSet: value?.toolNameSet === 'prefixed' ? 'prefixed' : 'generic',
  }
}

/** Subscribe to a settings scope with a React-safe snapshot comparison. */
function useSettingsSnapshot(scope: SettingsScope<VideoSettings>): SettingsScopeSnapshot<VideoSettings> {
  const [snapshot, setSnapshot] = useState<SettingsScopeSnapshot<VideoSettings>>(() => scope.getSnapshot())
  useEffect(() => {
    const read = (): void => setSnapshot(scope.getSnapshot())
    read()
    return scope.subscribe(read)
  }, [scope])
  return snapshot
}

/** Write one setting, naming the refusal when the host rejects it. */
async function writeSetting(scope: SettingsScope<VideoSettings>, field: string, value: unknown): Promise<void> {
  const accepted = await scope.set(field, value)
  if (accepted === false) throw new Error(`the host refused to save "${field}"; check the plugin settings schema and the schemastery version in this profile`)
}

/** The settings card component. */
export function VideoSettingsCard(props: SettingsCardProps) {
  const { scope } = props
  const snapshot = useSettingsSnapshot(scope)
  const stored = snapshot.value
  const [draft, setDraft] = useState<VideoSettings>(() => normalizeDraft(stored))
  const [active, setActive] = useState<string>(() => textOf(stored?.activeConnection))
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | undefined>(undefined)
  const [keys, setKeys] = useState<Record<string, KeyState>>({})
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const lastStored = useRef<string>(JSON.stringify(normalizeDraft(stored)))

  useEffect(() => {
    const next = JSON.stringify(normalizeDraft(stored))
    if (next === lastStored.current) return
    lastStored.current = next
    setDraft(normalizeDraft(stored))
    setActive(textOf(stored?.activeConnection))
  }, [stored])

  const readOnly = snapshot.writable === false || snapshot.status === 'unavailable'
  const rows = draft.connections ?? []
  const effectiveActive = active !== '' ? active : rows[0]?.id ?? ''
  const keyRefOf = (row: DraftConnection): string => (row.apiKeyRef ?? '').trim() || `${KEY_REF_PREFIX}${defaultKeyRef(row.id)}`
  const keyRefs = rows.map(row => keyRefOf(row)).join('|')

  const setRow = (index: number, patch: Partial<DraftConnection>): void => {
    setDraft(current => {
      const next = [...(current.connections ?? [])]
      const row = next[index]
      if (row === undefined) return current
      next[index] = { ...row, ...patch }
      return { ...current, connections: next }
    })
  }

  const describeKey = async (ref: string): Promise<void> => {
    if (ref.trim().length === 0) return
    setKeys(current => ({ ...current, [ref]: { ...(current[ref] ?? { configured: false, busy: false }), busy: true } }))
    try {
      const response = await fetch(`${CREDENTIAL_ROUTE}?ref=${encodeURIComponent(ref)}`, { credentials: 'same-origin', cache: 'no-store' })
      const body = await response.json() as { configured?: boolean; message?: string }
      setKeys(current => ({
        ...current,
        [ref]: { configured: body.configured === true, busy: false, ...(body.message === undefined ? {} : { error: body.message }) },
      }))
    } catch (error) {
      setKeys(current => ({ ...current, [ref]: { configured: false, busy: false, error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  // Key badges stay accurate when a reference changes or the card reopens.
  useEffect(() => {
    for (const ref of keyRefs.split('|').filter(ref => ref.length > 0)) void describeKey(ref)
  }, [keyRefs])

  // Open the first endpoint on first load so the card is not a wall of headers.
  useEffect(() => {
    if (rows.length === 0) return
    setExpanded(current => (Object.keys(current).length > 0 ? current : { [rows[0]?.id ?? '']: true }))
  }, [rows.length])

  const addEndpoint = (): void => {
    const id = connectionSlug(`endpoint ${String(rows.length + 1)}`, rows.map(row => row.id))
    setDraft(current => ({ ...current, connections: [...(current.connections ?? []), { id, label: '', baseUrl: '', model: '', apiKeyRef: '' }] }))
    setExpanded(current => ({ ...current, [id]: true }))
    if (rows.length === 0) setActive(id)
  }

  const removeEndpoint = (index: number): void => {
    const removed = rows[index]?.id
    setDraft(current => {
      const next = [...(current.connections ?? [])]
      next.splice(index, 1)
      return { ...current, connections: next }
    })
    setActive(current => (current === removed ? '' : current))
  }

  const saveKey = async (row: DraftConnection): Promise<void> => {
    const ref = keyRefOf(row)
    const value = keyInputs[ref]?.trim() ?? ''
    if (value.length === 0) {
      setKeys(current => ({ ...current, [ref]: { configured: current[ref]?.configured ?? false, busy: false, error: 'paste the key first' } }))
      return
    }
    setKeys(current => ({ ...current, [ref]: { ...(current[ref] ?? { configured: false }), busy: true } }))
    try {
      const response = await fetch(CREDENTIAL_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref, value }),
      })
      const body = await response.json() as { ok?: boolean; configured?: boolean; message?: string }
      if (body.ok !== true) throw new Error(body.message ?? 'the host refused to store the key')
      setKeys(current => ({ ...current, [ref]: { configured: body.configured === true, busy: false } }))
      setKeyInputs(current => ({ ...current, [ref]: '' }))
      setMessage({ tone: 'ok', text: `Saved the key for ${ref}.` })
    } catch (error) {
      setKeys(current => ({ ...current, [ref]: { configured: current[ref]?.configured ?? false, busy: false, error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const probeEndpoint = async (row: DraftConnection, index: number): Promise<void> => {
    const ref = keyRefOf(row)
    setProbes(current => ({ ...current, [row.id]: { busy: true } }))
    try {
      const response = await fetch(MODELS_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: row.baseUrl ?? '', apiKeyRef: ref, keyValue: keyInputs[ref]?.trim() ?? '' }),
      })
      const body = await response.json() as { ok?: boolean; models?: string[]; message?: string; code?: string }
      if (body.ok !== true) throw new Error(body.message ?? body.code ?? 'the endpoint did not answer')
      const models = body.models ?? []
      setProbes(current => ({
        ...current,
        [row.id]: { busy: false, models, message: models.length === 0 ? 'reachable, but it listed no video models — type the model id' : `reachable · ${String(models.length)} model(s)` },
      }))
      const firstModel = models[0]
      if ((row.model ?? '').trim().length === 0 && firstModel !== undefined) setRow(index, { model: firstModel })
      setMessage({ tone: 'ok', text: 'Endpoint answered and the model list is loaded.' })
    } catch (error) {
      setProbes(current => ({ ...current, [row.id]: { busy: false, error: true, message: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      const clean = rows.map<VideoConnection>(row => ({
        id: row.id.trim(),
        label: (row.label ?? '').trim(),
        baseUrl: row.baseUrl.trim().replace(/\/+$/, ''),
        model: row.model.trim(),
        apiKeyRef: (row.apiKeyRef ?? '').trim(),
        ...(row.seconds === undefined ? {} : { seconds: row.seconds }),
        ...((row.size ?? '').trim() === '' ? {} : { size: (row.size ?? '').trim() }),
        ...(row.fps === undefined ? {} : { fps: row.fps }),
        ...(row.orientation === undefined ? {} : { orientation: row.orientation }),
        ...(row.enhance === undefined ? {} : { enhance: row.enhance }),
      }))
      await writeSetting(scope, 'connections', clean)
      await writeSetting(scope, 'activeConnection', effectiveActive)
      await writeSetting(scope, 'defaultSeconds', draft.defaultSeconds ?? 5)
      await writeSetting(scope, 'defaultSize', (draft.defaultSize ?? '720p').trim() || '720p')
      await writeSetting(scope, 'defaultFps', draft.defaultFps ?? 24)
      await writeSetting(scope, 'defaultEnhance', draft.defaultEnhance === true)
      await writeSetting(scope, 'saveToWorkspace', draft.saveToWorkspace !== false)
      await writeSetting(scope, 'saveThumbnail', draft.saveThumbnail !== false)
      await writeSetting(scope, 'workspaceFolder', (draft.workspaceFolder ?? 'videos').trim())
      await writeSetting(scope, 'negativePrompt', (draft.negativePrompt ?? '').trim())
      await writeSetting(scope, 'toolNameSet', draft.toolNameSet === 'prefixed' ? 'prefixed' : 'generic')
      lastStored.current = JSON.stringify(normalizeDraft({ ...draft, connections: clean }))
      setMessage({ tone: 'ok', text: 'Settings saved. Tool calls use the selected endpoint from the next turn.' })
    } catch (error) {
      setMessage({ tone: 'warn', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const health = props.health
  return (
    <div style={S.card}>
      <header>
        <h2 style={S.heading}>Video generation</h2>
        <p style={S.lead}>
          Bring your own video endpoint. Each endpoint needs a base URL, a bearer key, and a model; the Agent uses the
          endpoint marked below. The endpoint must speak the OpenAI-style asynchronous video API:
          <code> POST /videos</code>, <code>GET /videos/&#123;id&#125;</code>, <code>GET /videos/&#123;id&#125;/content</code>.
        </p>
        {readOnly ? <p style={S.warn}>This host does not accept settings writes from the page; edit the plugin config instead.</p> : null}
        {health?.settings === 'live' && health.liveSchema === false
          ? <p style={S.warn}>The loaded settings schema cannot be saved on this host (missing volatile fields). Check the schemastery version in this profile.</p>
          : null}
      </header>

      <section>
        <h3 style={S.sectionTitle}>Default endpoint</h3>
        <p style={S.sectionLead}>Used by the Agent by default; a tool call can still pass its own model.</p>
        {rows.length === 0 ? (
          <p style={S.hint}>No endpoint yet — add one below to start generating clips.</p>
        ) : (
          <div style={S.chips}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                style={{ ...S.chip, ...(effectiveActive === row.id ? S.chipOn : {}) }}
                aria-pressed={effectiveActive === row.id}
                onClick={() => setActive(row.id)}
              >
                <span aria-hidden>{effectiveActive === row.id ? '◉' : '○'}</span>
                {(row.label ?? '').trim() || row.id}
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 style={S.sectionTitle}>Endpoints</h3>
        <p style={S.sectionLead}>One row per video API. The key is stored in the harness credential store, never in settings.</p>
        <div style={S.list}>
          {rows.map((row, index) => {
            const ref = keyRefOf(row)
            const key = keys[ref]
            const probe = probes[row.id]
            const isOpen = expanded[row.id] === true
            const keyBadge = key === undefined || key.busy
              ? { text: 'Checking…', style: S.neutral }
              : key.configured
                ? { text: 'Key set', style: S.good }
                : { text: 'Key missing', style: S.bad }
            return (
              <div key={row.id} style={index === 0 ? undefined : S.item}>
                <div style={S.itemHead}>
                  <div style={S.itemName}>
                    <span style={S.itemTitle}>{(row.label ?? '').trim() || row.id}</span>
                    <span style={S.itemSub}>{endpointHost(row.baseUrl)}{(row.model ?? '').trim() === '' ? '' : ` · ${row.model}`}</span>
                  </div>
                  <span style={{ ...S.badge, ...keyBadge.style }}>{keyBadge.text}</span>
                  {effectiveActive === row.id ? <span style={{ ...S.badge, ...S.neutral }}>default</span> : null}
                  <button
                    type="button"
                    style={S.iconButton}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? 'Collapse endpoint' : 'Expand endpoint'}
                    onClick={() => setExpanded(current => ({ ...current, [row.id]: !isOpen }))}
                  >
                    {isOpen ? '▴' : '▾'}
                  </button>
                </div>
                {isOpen ? (
                  <div style={S.body}>
                    <div style={S.grid2}>
                      <label style={S.field}>
                        <span style={S.label}>Name</span>
                        <input
                          style={S.input}
                          value={row.label ?? ''}
                          placeholder="My video endpoint"
                          onChange={event => setRow(index, { label: event.target.value })}
                        />
                      </label>
                      <label style={S.field}>
                        <span style={S.label}>Credential name</span>
                        <input
                          style={{ ...S.input, ...S.mono }}
                          value={row.apiKeyRef ?? ''}
                          placeholder={`${KEY_REF_PREFIX}${defaultKeyRef(row.id)}`}
                          onChange={event => setRow(index, { apiKeyRef: event.target.value })}
                        />
                      </label>
                    </div>

                    <label style={S.field}>
                      <span style={S.label}>Endpoint / Base URL</span>
                      <input
                        style={{ ...S.input, ...S.mono }}
                        value={row.baseUrl ?? ''}
                        placeholder="https://your-host/v1"
                        onChange={event => setRow(index, { baseUrl: event.target.value })}
                      />
                      <span style={S.hint}>The API root including its version prefix; the plugin calls /videos and /models under it.</span>
                    </label>

                    <div style={S.field}>
                      <span style={S.label}>API key</span>
                      <div style={S.inline}>
                        <input
                          style={S.input}
                          type="password"
                          autoComplete="off"
                          value={keyInputs[ref] ?? ''}
                          placeholder={key?.configured === true ? 'Leave empty to keep the configured key' : 'Paste the bearer token'}
                          onChange={event => setKeyInputs(current => ({ ...current, [ref]: event.target.value }))}
                        />
                        <button type="button" style={S.button} disabled={key?.busy === true} onClick={() => void saveKey(row)}>
                          {key?.busy === true ? 'Saving…' : 'Save key'}
                        </button>
                      </div>
                      <span style={S.hint}>
                        Securely saved as <code>{ref}</code>; never read back in plain text.
                        {key?.error === undefined ? '' : ` ${key.error}`}
                      </span>
                    </div>

                    <div style={S.field}>
                      <span style={S.label}>Default model</span>
                      <div style={S.inline}>
                        <input
                          style={{ ...S.input, ...S.mono }}
                          value={row.model ?? ''}
                          placeholder="model id from your endpoint"
                          onChange={event => setRow(index, { model: event.target.value })}
                        />
                        <button type="button" style={S.button} disabled={probe?.busy === true} onClick={() => void probeEndpoint(row, index)}>
                          {probe?.busy === true ? 'Testing…' : 'Fetch models'}
                        </button>
                      </div>
                      <span style={probe?.error === true ? S.warn : S.hint}>{probe?.message ?? 'Click "Fetch models" to list what the endpoint serves with the stored key; typing the id by hand also works.'}</span>
                      {probe?.models !== undefined && probe.models.length > 0 ? (
                        <div style={S.models}>
                          {probe.models.slice(0, 12).map(model => (
                            <button key={model} type="button" style={S.modelChip} onClick={() => setRow(index, { model })}>{model}</button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <details>
                      <summary style={{ ...S.label, cursor: 'pointer' }}>Per-endpoint defaults (optional)</summary>
                      <div style={{ ...S.grid4, marginTop: 10 }}>
                        <label style={S.field}>
                          <span style={S.hint}>Seconds</span>
                          <input
                            style={S.input}
                            type="number"
                            min={MIN_SECONDS}
                            max={MAX_SECONDS}
                            value={row.seconds ?? ''}
                            placeholder={String(draft.defaultSeconds ?? 5)}
                            onChange={event => setRow(index, { seconds: numberOr(event.target.value) })}
                          />
                        </label>
                        <label style={S.field}>
                          <span style={S.hint}>Size</span>
                          <input
                            style={S.input}
                            value={row.size ?? ''}
                            placeholder={draft.defaultSize ?? '720p'}
                            list={`video-sizes-${row.id}`}
                            onChange={event => setRow(index, { size: event.target.value })}
                          />
                          <datalist id={`video-sizes-${row.id}`}>
                            {SIZE_TIER_VALUES.map(size => <option key={size} value={size} />)}
                          </datalist>
                        </label>
                        <label style={S.field}>
                          <span style={S.hint}>FPS</span>
                          <input
                            style={S.input}
                            type="number"
                            value={row.fps ?? ''}
                            placeholder={String(draft.defaultFps ?? 24)}
                            onChange={event => setRow(index, { fps: numberOr(event.target.value) })}
                          />
                        </label>
                        <label style={S.field}>
                          <span style={S.hint}>Orientation</span>
                          <select
                            style={S.input}
                            value={row.orientation ?? ''}
                            onChange={event => setRow(index, { orientation: event.target.value === '' ? undefined : event.target.value as Orientation })}
                          >
                            <option value="">auto</option>
                            {ORIENTATIONS.map(orientation => <option key={orientation} value={orientation}>{orientation}</option>)}
                          </select>
                        </label>
                      </div>
                      <label style={{ ...S.inline, marginTop: 10, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={row.enhance === true}
                          onChange={event => setRow(index, { enhance: event.target.checked })}
                        />
                        run the endpoint prompt enhancer for this endpoint
                      </label>
                    </details>

                    <div style={S.inline}>
                      <button type="button" style={S.danger} onClick={() => removeEndpoint(index)}>Remove endpoint</button>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
          <div style={{ ...S.item, padding: '10px 14px' }}>
            <button type="button" style={S.button} onClick={addEndpoint} disabled={rows.length >= MAX_CONNECTIONS}>
              + Add endpoint
            </button>
            <span style={{ ...S.hint, marginLeft: 10 }}>{String(rows.length)}/{String(MAX_CONNECTIONS)}</span>
          </div>
        </div>
      </section>

      <div style={S.divider} />

      <section>
        <h3 style={S.sectionTitle}>Defaults</h3>
        <p style={S.sectionLead}>Applied when a tool call does not ask for its own values.</p>
        <div style={{ ...S.grid4, marginTop: 10 }}>
          <label style={S.field}>
            <span style={S.hint}>Seconds</span>
            <input
              style={S.input}
              type="number"
              min={MIN_SECONDS}
              max={MAX_SECONDS}
              value={draft.defaultSeconds ?? 5}
              onChange={event => setDraft(current => ({ ...current, defaultSeconds: numberOr(event.target.value, 5) }))}
            />
          </label>
          <label style={S.field}>
            <span style={S.hint}>Size</span>
            <input
              style={S.input}
              value={draft.defaultSize ?? '720p'}
              list="video-default-sizes"
              onChange={event => setDraft(current => ({ ...current, defaultSize: event.target.value }))}
            />
            <datalist id="video-default-sizes">
              {SIZE_TIER_VALUES.map(size => <option key={size} value={size} />)}
            </datalist>
          </label>
          <label style={S.field}>
            <span style={S.hint}>FPS</span>
            <input
              style={S.input}
              type="number"
              value={draft.defaultFps ?? 24}
              onChange={event => setDraft(current => ({ ...current, defaultFps: numberOr(event.target.value, 24) }))}
            />
          </label>
          <label style={S.field}>
            <span style={S.hint}>Orientation</span>
            <select
              style={S.input}
              value={draft.defaultOrientation ?? ''}
              onChange={event => setDraft(current => ({ ...current, defaultOrientation: event.target.value === '' ? undefined : event.target.value as Orientation }))}
            >
              <option value="">auto</option>
              {ORIENTATIONS.map(orientation => <option key={orientation} value={orientation}>{orientation}</option>)}
            </select>
          </label>
        </div>
        <label style={{ ...S.field, marginTop: 12 }}>
          <span style={S.hint}>Negative prompt</span>
          <input
            style={S.input}
            value={draft.negativePrompt ?? ''}
            placeholder="blurry, watermark, text overlay"
            onChange={event => setDraft(current => ({ ...current, negativePrompt: event.target.value }))}
          />
        </label>
        <label style={{ ...S.inline, marginTop: 12, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={draft.defaultEnhance === true}
            onChange={event => setDraft(current => ({ ...current, defaultEnhance: event.target.checked }))}
          />
          run the endpoint prompt enhancer by default
        </label>
      </section>

      <div style={S.divider} />

      <section>
        <h3 style={S.sectionTitle}>Workspace</h3>
        <label style={{ ...S.inline, marginTop: 8, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={draft.saveToWorkspace !== false}
            onChange={event => setDraft(current => ({ ...current, saveToWorkspace: event.target.checked }))}
          />
          Save each finished clip into the session workspace
        </label>
        <label style={{ ...S.field, marginTop: 10 }}>
          <span style={S.hint}>Workspace folder</span>
          <input
            style={S.input}
            value={draft.workspaceFolder ?? 'videos'}
            placeholder="videos"
            onChange={event => setDraft(current => ({ ...current, workspaceFolder: event.target.value }))}
          />
          <span style={S.hint}>Subdirectory of the session workspace; empty means the workspace root.</span>
        </label>
        <label style={{ ...S.inline, marginTop: 10, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={draft.saveThumbnail !== false}
            onChange={event => setDraft(current => ({ ...current, saveThumbnail: event.target.checked }))}
          />
          Keep the middle-frame thumbnail next to each clip
        </label>
      </section>

      <div style={S.divider} />

      <section>
        <h3 style={S.sectionTitle}>Interface</h3>
        <label style={{ ...S.field, marginTop: 10, maxWidth: 320 }}>
          <span style={S.hint}>Tool names</span>
          <select
            style={S.input}
            value={draft.toolNameSet ?? 'generic'}
            onChange={event => setDraft(current => ({ ...current, toolNameSet: event.target.value === 'prefixed' ? 'prefixed' : 'generic' }))}
          >
            <option value="generic">generate_video / check_video / cancel_video</option>
            <option value="prefixed">videogen_generate_video / videogen_check_video / videogen_cancel_video</option>
          </select>
          <span style={S.hint}>
            Tool names are global: use the prefixed family when another plugin already owns a verb. Changing this needs a
            host restart.
          </span>
        </label>
      </section>

      <div style={S.saveBar}>
        <button type="button" style={S.primary} disabled={busy || readOnly} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        <button
          type="button"
          style={S.button}
          disabled={busy}
          onClick={() => {
            setDraft(normalizeDraft(stored))
            setActive(textOf(stored?.activeConnection))
            setMessage(undefined)
          }}
        >
          Reset
        </button>
        {message === undefined ? null : <span style={message.tone === 'ok' ? S.ok : S.warn}>{message.text}</span>}
      </div>
    </div>
  )
}
