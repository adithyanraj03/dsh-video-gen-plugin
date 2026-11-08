/** Copy finished clips into the session workspace so the agent can read them as files. */
import { copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Home directory of the running host, honoring `DSH_HOME` the way the host does. */
export function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim() ?? ''
  if (configured.length > 0) return resolve(configured)
  const localAppData = process.env.LOCALAPPDATA?.trim() ?? ''
  if (process.platform === 'win32' && localAppData.length > 0) return resolve(localAppData, 'dsh')
  return join(homedir(), '.dsh')
}

/**
 * Workspace roots recorded by the host's workspace table, most recently used
 * first. The plugin cannot see which session issued a tool call, so this
 * ordering is what decides where a finished clip is copied.
 */
export async function getDshWorkspaceRoots(): Promise<string[]> {
  const file = join(dshHome(), 'storages', 'workspace.json')
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { tables?: { workspaces?: Record<string, unknown> } }
    const rows = Object.values(parsed.tables?.workspaces ?? {})
    const entries: { path: string; updatedAt: number }[] = []
    for (const row of rows) {
      const record = row as { path?: unknown; updatedAt?: unknown; lastOpenedAt?: unknown }
      if (typeof record?.path !== 'string' || record.path.trim().length === 0) continue
      const stamp = typeof record.lastOpenedAt === 'number' ? record.lastOpenedAt : typeof record.updatedAt === 'number' ? record.updatedAt : 0
      entries.push({ path: record.path.trim(), updatedAt: stamp })
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt).map(entry => entry.path)
  } catch {
    return []
  }
}

/** True when `child` equals `parent` or lives underneath it (lexically). */
function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Resolve the video folder inside a workspace, refusing escapes. */
export function workspaceVideoDir(workspaceRoot: string, folder: string | undefined): string {
  const trimmed = (folder ?? '').trim()
  const root = resolve(workspaceRoot)
  const dir = trimmed === '' ? root : resolve(root, trimmed)
  if (!containsPath(root, dir)) {
    throw new Error(`video workspace folder '${folder ?? ''}' must stay inside the session workspace`)
  }
  return dir
}

/** Real path of the closest existing ancestor, so symlinked folders cannot escape. */
async function nearestExistingRealPath(dir: string): Promise<string> {
  let probe = dir
  for (;;) {
    try {
      return await realpath(probe)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) throw error
      probe = parent
    }
  }
}

/**
 * Copy one finished clip into the session workspace.
 *
 * The copy is idempotent: the same clip always maps to the same file name, so
 * re-saving overwrites its previous copy instead of piling up duplicates. A
 * missing source is reported as a fix-naming error rather than skipped, because
 * the caller just watched the render finish.
 *
 * @param sourceFile - absolute path of the stored clip.
 * @param workspaceRoot - workspace directory to copy into.
 * @param folder - subfolder inside the workspace; empty means its root.
 * @returns the absolute path of the workspace copy.
 */
export async function saveVideoToWorkspace(sourceFile: string, workspaceRoot: string, folder: string | undefined): Promise<string> {
  const dir = workspaceVideoDir(workspaceRoot, folder)
  const realRoot = await realpath(workspaceRoot)
  const realDir = await nearestExistingRealPath(dir)
  if (!containsPath(realRoot, realDir)) {
    throw new Error(`video workspace folder '${folder ?? ''}' resolves outside the session workspace through a symlink`)
  }
  await mkdir(realDir, { recursive: true })
  const name = basename(sourceFile)
  const target = join(realDir, name)
  if (!(await statOrNull(sourceFile))) {
    throw new Error(`the stored clip ${sourceFile} is gone; the host may have cleaned ${dirname(sourceFile)} — regenerate the clip.`)
  }
  const existing = await statOrNull(target)
  const source = await statOrNull(sourceFile)
  if (existing !== null && source !== null && existing.size === source.size && existing.mtimeMs < source.mtimeMs) {
    // A stale copy from an earlier render of the same name is replaced below anyway.
    void existing
  }
  await copyFile(sourceFile, target)
  return target
}

async function statOrNull(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await lstat(path)
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null
  } catch {
    return null
  }
}

/**
 * Pick the workspace a finished clip should land in: the first known root that
 * still exists on disk.
 */
export async function selectWorkspaceRoot(known: ReadonlySet<string>): Promise<string | undefined> {
  const candidates = [...known, ...(await getDshWorkspaceRoots()), process.cwd()]
  for (const candidate of candidates) {
    const resolved = resolve(candidate)
    try {
      const info = await lstat(resolved)
      if (info.isDirectory()) return resolved
    } catch {
      // A stale entry in the workspace table is simply skipped.
    }
  }
  return undefined
}
