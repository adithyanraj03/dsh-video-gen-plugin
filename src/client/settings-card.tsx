/**
 * The plugin's own settings card: endpoints, keys, and defaults.
 *
 * Rendered inside the harness plugin page (`plugins.bundle.config`) and, on
 * older hosts, the per-plugin settings seat. Endpoints, keys, and models are
 * entirely user-supplied — nothing here assumes a vendor, which is what makes
 * the plugin publishable.
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
  fresh?: boolean | undefined
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
  toolNameSet?: 'generic' | 'ninfer' | undefined
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

const STYLE = {
  card: { display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 860 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  muted: { margin: 0, fontSize: 12, opacity: 0.7, lineHeight: 1.5 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
  endpoint: { border: '1px solid rgba(127,127,127,0.25)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 2, flex: '1 1 180px', minWidth: 140 },
  label: { fontSize: 11, opacity: 0.65 },
  input: { width: '100%', padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12 },
  monospace: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  button: { padding: '5px 10px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
  primary: { padding: '6px 14px', borderRadius: 6, border: '1px solid var(--dsh-accent, #4c8dff)', background: 'var(--dsh-accent, #4c8dff)', color: '#fff', cursor: 'pointer', fontSize: 12 },
  danger: { padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(229,83,75,0.5)', background: 'transparent', color: 'var(--dsh-danger, #e5534b)', cursor: 'pointer', fontSize: 11 },
  ok: { fontSize: 11, color: 'var(--dsh-success, #3fb950)' },
  warn: { fontSize: 11, color: 'var(--dsh-danger, #e5534b)' },
  badge: { fontSize: 10, padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.8 },
} as const

type KeyState = { configured: boolean; busy: boolean; error?: string }

/** Read one row field, coercing the numbers the form types as text. */
function numberOr(value: string, fallback?: number): number | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : fallback
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The settings card component. */
export function VideoSettingsCard(props: SettingsCardProps) {
  const { scope } = props
  const snapshot = useSettingsSnapshot(scope)
  const stored = snapshot.value
  const [draft, setDraft] = useState<VideoSettings>(() => normalizeDraft(stored))
  const [active, setActive] = useState<string>(() => textOf(stored?.activeConnection))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | undefined>(undefined)
  const [keys, setKeys] = useState<Record<string, KeyState>>({})
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [models, setModels] = useState<Record<string, string[]>>({})
  const [probe, setProbe] = useState<Record<string, { busy: boolean; message?: string; error?: boolean }>>({})
  const lastStored = useRef<string>(JSON.stringify(normalizeDraft(stored)))

  // Adopt host changes (another window saved, or the first load finished)
  // without discarding edits the user has already typed.
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

  const setRow = (index: number, patch: Partial<DraftConnection>): void => {
    setDraft(current => {
      const next = [...(current.connections ?? [])]
      const row = next[index]
      if (row === undefined) return current
      next[index] = { ...row, ...patch }
      return { ...current, connections: next }
    })
  }

  const addRow = (): void => {
    const taken = rows.map(row => row.id)
    const id = connectionSlug(`endpoint ${String(rows.length + 1)}`, taken)
    setDraft(current => ({
      ...current,
      connections: [...(current.connections ?? []), { id, label: '', baseUrl: '', model: '', apiKeyRef: '', fresh: true }],
    }))
    if (rows.length === 0) setActive(id)
  }

  const removeRow = (index: number): void => {
    setDraft(current => {
      const next = [...(current.connections ?? [])]
      next.splice(index, 1)
      return { ...current, connections: next }
    })
    setActive(current => (current === rows[index]?.id ? '' : current))
  }

  const describeKey = async (ref: string): Promise<void> => {
    if (ref.trim().length === 0) return
    setKeys(current => ({ ...current, [ref]: { ...(current[ref] ?? { configured: false }), busy: true } }))
    try {
      const response = await fetch(`${CREDENTIAL_ROUTE}?ref=${encodeURIComponent(ref)}`, { credentials: 'same-origin', cache: 'no-store' })
      const body = await response.json() as { configured?: boolean; writable?: boolean; message?: string }
      setKeys(current => ({
        ...current,
        [ref]: { configured: body.configured === true, busy: false, ...(body.message === undefined ? {} : { error: body.message }) },
      }))
    } catch (error) {
      setKeys(current => ({ ...current, [ref]: { configured: false, busy: false, error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  // Show stored/missing state for every key reference the card is about to use.
  const keyRefOf = (row: DraftConnection): string => (row.apiKeyRef ?? '').trim() || `${KEY_REF_PREFIX}${defaultKeyRef(row.id)}`
  const keyRefs = rows.map(row => keyRefOf(row)).join('|')
  useEffect(() => {
    const refs = keyRefs.split('|').filter(ref => ref.length > 0)
    for (const ref of refs) void describeKey(ref)
  }, [keyRefs])

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
      setMessage({ tone: 'ok', text: `Saved ${ref}.` })
    } catch (error) {
      setKeys(current => ({ ...current, [ref]: { configured: current[ref]?.configured ?? false, busy: false, error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const testRow = async (row: DraftConnection): Promise<void> => {
    const ref = keyRefOf(row)
    setProbe(current => ({ ...current, [row.id]: { busy: true } }))
    try {
      const response = await fetch(MODELS_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: row.baseUrl ?? '',
          apiKeyRef: ref,
          keyValue: keyInputs[ref]?.trim() ?? '',
        }),
      })
      const body = await response.json() as { ok?: boolean; models?: string[]; message?: string; code?: string }
      if (body.ok !== true) throw new Error(body.message ?? body.code ?? 'the endpoint did not answer')
      const list = body.models ?? []
      setModels(current => ({ ...current, [row.id]: list }))
      setProbe(current => ({
        ...current,
        [row.id]: { busy: false, message: list.length === 0 ? 'reachable, but it listed no video models — type the model id' : `${String(list.length)} model(s): ${list.slice(0, 6).join(', ')}` },
      }))
      if ((row.model ?? '').trim().length === 0 && list.length > 0) setRow(rows.indexOf(row), { model: list[0] as string })
      setMessage({ tone: 'ok', text: 'Endpoint answered.' })
    } catch (error) {
      setProbe(current => ({ ...current, [row.id]: { busy: false, error: true, message: error instanceof Error ? error.message : String(error) } }))
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
      await writeSetting(scope, 'toolNameSet', draft.toolNameSet === 'ninfer' ? 'ninfer' : 'generic')
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
    <div style={STYLE.card}>
      <div>
        <h2 style={STYLE.title}>Video generation</h2>
        <p style={STYLE.muted}>
          Bring your own video API. Add an endpoint, paste its key, fetch its models, and every
          <code> generate_video</code> call uses the endpoint marked below. The endpoint must speak the
          OpenAI-style asynchronous video API: <code>POST /videos</code>, <code>GET /videos/&#123;id&#125;</code>, and
          <code> GET /videos/&#123;id&#125;/content</code>.
        </p>
        {readOnly ? <p style={STYLE.warn}>This host does not accept settings writes from the page; edit the plugin config instead.</p> : null}
        {health?.settings === 'live' && health.liveSchema === false ? (
          <p style={STYLE.warn}>The loaded settings schema cannot be saved on this host (missing volatile fields). Check the schemastery version in this profile.</p>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p style={STYLE.muted}>No endpoint yet. Add one below to start generating clips.</p>
      ) : null}

      {rows.map((row, index) => {
        const ref = keyRefOf(row)
        const key = keys[ref]
        const state = probe[row.id]
        const rowModels = models[row.id] ?? []
        return (
          <div key={row.id} style={STYLE.endpoint}>
            <div style={STYLE.row}>
              <label style={STYLE.field}>
                <span style={STYLE.label}>Name</span>
                <input
                  style={STYLE.input}
                  value={row.label ?? ''}
                  placeholder="My video endpoint"
                  onChange={event => setRow(index, { label: event.target.value })}
                />
              </label>
              <label style={{ ...STYLE.row, gap: 4, fontSize: 12 }}>
                <input
                  type="radio"
                  name="video-active-endpoint"
                  checked={effectiveActive === row.id}
                  onChange={() => setActive(row.id)}
                />
                use this endpoint
              </label>
              <button type="button" style={STYLE.danger} onClick={() => removeRow(index)}>Remove</button>
            </div>

            <div style={STYLE.row}>
              <label style={STYLE.field}>
                <span style={STYLE.label}>Base URL (include the version prefix)</span>
                <input
                  style={{ ...STYLE.input, ...STYLE.monospace }}
                  value={row.baseUrl ?? ''}
                  placeholder="https://your-host/v1"
                  onChange={event => setRow(index, { baseUrl: event.target.value })}
                />
              </label>
              <label style={{ ...STYLE.field, flex: '0 1 220px' }}>
                <span style={STYLE.label}>Credential name</span>
                <input
                  style={{ ...STYLE.input, ...STYLE.monospace }}
                  value={row.apiKeyRef ?? ''}
                  placeholder={`VIDEO_GEN_KEY_${defaultKeyRef(row.id)}`}
                  onChange={event => setRow(index, { apiKeyRef: event.target.value })}
                />
              </label>
            </div>

            <div style={STYLE.row}>
              <label style={{ ...STYLE.field, flex: '1 1 220px' }}>
                <span style={STYLE.label}>API key {key === undefined ? '' : key.configured ? '(stored)' : '(missing)'}</span>
                <input
                  style={STYLE.input}
                  type="password"
                  autoComplete="off"
                  value={keyInputs[ref] ?? ''}
                  placeholder={key?.configured === true ? 'stored — paste a new key to replace' : 'paste the bearer token'}
                  onChange={event => setKeyInputs(current => ({ ...current, [ref]: event.target.value }))}
                />
              </label>
              <button type="button" style={STYLE.button} disabled={key?.busy === true} onClick={() => void saveKey(row)}>
                {key?.busy === true ? 'Saving…' : 'Save key'}
              </button>
              <span style={key?.error === undefined ? STYLE.ok : STYLE.warn}>{key?.error ?? (key?.configured === true ? 'key stored' : '')}</span>
            </div>

            <div style={STYLE.row}>
              <label style={{ ...STYLE.field, flex: '1 1 260px' }}>
                <span style={STYLE.label}>Model</span>
                <input
                  style={{ ...STYLE.input, ...STYLE.monospace }}
                  value={row.model ?? ''}
                  list={`video-models-${row.id}`}
                  placeholder="model id, e.g. ltx-2.5"
                  onChange={event => setRow(index, { model: event.target.value })}
                />
                <datalist id={`video-models-${row.id}`}>
                  {rowModels.map(model => <option key={model} value={model} />)}
                </datalist>
              </label>
              <button type="button" style={STYLE.button} disabled={state?.busy === true} onClick={() => void testRow(row)}>
                {state?.busy === true ? 'Testing…' : 'Test & fetch models'}
              </button>
              <span style={state?.error === true ? STYLE.warn : STYLE.ok}>{state?.message ?? ''}</span>
            </div>

            <details>
              <summary style={{ ...STYLE.label, cursor: 'pointer' }}>Per-endpoint defaults (optional)</summary>
              <div style={{ ...STYLE.row, marginTop: 8 }}>
                <label style={STYLE.field}>
                  <span style={STYLE.label}>Seconds</span>
                  <input
                    style={STYLE.input}
                    type="number"
                    min={MIN_SECONDS}
                    max={MAX_SECONDS}
                    value={row.seconds ?? ''}
                    onChange={event => setRow(index, { seconds: numberOr(event.target.value) })}
                  />
                </label>
                <label style={STYLE.field}>
                  <span style={STYLE.label}>Size</span>
                  <input
                    style={STYLE.input}
                    value={row.size ?? ''}
                    list={`video-sizes-${row.id}`}
                    placeholder="720p or 1280x704"
                    onChange={event => setRow(index, { size: event.target.value })}
                  />
                  <datalist id={`video-sizes-${row.id}`}>
                    {SIZE_TIER_VALUES.map(size => <option key={size} value={size} />)}
                  </datalist>
                </label>
                <label style={STYLE.field}>
                  <span style={STYLE.label}>FPS</span>
                  <input
                    style={STYLE.input}
                    type="number"
                    value={row.fps ?? ''}
                    onChange={event => setRow(index, { fps: numberOr(event.target.value) })}
                  />
                </label>
                <label style={STYLE.field}>
                  <span style={STYLE.label}>Orientation</span>
                  <select
                    style={STYLE.input}
                    value={row.orientation ?? ''}
                    onChange={event => setRow(index, { orientation: event.target.value === '' ? undefined : event.target.value as Orientation })}
                  >
                    <option value="">auto</option>
                    {ORIENTATIONS.map(orientation => <option key={orientation} value={orientation}>{orientation}</option>)}
                  </select>
                </label>
                <label style={{ ...STYLE.row, gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={row.enhance === true}
                    onChange={event => setRow(index, { enhance: event.target.checked })}
                  />
                  prompt enhancer
                </label>
              </div>
            </details>
          </div>
        )
      })}

      <div style={STYLE.row}>
        <button type="button" style={STYLE.button} onClick={addRow} disabled={rows.length >= MAX_CONNECTIONS}>
          Add endpoint
        </button>
        <span style={STYLE.badge}>{String(rows.length)}/{String(MAX_CONNECTIONS)}</span>
      </div>

      <div style={STYLE.endpoint}>
        <span style={STYLE.label}>Defaults for every endpoint</span>
        <div style={STYLE.row}>
          <label style={STYLE.field}>
            <span style={STYLE.label}>Seconds</span>
            <input
              style={STYLE.input}
              type="number"
              min={MIN_SECONDS}
              max={MAX_SECONDS}
              value={draft.defaultSeconds ?? 5}
              onChange={event => setDraft(current => ({ ...current, defaultSeconds: numberOr(event.target.value, 5) }))}
            />
          </label>
          <label style={STYLE.field}>
            <span style={STYLE.label}>Size</span>
            <input
              style={STYLE.input}
              value={draft.defaultSize ?? '720p'}
              list="video-default-sizes"
              onChange={event => setDraft(current => ({ ...current, defaultSize: event.target.value }))}
            />
            <datalist id="video-default-sizes">
              {SIZE_TIER_VALUES.map(size => <option key={size} value={size} />)}
            </datalist>
          </label>
          <label style={STYLE.field}>
            <span style={STYLE.label}>FPS</span>
            <input
              style={STYLE.input}
              type="number"
              value={draft.defaultFps ?? 24}
              onChange={event => setDraft(current => ({ ...current, defaultFps: numberOr(event.target.value, 24) }))}
            />
          </label>
          <label style={STYLE.field}>
            <span style={STYLE.label}>Orientation</span>
            <select
              style={STYLE.input}
              value={draft.defaultOrientation ?? ''}
              onChange={event => setDraft(current => ({ ...current, defaultOrientation: event.target.value === '' ? undefined : event.target.value as Orientation }))}
            >
              <option value="">auto</option>
              {ORIENTATIONS.map(orientation => <option key={orientation} value={orientation}>{orientation}</option>)}
            </select>
          </label>
        </div>
        <div style={STYLE.row}>
          <label style={STYLE.field}>
            <span style={STYLE.label}>Negative prompt</span>
            <input
              style={STYLE.input}
              value={draft.negativePrompt ?? ''}
              placeholder="blurry, watermark, text overlay"
              onChange={event => setDraft(current => ({ ...current, negativePrompt: event.target.value }))}
            />
          </label>
          <label style={STYLE.field}>
            <span style={STYLE.label}>Workspace folder</span>
            <input
              style={STYLE.input}
              value={draft.workspaceFolder ?? 'videos'}
              onChange={event => setDraft(current => ({ ...current, workspaceFolder: event.target.value }))}
            />
          </label>
          <label style={STYLE.field}>
            <span style={STYLE.label}>Tool names</span>
            <select
              style={STYLE.input}
              value={draft.toolNameSet ?? 'generic'}
              onChange={event => setDraft(current => ({ ...current, toolNameSet: event.target.value === 'ninfer' ? 'ninfer' : 'generic' }))}
            >
              <option value="generic">generic (generate_video)</option>
              <option value="ninfer">prefixed (ninfer_generate_video)</option>
            </select>
          </label>
        </div>
        <div style={STYLE.row}>
          <label style={{ ...STYLE.row, gap: 4, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={draft.defaultEnhance === true}
              onChange={event => setDraft(current => ({ ...current, defaultEnhance: event.target.checked }))}
            />
            use the endpoint prompt enhancer by default
          </label>
          <label style={{ ...STYLE.row, gap: 4, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={draft.saveToWorkspace !== false}
              onChange={event => setDraft(current => ({ ...current, saveToWorkspace: event.target.checked }))}
            />
            copy finished clips into the session workspace
          </label>
          <label style={{ ...STYLE.row, gap: 4, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={draft.saveThumbnail !== false}
              onChange={event => setDraft(current => ({ ...current, saveThumbnail: event.target.checked }))}
            />
            keep the middle-frame thumbnail
          </label>
        </div>
        <p style={STYLE.muted}>
          Tool names change after a host restart. A <code>ninfer</code> prefix is the escape hatch when
          another plugin already owns <code>generate_video</code>.
        </p>
      </div>

      <div style={STYLE.row}>
        <button type="button" style={STYLE.primary} disabled={busy || readOnly} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        <button
          type="button"
          style={STYLE.button}
          disabled={busy}
          onClick={() => {
            setDraft(normalizeDraft(stored))
            setActive(textOf(stored?.activeConnection))
            setMessage(undefined)
          }}
        >
          Reset
        </button>
        {message === undefined ? null : <span style={message.tone === 'ok' ? STYLE.ok : STYLE.warn}>{message.text}</span>}
      </div>
    </div>
  )
}

/** Copy a snapshot value into an editable draft with string-free defaults. */
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
    toolNameSet: value?.toolNameSet === 'ninfer' ? 'ninfer' : 'generic',
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
