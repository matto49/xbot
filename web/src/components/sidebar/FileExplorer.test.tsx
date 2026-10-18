import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorer } from './FileExplorer'
import type { TabManager } from '@/hooks/useTabManager'

vi.mock('@/hooks/useFileSystem', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/useFileSystem')>(),
  statFile: vi.fn(async () => ({ name: 'target.ts', isDir: false })),
  invalidateFsCache: vi.fn(),
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => <button onClick={onSelect}>{children}</button>,
}))
vi.mock('@/components/ui/TouchContextMenuTrigger', () => ({ TouchContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

const sessionState = vi.hoisted(() => ({ activeSession: { channel: 'web', chatID: 'source-chat' } }))
vi.mock('@/hooks/useSessionStore', () => ({ useSessionStore: () => sessionState }))

vi.mock('@/providers/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/providers/CwdProvider', () => ({ useCwd: () => ({ cwd: '/source' }) }))
vi.mock('@/hooks/useFileTree', () => ({ useFileTree: () => ({ tree: [
  { name: 'hello.ts', path: '/source/hello.ts', type: 'file', language: 'typescript' },
], flatFiles: [], loading: false, error: null, expandDir: vi.fn() }) }))
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))

describe('FileExplorer side opening', () => {
  beforeEach(() => { sessionState.activeSession = { channel: 'web', chatID: 'source-chat' } })

  it('captures each opening source without rebinding previously opened file payloads on session switch', () => {
    const openTab = vi.fn()
    const manager = { openTab } as unknown as TabManager
    const { rerender } = render(<FileExplorer tabManager={manager} />)
    fireEvent.click(screen.getByText('hello.ts'))
    sessionState.activeSession = { channel: 'cli', chatID: 'other-chat' }
    rerender(<FileExplorer tabManager={manager} />)
    fireEvent.click(screen.getByText('hello.ts'))
    expect(openTab.mock.calls[0][0].data).toMatchObject({ sourceChannel: 'web', sourceChatID: 'source-chat' })
    expect(openTab.mock.calls[1][0].data).toMatchObject({ sourceChannel: 'cli', sourceChatID: 'other-chat' })
  })

  it('binds a relative path-bar file to the displayed source directory before opening', async () => {
    const openTab = vi.fn()
    render(<FileExplorer tabManager={{ openTab } as unknown as TabManager} />)
    const input = screen.getByPlaceholderText('sidebar.pathBarPlaceholder')
    fireEvent.change(input, { target: { value: 'target.ts' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file', data: { filePath: '/source/target.ts', sourceChannel: 'web', sourceChatID: 'source-chat' },
    }), { position: 'right' }))
  })

  it('preserves the default tab-open path from the context menu', () => {
    const openTab = vi.fn()
    render(<FileExplorer tabManager={{ openTab } as unknown as TabManager} />)
    fireEvent.click(screen.getByText('sidebar.openInTab'))
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'file' }), undefined)
  })

  it('opens a source node on the right without changing its absolute identity', () => {
    const openTab = vi.fn()
    render(<FileExplorer tabManager={{ openTab } as unknown as TabManager} />)
    fireEvent.click(screen.getByText('hello.ts'))
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file', data: { filePath: '/source/hello.ts', fileLanguage: 'typescript', sourceChannel: 'web', sourceChatID: 'source-chat' },
    }), { position: 'right' })
  })
})
