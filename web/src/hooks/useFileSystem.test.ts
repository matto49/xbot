import { beforeEach, expect, it, vi } from 'vitest'
import { postAPI, postRawAPI } from '@/lib/api'
import { fetchImageBlobUrl, readFile, writeFile } from './useFileSystem'
vi.mock('@/lib/api', () => ({ postAPI: vi.fn(), postRawAPI: vi.fn() }))
beforeEach(() => { vi.mocked(postAPI).mockReset() })
it('sends exact version and bound source via authenticated shared API', async () => {
  const source = { channel: 'web', chat_id: 'session-a' }
  vi.mocked(postAPI).mockResolvedValue({ version: 'next' })
  await writeFile('/workspace/file.ts', 'draft', 'loaded-sha', source)
  expect(postAPI).toHaveBeenCalledWith('/api/fs/write', { path: '/workspace/file.ts', content: 'draft', expectedVersion: 'loaded-sha', ...source })
  await readFile('/workspace/file.ts', undefined, source)
  expect(postAPI).toHaveBeenLastCalledWith('/api/fs/read', { path: '/workspace/file.ts', ...source }, { signal: undefined })
})
it('propagates conflicts without retrying or overwriting', async () => {
  vi.mocked(postAPI).mockRejectedValue(new Error('version_conflict'))
  await expect(writeFile('/workspace/file.ts', 'draft', 'sha')).rejects.toThrow('version_conflict')
  expect(postAPI).toHaveBeenCalledOnce()
})

it('passes bound source to raw image reads', async () => {
  const create = vi.fn(() => 'blob:source-image')
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create })
  const blob = new Blob(['image'])
  vi.mocked(postRawAPI).mockResolvedValue({ blob: async () => blob } as Response)
  const source = { channel: 'web', chat_id: 'source-a' }
  expect(await fetchImageBlobUrl('/workspace/image.png', source)).toBe('blob:source-image')
  expect(postRawAPI).toHaveBeenCalledWith('/api/fs/read', { path: '/workspace/image.png', raw: true, ...source })
  expect(create).toHaveBeenCalledWith(blob)
  vi.unstubAllGlobals()
})
