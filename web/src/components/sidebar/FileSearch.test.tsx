import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileSearch } from './FileSearch'
import type { TabManager } from '@/hooks/useTabManager'

vi.mock('@/hooks/useSessionStore', () => ({ useSessionStore: () => ({ activeSession: { channel: 'web', chatID: 'source-chat' } }) }))

vi.mock('@/providers/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/useFileTree', () => ({ useFileTree: () => ({ flatFiles: [
  { name: 'hello.ts', path: '/source/hello.ts', type: 'file', language: 'typescript' },
] }) }))
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))

describe('FileSearch side opening', () => {
  it('uses explicit right placement with the source absolute path and language', async () => {
    const openTab = vi.fn()
    render(<FileSearch tabManager={{ openTab } as unknown as TabManager} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    await waitFor(() => expect(screen.getByRole('button', { name: /hello.ts/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /hello.ts/ }))
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'file', data: { filePath: '/source/hello.ts', fileLanguage: 'typescript', sourceChannel: 'web', sourceChatID: 'source-chat' },
    }), { position: 'right' })
  })
})
