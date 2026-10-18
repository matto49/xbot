import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { readFile, writeFile, type FileSource, type FsReadResult } from './useFileSystem'

export interface FileDraftSnapshot {
  content: string
  savedContent: string
  loading: boolean
  error: string | null
  saveError: string | null
  saving: boolean
  version: string | null
  readOnly: boolean
  size: number
  isBinary: boolean
  truncated: boolean
}

class FileDraft {
  state: FileDraftSnapshot = { content: '', savedContent: '', loading: true, error: null, saveError: null, saving: false, version: null, readOnly: true, size: 0, isBinary: false, truncated: false }
  listeners = new Set<() => void>()
  private loadGeneration = 0
  private started = false
  readonly path: string
  readonly source?: FileSource
  constructor(path: string, source?: FileSource) {
    this.path = path
    this.source = source
  }
  ensureLoaded = () => {
    if (this.started) return
    this.started = true
    this.reload()
  }
  reload = () => {
    if (this.state.saving) return
    const generation = ++this.loadGeneration
    this.update({ loading: true, readOnly: true, error: null, saveError: null })
    void readFile(this.path, undefined, this.source).then((result: FsReadResult) => {
      if (generation !== this.loadGeneration) return
      this.update({ content: result.isBinary ? '' : result.content, savedContent: result.isBinary ? '' : result.content, loading: false, version: result.version ?? null, readOnly: this.path.startsWith('embedded:') || !!result.readOnly || result.isBinary || !!result.truncated || !result.version, size: result.size, isBinary: result.isBinary, truncated: !!result.truncated })
    }, (error: unknown) => {
      if (generation === this.loadGeneration) this.update({ loading: false, error: error instanceof Error ? error.message : String(error) })
    })
  }
  update(patch: Partial<FileDraftSnapshot>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  snapshot = () => this.state
  edit = (content: string) => {
    if (this.state.readOnly || this.state.loading || this.state.error) return
    this.update({ content, saveError: null })
  }
  save = async () => {
    const { content, savedContent, version, saving, readOnly, loading, error } = this.state
    if (readOnly || loading || error || saving || !version || content === savedContent) return
    this.update({ saving: true, saveError: null })
    try {
      const result = await writeFile(this.path, content, version, this.source)
      this.update({ savedContent: content, version: result.version, saving: false })
      releaseCleanDraft(this)
    } catch (error) {
      this.update({ saving: false, saveError: error instanceof Error ? error.message : String(error) })
    }
  }
}

// Drafts belong to file identities, not mounted Dockview/mobile component instances.
// Deliberately never put file bodies into the persisted layout/localStorage.
const drafts = new Map<string, FileDraft>()
let unloadInstalled = false
function draftKey(path: string, source?: FileSource) {
  return JSON.stringify([source?.channel, source?.chat_id, path])
}
function getDraft(path: string, source?: FileSource) {
  const key = draftKey(path, source)
  let draft = drafts.get(key)
  if (!draft) {
    draft = new FileDraft(path, source)
    drafts.set(key, draft)
  }
  return draft
}

function releaseCleanDraft(draft: FileDraft) {
  // Deferred so StrictMode effect replay can re-subscribe before eviction.
  queueMicrotask(() => {
    const key = draftKey(draft.path, draft.source)
    if (!draft.listeners.size && !draft.state.saving && draft.state.content === draft.state.savedContent && drafts.get(key) === draft) {
      drafts.delete(key)
    }
  })
}

function installUnloadGuard() {
  if (!unloadInstalled && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (event) => {
      if ([...drafts.values()].some(draft => draft.state.content !== draft.state.savedContent || draft.state.saving)) {
        event.preventDefault()
        event.returnValue = ''
      }
    })
    unloadInstalled = true
  }
}

/** Layout owners can call this before removing file panels via Dockview.removePanel. */
export function hasUnsavedFileDraft(path: string, source?: FileSource): boolean {
  const draft = drafts.get(draftKey(path, source))
  return !!draft && (draft.state.content !== draft.state.savedContent || draft.state.saving)
}

/** Confirm a close without discarding the retained in-memory draft. */
export function requestFileDraftClose(path: string, source: FileSource | undefined, message: string): boolean {
  return !hasUnsavedFileDraft(path, source) || window.confirm(message)
}

const empty: FileDraftSnapshot = { content: '', savedContent: '', loading: false, error: null, saveError: null, saving: false, version: null, readOnly: true, size: 0, isBinary: false, truncated: false }
const noopSubscribe = () => () => {}
const emptySnapshot = () => empty

export function useFileDraft(path: string | null, source?: FileSource) {
  const draft = path ? getDraft(path, source) : null
  const state = useSyncExternalStore(draft?.subscribe ?? noopSubscribe, draft?.snapshot ?? emptySnapshot)
  useEffect(() => {
    if (!draft || !path) return
    installUnloadGuard()
    draft.ensureLoaded()
    return () => { releaseCleanDraft(draft) }
  }, [draft, path])
  const setContent = useCallback((content: string) => draft?.edit(content), [draft])
  const save = useCallback(async () => { await draft?.save() }, [draft])
  return { ...state, setContent, save, reload: draft?.reload, dirty: state.content !== state.savedContent }
}
