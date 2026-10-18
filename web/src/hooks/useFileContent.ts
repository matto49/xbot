import { useEffect, useRef, useState } from 'react'
import { isImageFile } from '@/components/file/fileTypes'
import type { WSConnection } from '@/types/ws'
import { joinPath, fetchImageBlobUrl, type FileSource } from './useFileSystem'
import { useFileDraft } from './useFileDraft'

interface UseFileContentOptions {
  filePath: string
  ws: WSConnection
  cwd: string | null
  source?: FileSource
}

/** Resolve once per opened file, never retarget an editor when the session CWD changes. */
export function useFileContent({ filePath, cwd, source }: UseFileContentOptions) {
  const binding = useRef<{ filePath: string; path: string | null; source?: FileSource }>({ filePath: '', path: null })
  if (binding.current.filePath !== filePath || binding.current.source?.channel !== source?.channel || binding.current.source?.chat_id !== source?.chat_id) binding.current = { filePath, path: null, source }
  if (!binding.current.path && filePath) {
    if (filePath.startsWith('/') || filePath.startsWith('embedded:')) binding.current.path = filePath
    else if (cwd) binding.current.path = joinPath(cwd, filePath)
  }
  const absolutePath = binding.current.path
  const image = isImageFile(filePath)
  const draft = useFileDraft(image ? null : absolutePath, binding.current.source)
  const boundSource = binding.current.source
  const sourceChannel = boundSource?.channel
  const sourceChatID = boundSource?.chat_id
  const imageKey = JSON.stringify([absolutePath, sourceChannel, sourceChatID])
  const [imageState, setImageState] = useState<{ key: string; url: string | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!image || !absolutePath) return
    let cancelled = false
    let objectUrl: string | null = null
    void fetchImageBlobUrl(absolutePath, sourceChannel && sourceChatID ? { channel: sourceChannel, chat_id: sourceChatID } : undefined).then(url => {
      objectUrl = url
      if (cancelled) URL.revokeObjectURL(url)
      else setImageState({ key: imageKey, url, error: null })
    }, (error: unknown) => {
      if (!cancelled) setImageState({ key: imageKey, url: null, error: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [image, absolutePath, imageKey, sourceChannel, sourceChatID])
  const loadedImage = imageState?.key === imageKey ? imageState : null
  return {
    ...draft,
    absolutePath,
    loading: !absolutePath || (image ? !loadedImage : draft.loading),
    error: image ? loadedImage?.error ?? null : draft.error,
    imageUrl: image ? loadedImage?.url ?? null : null,
  }
}

export type UseFileContentResult = ReturnType<typeof useFileContent>
