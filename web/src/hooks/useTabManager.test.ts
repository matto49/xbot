import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  filterAgentPanels,
  groupCloseTargets,
  tabLogicalKey,
  tabLogicalKeyFromParams,
  useTabManager,
} from './useTabManager'

function agentPanel(id: string) {
  return { id, params: { type: 'agent', closable: false }, contentComponent: 'agent' }
}
function workPanel(id: string, type = 'file') {
  return { id, params: { type }, contentComponent: type }
}

describe('filterAgentPanels', () => {
  it('returns layout unchanged when there is no agent panel', () => {
    const layout = {
      grid: { root: { type: 'leaf', data: { views: ['a'], activeView: 'a', id: 'g' } } },
      panels: { a: workPanel('a') },
    }
    expect(filterAgentPanels(layout)).toBe(layout)
  })

  it('removes agent panels from the panels map and leaf group views', () => {
    const layout = {
      grid: { root: { type: 'leaf', data: { views: ['agent', 'work'], activeView: 'work', id: 'g' } } },
      panels: { agent: agentPanel('agent'), work: workPanel('work') },
    }
    const out = filterAgentPanels(layout) as {
      grid: { root: { data: { views: string[] } } }
      panels: Record<string, unknown>
    }
    expect(out.grid.root.data.views).toEqual(['work'])
    expect(Object.keys(out.panels)).toEqual(['work'])
  })

  it('drops an empty group but keeps the root a branch (dockview fromJSON invariant)', () => {
    const layout = {
      grid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { views: ['agent1'], activeView: 'agent1', id: 'g1' } },
            { type: 'leaf', data: { views: ['work'], activeView: 'work', id: 'g2' } },
          ],
        },
      },
      panels: { agent1: agentPanel('agent1'), work: workPanel('work') },
    }
    const out = filterAgentPanels(layout) as { grid: { root: { type: string; data: unknown[] } } }
    // dockview's fromJSON asserts "root must be of type branch" — the root may
    // NEVER be promoted to its single child (a leaf root crashes every restore).
    expect(out.grid.root.type).toBe('branch')
    expect(out.grid.root.data).toHaveLength(1)
    expect((out.grid.root.data[0] as { data: { views: string[] } }).data.views).toEqual(['work'])
  })

  it('keeps a nested single-child branch as a branch (no child promotion anywhere)', () => {
    const layout = {
      grid: {
        root: {
          type: 'branch',
          data: [
            {
              type: 'branch',
              data: [{ type: 'leaf', data: { views: ['agent1'], activeView: 'agent1', id: 'g1' } }],
            },
            { type: 'leaf', data: { views: ['work'], activeView: 'work', id: 'g2' } },
          ],
        },
      },
      panels: { agent1: agentPanel('agent1'), work: workPanel('work') },
    }
    const out = filterAgentPanels(layout) as {
      grid: { root: { type: string; data: { type: string; data: unknown[] }[] } }
    }
    // The emptied nested branch is removed; the surviving single leaf stays a
    // child of the root branch — structure is only ever pruned, never promoted.
    expect(out.grid.root.type).toBe('branch')
    expect(out.grid.root.data).toHaveLength(1)
    expect(out.grid.root.data[0].type).toBe('leaf')
  })

  it('returns null when every panel is filtered out', () => {
    const layout = {
      grid: {
        root: {
          type: 'branch',
          data: [{ type: 'leaf', data: { views: ['agent1'], activeView: 'agent1', id: 'g1' } }],
        },
      },
      panels: { agent1: agentPanel('agent1') },
    }
    // A layout whose grid tree is fully pruned has no restorable structure —
    // emitting `{ grid: { root: null } }` would crash fromJSON just like a leaf root.
    expect(filterAgentPanels(layout)).toBeNull()
  })

  it('keeps nested branch when multiple non-agent groups survive', () => {
    const layout = {
      grid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { views: ['w1'], activeView: 'w1', id: 'g1' } },
            { type: 'leaf', data: { views: ['w2'], activeView: 'w2', id: 'g2' } },
          ],
        },
      },
      panels: { w1: workPanel('w1'), w2: workPanel('w2') },
    }
    const out = filterAgentPanels(layout) as { grid: { root: { type: string; data: unknown[] } } }
    expect(out.grid.root.type).toBe('branch')
    expect(out.grid.root.data).toHaveLength(2)
  })
})

describe('tabLogicalKey: plugin view tabs', () => {
  it('dynamic instances (openViewTab with key) dedup by viewKey — same view id opens MULTIPLE tabs', () => {
    // 两个不同文件各开一个 diff tab（同一 viewId，不同 key）
    expect(
      tabLogicalKey({
        type: 'plugin',
        data: { viewId: 'xbot.git-fancy.diff', viewKey: 'git-diff:worktree:src/a.go' },
      }),
    ).toBe('plugin-view:git-diff:worktree:src/a.go')
    expect(
      tabLogicalKey({
        type: 'plugin',
        data: { viewId: 'xbot.git-fancy.diff', viewKey: 'git-diff:worktree:src/b.go' },
      }),
    ).toBe('plugin-view:git-diff:worktree:src/b.go')
  })

  it('static views (no viewKey) dedup by viewId', () => {
    expect(
      tabLogicalKey({ type: 'plugin', data: { viewId: 'xbot.git-fancy.panel' } }),
    ).toBe('plugin:xbot.git-fancy.panel')
  })

  it('params mirror: tabLogicalKeyFromParams reads viewKey first', () => {
    expect(
      tabLogicalKeyFromParams({ type: 'plugin', viewId: 'v', viewKey: 'k', tabId: 't', title: '', closable: true }),
    ).toBe('plugin-view:k')
    expect(
      tabLogicalKeyFromParams({ type: 'plugin', viewId: 'v', tabId: 't', title: '', closable: true }),
    ).toBe('plugin:v')
  })
})

describe('groupCloseTargets (tab 右键菜单批量关闭目标)', () => {
  // [A(不可关), B, C(self), D, E(不可关)] —— A/E 模拟常驻 tab（closable=false）。
  const tabs = [
    { tabId: 'A', closable: false },
    { tabId: 'B', closable: true },
    { tabId: 'C', closable: true },
    { tabId: 'D', closable: true },
    { tabId: 'E', closable: false },
  ]

  it('left：self 之前的可关 tab（常驻 tab 跳过）', () => {
    expect(groupCloseTargets(tabs, 'C', 'left')).toEqual(['B'])
  })

  it('right：self 之后的可关 tab（常驻 tab 跳过）', () => {
    expect(groupCloseTargets(tabs, 'C', 'right')).toEqual(['D'])
  })

  it('others：除 self 外全部可关 tab', () => {
    expect(groupCloseTargets(tabs, 'C', 'others')).toEqual(['B', 'D'])
  })

  it('all：全部可关 tab（含 self；常驻 tab 永不关闭）', () => {
    expect(groupCloseTargets(tabs, 'C', 'all')).toEqual(['B', 'C', 'D'])
  })

  it('边界：self 是第一个/最后一个 → left/right 为空；常驻 tab 全组 → 全空', () => {
    expect(groupCloseTargets(tabs, 'A', 'left')).toEqual([])
    expect(groupCloseTargets(tabs, 'E', 'right')).toEqual([])
    const allPinned = [
      { tabId: 'X', closable: false },
      { tabId: 'Y', closable: false },
    ]
    expect(groupCloseTargets(allPinned, 'X', 'all')).toEqual([])
    expect(groupCloseTargets(allPinned, 'X', 'others')).toEqual([])
  })

  it('未知 tabId（不在组内）→ 空结果', () => {
    expect(groupCloseTargets(tabs, 'Z', 'all')).toEqual([])
  })
})

/**
 * 认领「未绑定会话的引导占位 agent tab」—— 2026-09-16「切会话后同一 user 行
 * 重复渲染」根因修复的一半。
 *
 * 现象（e2e 实测 + DOM 铁证）：切到 S2 后 `hello from S2` 命中 **2 个**元素，
 * 两行的 `data-message-id` 完全相同（`db-3` / `turn-202-c`），且 `/api/history`
 * 对 chat-2 被拉**两次** —— 不是 reducer 重复造行，而是**同一会话被两个 agent
 * 面板渲染**：seed 建的无 sessionId 占位 tab 用 `params.sessionId ?? activeSession`
 * 解析会话（跟随 activeSession），侧栏点击又为同一会话新开 session tab；agent
 * tab 是 `renderer='always'`（常驻 DOM）⇒ 整棵消息列表 + SSE 双订阅。
 *
 * 契约：为会话打开 agent tab 时若存在未绑定会话的占位 tab ⇒ **会话绑到它身上**
 * （不新建第二个面板）；不同会话仍各自开面板。
 */
describe('openTab: 认领未绑定会话的占位 agent tab', () => {
  interface FakePanel {
    id: string
    params: Record<string, unknown>
    update: (p: { params: Record<string, unknown> }) => void
    api: { setActive: () => void; setTitle: (t: string) => void }
  }

  function makeApi() {
    const panels: FakePanel[] = []
    const titles: string[] = []
    const state = { activePanel: undefined as FakePanel | undefined }
    const api = {
      panels,
      get activePanel() {
        return state.activePanel
      },
      onDidAddPanel: () => ({ dispose: () => {} }),
      onDidRemovePanel: () => ({ dispose: () => {} }),
      onDidActivePanelChange: () => ({ dispose: () => {} }),
      addPanel: (opts: { id: string; params: Record<string, unknown> }) => {
        const panel: FakePanel = {
          id: opts.id,
          params: opts.params,
          update: (p) => {
            panel.params = p.params
          },
          api: {
            setActive: () => {
              state.activePanel = panel
            },
            setTitle: (t: string) => {
              titles.push(t)
            },
          },
        }
        panels.push(panel)
        return panel
      },
      getPanel: (id: string) => panels.find((p) => p.id === id),
      toJSON: () => ({}),
      fromJSON: () => {},
    }
    return { api, panels, titles }
  }

  it('会话 tab 复用占位面板（绝不产生第二个渲染同一会话的面板）', () => {
    const { result } = renderHook(() => useTabManager())
    const { api, panels, titles } = makeApi()
    act(() => result.current.bindApi(api as never))

    // seed：无 sessionId 的引导占位 tab（DockviewContainer 在"还没有已知会话"时建）
    act(() => {
      result.current.openTab({ type: 'agent', title: 'Agent', icon: 'bot', closable: true })
    })
    expect(panels).toHaveLength(1)
    expect(panels[0].params.sessionId).toBeUndefined()

    // 点击会话 ⇒ 会话绑到占位 tab 上（而不是再开一个面板渲染同一会话）
    let tabId = ''
    act(() => {
      tabId = result.current.openTab({
        type: 'agent',
        title: 'S1',
        icon: 'bot',
        closable: true,
        data: { filePath: 'chat-1', channel: 'web' },
      })
    })
    expect(panels).toHaveLength(1)
    expect(panels[0].params.sessionId).toBe('chat-1')
    expect(panels[0].params.title).toBe('S1')
    expect(titles).toContain('S1')
    expect(tabId).toBeTruthy()
  })

  it('不同会话仍各自开面板（认领只作用于未绑定会话的占位 tab）', () => {
    const { result } = renderHook(() => useTabManager())
    const { api, panels } = makeApi()
    act(() => result.current.bindApi(api as never))
    act(() => {
      result.current.openTab({ type: 'agent', title: 'Agent', icon: 'bot', closable: true })
    })
    act(() => {
      result.current.openTab({
        type: 'agent',
        title: 'S1',
        icon: 'bot',
        closable: true,
        data: { filePath: 'chat-1', channel: 'web' },
      })
    })
    act(() => {
      result.current.openTab({
        type: 'agent',
        title: 'S2',
        icon: 'bot',
        closable: true,
        data: { filePath: 'chat-2', channel: 'web' },
      })
    })
    expect(panels).toHaveLength(2)
    expect(panels.map((p) => p.params.sessionId)).toEqual(['chat-1', 'chat-2'])
  })
})
describe('explicit right-side file opening', () => {
  function setup() {
    type Group = { id: string }
    type Move = { group: Group; position: string }
    type Addition = { id: string; params: Record<string, unknown>; position?: { referencePanel: string; direction: string }; renderer?: string }
    type Panel = { id: string; params: Record<string, unknown>; group: Group; api: { setActive: () => void; moveTo: (options: Move) => void; close?: () => void } }
    const panels: Panel[] = []
    const additions: Addition[] = []
    const moves: Move[] = []
    const api = {
      panels, activePanel: undefined as Panel | undefined,
      onDidAddPanel: () => ({ dispose() {} }),
      onDidRemovePanel: () => ({ dispose() {} }),
      onDidActivePanelChange: () => ({ dispose() {} }),
      getPanel: (id: string | undefined) => panels.find(p => p.id === id),
      addPanel(opts: Addition) {
        additions.push(opts)
        const reference = api.getPanel(opts.position?.referencePanel)
        const panel: Panel = { id: opts.id, params: opts.params,
          group: opts.position?.direction === 'within' ? reference!.group : { id: opts.id },
          api: { setActive() { api.activePanel = panel }, moveTo(opts: Move) {
            moves.push(opts)
            panel.group = opts.position === 'right' ? { id: panel.id + '-right' } : opts.group
          } },
        }
        panels.push(panel)
        return panel
      },
    }
    const hook = renderHook(() => useTabManager())
    act(() => hook.result.current.bindApi(api as never))
    const open = (path: string, side = true, source?: { sourceChannel: string; sourceChatID: string }) => {
      let id = ''
      act(() => { id = hook.result.current.openTab({ type: 'file', title: path, closable: true, data: { filePath: path, ...source } }, side ? { position: 'right' } : undefined) })
      return id
    }
    act(() => hook.result.current.openTab({ type: 'agent', title: 'Chat', closable: false }))
    return { ...hook, api, panels, additions, moves, open }
  }

  it('creates a right group anchored to chat, then reuses it even after chat refocus', () => {
    const { api, panels, additions, open } = setup()
    open('/a')
    expect(additions[1].position).toEqual({ referencePanel: panels[0].id, direction: 'right' })
    api.activePanel = panels[0]
    open('/b')
    expect(additions[2].position).toEqual({ referencePanel: panels[1].id, direction: 'within' })
    expect(panels[1].group).not.toBe(panels[0].group)
    expect(panels[2].group).toBe(panels[1].group)
    expect(additions[0].renderer).toBe('always')
  })

  it('moves an existing same-group file without recreating or duplicating its editor', () => {
    const { panels, moves, open } = setup()
    const id = open('/a', false)
    expect(panels[1].group).toBe(panels[0].group)
    expect(open('/a')).toBe(id)
    expect(panels).toHaveLength(2)
    expect(moves).toEqual([{ group: panels[0].group, position: 'right' }])
    open('/a')
    expect(moves).toHaveLength(1)
  })

  it('retains dedup and focus indexes when an unsaved-file close is canceled', () => {
    const { result, api, panels, open } = setup()
    const id = open('/dirty')
    const original = panels[1]
    let closeAttempts = 0
    // FilePanel's close guard returns without removal when confirmation is canceled.
    original.api.close = () => { closeAttempts++ }
    act(() => result.current.closeTab(id))
    expect(closeAttempts).toBe(1)
    expect(panels).toHaveLength(2)

    api.activePanel = panels[0]
    act(() => result.current.setActiveTab(id))
    expect(api.activePanel).toBe(original)

    api.activePanel = panels[0]
    expect(open('/dirty')).toBe(id)
    expect(panels).toHaveLength(2)
    expect(api.activePanel).toBe(original)
  })

  it('binds source identity into params and resynced Tab.data, isolating identical paths across sources', () => {
    const { result, api, panels, open } = setup()
    const a = { sourceChannel: 'web', sourceChatID: 'chat-a' }
    const b = { sourceChannel: 'cli', sourceChatID: 'chat-b' }
    const first = open('/same', true, a)
    expect(open('/same', true, a)).toBe(first)
    expect(open('/same', true, b)).not.toBe(first)
    expect(panels).toHaveLength(3)
    expect(panels[1].params).toMatchObject(a)
    expect(panels[2].params).toMatchObject(b)
    act(() => result.current.bindApi(api as never))
    expect(result.current.tabs.find(tab => tab.id === first)?.data).toMatchObject(a)
    expect(open('/same', false)).not.toBe(first)
    expect(panels).toHaveLength(4)
  })

  it('default openTab still opens within the active group', () => {
    const { additions, panels, open } = setup()
    open('/a', false)
    expect(additions[1].position).toEqual({ referencePanel: panels[0].id, direction: 'within' })
  })


  it('moves an old sibling into the existing side group and retains the group when its first file closes', () => {
    const { api, panels, moves, additions, open } = setup()
    open('/old', false)
    api.activePanel = panels[0]
    open('/a')
    const rightGroup = panels[2].group
    open('/old')
    expect(moves.at(-1)).toEqual({ group: rightGroup, position: 'center' })
    panels.splice(2, 1)
    api.activePanel = panels[0]
    open('/b')
    expect(additions.at(-1)?.position).toEqual({ referencePanel: panels[1].id, direction: 'within' })
    expect(panels.at(-1)?.group).toBe(rightGroup)
  })

  it('does not mistake an unrelated active work tab for the chat anchor', () => {
    const { panels, additions, open } = setup()
    open('/ordinary', false)
    open('/side')
    expect(additions[2].position).toEqual({ referencePanel: panels[0].id, direction: 'right' })
  })

  it('keeps explicit placement when requests are queued before Dockview binds', () => {
    const { result } = renderHook(() => useTabManager())
    act(() => result.current.openTab({ type: 'file', title: 'queued', closable: true, data: { filePath: '/queued' } }, { position: 'right' }))
    const other = setup()
    act(() => result.current.bindApi(other.api as never))
    expect(other.additions.at(-1)?.position).toEqual({ referencePanel: other.panels[0].id, direction: 'right' })
  })
})


describe('source-scoped file logical keys', () => {
  it('preserves legacy file keys and uses unambiguous source tuples', () => {
    expect(tabLogicalKey({ type: 'file', data: { filePath: '/a' } })).toBe('file:/a')
    const data = { filePath: '/a', sourceChannel: 'web', sourceChatID: 'chat:1' }
    const key = tabLogicalKey({ type: 'file', data })
    expect(key).not.toBe('file:/a')
    expect(key).toBe(tabLogicalKeyFromParams({ ...data, type: 'file' } as never))
    expect(key).not.toBe(tabLogicalKey({ type: 'file', data: { ...data, sourceChannel: 'cli' } }))
    expect(key).not.toBe(tabLogicalKey({ type: 'file', data: { ...data, sourceChatID: 'chat:2' } }))
  })
})
