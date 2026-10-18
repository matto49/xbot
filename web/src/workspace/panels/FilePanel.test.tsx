import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { attachEditor } from '@/plugin-runtime/editorRegistry'
import { FilePanel } from './FilePanel'

const { html, save, draftState } = vi.hoisted(() => ({
  save: vi.fn(),
  draftState: { dirty: true, saving: false, readOnly: false },
  html: '<!doctype html><html><body><h1>Preview</h1></body></html>',
}))

vi.mock('@/hooks/useFileContent', () => ({
  useFileContent: () => ({
    content: html,
    loading: false,
    error: null,
    setContent: vi.fn(),
    imageUrl: null,
    save,
    ...draftState,
  }),
}))

vi.mock('@/workspace/types', () => ({
  useDockviewContext: () => ({ ws: {}, cwd: { cwd: '/workspace' } }),
}))

vi.mock('@/plugin-runtime/editorRegistry', () => ({ attachEditor: vi.fn(() => vi.fn()) }))

vi.mock('@/providers/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

vi.mock('@/components/file/FileToolbar', () => ({ FileToolbar: () => null }))
vi.mock('@/components/file/MonacoEditor', () => ({ MonacoEditor: () => null }))
vi.mock('@/components/file/MarkdownPreview', () => ({ MarkdownPreview: () => null }))
vi.mock('@/components/file/ImagePreview', () => ({ ImagePreview: () => null }))

describe('FilePanel', () => {
  it('renders HTML from POST-loaded content without a GET preview URL', () => {
    render(<FilePanel
      params={{
        tabId: 'file-page',
        type: 'file',
        title: 'page.html',
        filePath: '/workspace/page.html',
        closable: true,
      }}
      api={null as never}
      containerApi={null as never}
    />)

    const frame = screen.getByTitle('page.html')
    expect(frame.getAttribute('srcdoc')).toBe(html)
    expect(frame.hasAttribute('src')).toBe(false)
  })
})

const params = { tabId: 'code', type: 'file' as const, title: 'code.ts', filePath: '/workspace/code.ts', closable: true }
it('scopes Mod+S to the panel and guards the Dockview close API', () => {
  const close = vi.fn()
  const api = { close }
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const panel = render(<FilePanel params={params} api={api as never} containerApi={null as never} />)
  fireEvent.keyDown(panel.container.firstChild!, { key: 's', ctrlKey: true })
  expect(save).toHaveBeenCalledOnce()
  fireEvent.keyDown(document.body, { key: 's', metaKey: true })
  expect(save).toHaveBeenCalledOnce()
  api.close()
  expect(confirm).toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  api.close()
  expect(close).toHaveBeenCalledOnce()
  panel.unmount()
  expect(api.close).toBe(close)
  confirm.mockRestore()
})

it('does not invent a Dockview close API on the mobile shell', () => {
  const api = {}
  const panel = render(<FilePanel params={{ ...params, editorId: 'mobile-editor' }} api={api as never} containerApi={null as never} />)
  expect('close' in api).toBe(false)
  const controller = vi.mocked(attachEditor).mock.calls.at(-1)![1]
  expect(() => controller.close()).not.toThrow()
  panel.unmount()
  expect('close' in api).toBe(false)
})
