import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileToolbar } from './FileToolbar'
vi.mock('@/providers/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

describe('FileToolbar save state', () => {
  it('saves dirty files and displays failures without clearing dirty status', () => {
    const save = vi.fn()
    render(<FileToolbar fileName="code.ts" mode="editor" canToggle={false} dirty onSave={save} saveError="version conflict" />)
    fireEvent.click(screen.getByRole('button', { name: 'file.save' }))
    expect(save).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toBe('file.unsaved')
    expect(screen.getByRole('alert').textContent).toBe('version conflict')
  })
  it.each([{ readOnly: true }, { saving: true }, { dirty: false }])('disables unsafe or redundant saves: %j', props => {
    render(<FileToolbar fileName="code.ts" mode="editor" canToggle={false} dirty onSave={vi.fn()} {...props} />)
    expect((screen.getByRole('button', { name: 'file.save' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
