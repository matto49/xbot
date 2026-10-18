import { StrictMode, type ReactNode } from 'react'
import { requestFileDraftClose } from './useFileDraft'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileContent } from './useFileContent'
import { fetchImageBlobUrl, readFile, writeFile } from './useFileSystem'
import type { WSConnection } from '@/types/ws'

vi.mock('./useFileSystem', () => ({
  readFile: vi.fn(), writeFile: vi.fn(), fetchImageBlobUrl: vi.fn(),
  joinPath: (base: string, name: string) => `${base}/${name}`,
}))
const ws = {} as WSConnection
let id = 0
function options() { return { filePath: `draft-${++id}.ts`, cwd: '/first', ws } }
const loaded = { content: 'original', version: 'v1', size: 8, isBinary: false, language: 'typescript' }

beforeEach(() => {
  vi.mocked(readFile).mockReset().mockResolvedValue(loaded)
  vi.mocked(writeFile).mockReset().mockResolvedValue({ version: 'v2' })
})

describe('file drafts and save', () => {
  it('writes the bound absolute path, never the new CWD', async () => {
    const initial = options()
    const { result, rerender } = renderHook(props => useFileContent(props), { initialProps: initial })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setContent('edited'))
    rerender({ ...initial, cwd: '/second' })
    await act(() => result.current.save())
    expect(writeFile).toHaveBeenCalledWith(`/first/${initial.filePath}`, 'edited', 'v1', undefined)
    expect(result.current.dirty).toBe(false)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('marks only the saved snapshot clean and prevents concurrent writes', async () => {
    let complete!: (value: { version: string }) => void
    vi.mocked(writeFile).mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const { result } = renderHook(() => useFileContent(optionsForTest))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setContent('snapshot'))
    let pending!: Promise<void>
    act(() => { pending = result.current.save() })
    act(() => result.current.setContent('newer'))
    await act(() => result.current.save())
    expect(writeFile).toHaveBeenCalledTimes(1)
    await act(async () => { complete({ version: 'v2' }); await pending })
    expect(result.current.content).toBe('newer')
    expect(result.current.dirty).toBe(true)
    expect(result.current.version).toBe('v2')
  })

  it('keeps failed/conflicting saves dirty and drafts survive unmount (mobile)', async () => {
    const initial = options()
    vi.mocked(writeFile).mockRejectedValue(new Error('conflict'))
    const hook = renderHook(() => useFileContent(initial))
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => hook.result.current.setContent('draft'))
    await act(() => hook.result.current.save())
    expect(hook.result.current.saveError).toBe('conflict')
    hook.unmount()
    const reopened = renderHook(() => useFileContent(initial))
    expect(reopened.result.current.content).toBe('draft')
    expect(reopened.result.current.dirty).toBe(true)
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it.each([
    { isBinary: true }, { truncated: true }, { version: undefined },
  ])('does not edit or save unsafe reads: %j', async override => {
    vi.mocked(readFile).mockResolvedValue({ ...loaded, ...override })
    const initial = options()
    const { result } = renderHook(() => useFileContent(initial))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setContent('must not write'))
    await act(() => result.current.save())
    expect(result.current.readOnly).toBe(true)
    expect(result.current.dirty).toBe(false)
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('does not allow writes after a failed read', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('permission denied'))
    const initial = options()
    const { result } = renderHook(() => useFileContent(initial))
    await waitFor(() => expect(result.current.error).toBe('permission denied'))
    act(() => result.current.setContent('draft'))
    await act(() => result.current.save())
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('embedded files remain read only', async () => {
    const initial = { ...options(), filePath: `embedded:test-${++id}` }
    const { result } = renderHook(() => useFileContent(initial))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.readOnly).toBe(true)
  })

  it('reopens clean files from disk and lets users recover conflicts via reload', async () => {
    const initial = options()
    const first = renderHook(() => useFileContent(initial))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    first.unmount()
    await act(async () => { await Promise.resolve() })
    vi.mocked(readFile).mockResolvedValue({ ...loaded, content: 'external', version: 'v3' })
    const second = renderHook(() => useFileContent(initial))
    await waitFor(() => expect(second.result.current.content).toBe('external'))
    act(() => second.result.current.setContent('draft'))
    vi.mocked(writeFile).mockRejectedValue(new Error('conflict'))
    await act(() => second.result.current.save())
    act(() => second.result.current.reload?.())
    await waitFor(() => expect(second.result.current.dirty).toBe(false))
    expect(second.result.current.content).toBe('external')
    expect(second.result.current.saveError).toBeNull()
  })

  it('binds read/write to the opening source and isolates identical paths across sources', async () => {
    const initial = { ...options(), source: { channel: 'web', chat_id: 'a' } }
    const hook = renderHook(props => useFileContent(props), { initialProps: initial })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => hook.result.current.setContent('a draft'))
    await act(() => hook.result.current.save())
    expect(writeFile).toHaveBeenLastCalledWith(`/first/${initial.filePath}`, 'a draft', 'v1', initial.source)
    hook.rerender({ ...initial, source: { channel: 'web', chat_id: 'b' } })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.content).toBe('original')
    expect(readFile).toHaveBeenLastCalledWith(`/first/${initial.filePath}`, undefined, { channel: 'web', chat_id: 'b' })
  })

  it('loads once under StrictMode and retains dirty state across effect replay and remount', async () => {
    const initial = options()
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    const hook = renderHook(() => useFileContent(initial), { wrapper })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    await act(async () => { await Promise.resolve() })
    expect(readFile).toHaveBeenCalledTimes(1)
    act(() => hook.result.current.setContent('strict draft'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(requestFileDraftClose(`/first/${initial.filePath}`, undefined, 'close?')).toBe(false)
    expect(confirm).toHaveBeenCalledWith('close?')
    hook.unmount()
    await act(async () => { await Promise.resolve() })
    const reopened = renderHook(() => useFileContent(initial), { wrapper })
    expect(reopened.result.current.content).toBe('strict draft')
    expect(readFile).toHaveBeenCalledTimes(1)
    confirm.mockRestore()
  })

  it('reloads after the final clean StrictMode subscriber really unmounts', async () => {
    const initial = options()
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    const first = renderHook(() => useFileContent(initial), { wrapper })
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    await act(async () => { await Promise.resolve() })
    first.unmount()
    await act(async () => { await Promise.resolve() })
    const reopened = renderHook(() => useFileContent(initial), { wrapper })
    await waitFor(() => expect(reopened.result.current.loading).toBe(false))
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it('late loads cannot replace the newly opened file', async () => {
    let finish!: (value: typeof loaded) => void
    vi.mocked(readFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const initial = options()
    const { result, rerender } = renderHook(props => useFileContent(props), { initialProps: initial })
    rerender(options())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setContent('new file draft'))
    await act(async () => { finish({ ...loaded, content: 'old file' }) })
    expect(result.current.content).toBe('new file draft')
  })
})
const optionsForTest = { filePath: 'saving-snapshot.ts', cwd: '/first', ws }

describe('image source identity', () => {
  it('reloads identical image paths across sources and revokes both object URLs', async () => {
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revoke })
    vi.mocked(fetchImageBlobUrl).mockReset().mockResolvedValueOnce('blob:a').mockResolvedValueOnce('blob:b')
    const initial = { ...options(), filePath: '/same/image.png', source: { channel: 'web', chat_id: 'a' } }
    const hook = renderHook(props => useFileContent(props), { initialProps: initial })
    await waitFor(() => expect(hook.result.current.imageUrl).toBe('blob:a'))
    expect(fetchImageBlobUrl).toHaveBeenLastCalledWith('/same/image.png', initial.source)
    hook.rerender({ ...initial, source: { channel: 'web', chat_id: 'b' } })
    expect(hook.result.current.imageUrl).toBeNull()
    await waitFor(() => expect(hook.result.current.imageUrl).toBe('blob:b'))
    expect(fetchImageBlobUrl).toHaveBeenLastCalledWith('/same/image.png', { channel: 'web', chat_id: 'b' })
    expect(revoke).toHaveBeenCalledWith('blob:a')
    hook.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:b')
    vi.unstubAllGlobals()
  })

  it('revokes a cancelled late image load without displaying it', async () => {
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revoke })
    let finish!: (url: string) => void
    vi.mocked(fetchImageBlobUrl).mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce('blob:new')
    const initial = { ...options(), filePath: '/same/image.png', source: { channel: 'web', chat_id: 'a' } }
    const hook = renderHook(props => useFileContent(props), { initialProps: initial })
    hook.rerender({ ...initial, source: { channel: 'web', chat_id: 'b' } })
    await waitFor(() => expect(hook.result.current.imageUrl).toBe('blob:new'))
    await act(async () => { finish('blob:late') })
    expect(hook.result.current.imageUrl).toBe('blob:new')
    expect(revoke).toHaveBeenCalledWith('blob:late')
    hook.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:new')
    vi.unstubAllGlobals()
  })
})

it('releases a clean draft when an unmounted save finishes', async () => {
  const initial = options()
  let finish!: (value: { version: string }) => void
  vi.mocked(writeFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const hook = renderHook(() => useFileContent(initial))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  act(() => hook.result.current.setContent('saved while unmounted'))
  let pending!: Promise<void>
  act(() => { pending = hook.result.current.save() })
  hook.unmount()
  await act(async () => { finish({ version: 'v2' }); await pending })
  vi.mocked(readFile).mockResolvedValueOnce({ ...loaded, content: 'changed externally', version: 'v3' })
  const reopened = renderHook(() => useFileContent(initial))
  await waitFor(() => expect(reopened.result.current.content).toBe('changed externally'))
  expect(readFile).toHaveBeenCalledTimes(2)
})
