# Plan: Web 侧边文件编辑区

## Summary
重点是复用现有 file 能力，让用户一边聊天一边读取、编辑并保存工作区代码文件，带语法高亮和行号；不是另建只读预览组件。优先复用 FileExplorer、FilePanel、MonacoEditor 及 Dockview 右侧分组，保留现有文件标签及插件编辑器 API。Markdown/图片预览仅沿用已有功能，不作为主线。

## 已核实的现状
- `web/src/components/sidebar/FileExplorer.tsx` 已能将文件作为 file 标签打开。
- `web/src/workspace/panels/FilePanel.tsx` 已复用 MonacoEditor，支持按文件类型选语言；编辑当前仅更新组件 state，文件注释明确未持久化。
- `web/src/components/file/MonacoEditor.tsx` 默认可编辑，已有语法高亮能力。
- `web/src/hooks/useFileSystem.ts` 已有读取、列目录、搜索及 stat 方法；尚未发现 writeFile 封装。实施前需继续核实后端路由及底层写文件能力，不能把界面里可输入当成已保存。
- `useTabManager` 默认将新文件放进现有分组；应新增显式的右侧文件打开方式，不全局改写默认 openTab 规则。

## Changes

### `web/src/hooks/useTabManager.ts`、`web/src/workspace/DockviewContainer.tsx`
- 提供显式的侧边打开入口，复用 Dockview 的分组、拖宽、关闭及文件标签管理。
- 聊天保持可见且不卸载；同文件重复打开应复用目标标签，避免覆盖未保存内容。
- 保留原有 openTab 及插件 openFileTab 语义，不另造独立编辑器状态系统。

### `web/src/components/sidebar/FileExplorer.tsx` 及文件入口
- 将侧边文件编辑入口接入现有 file 标签能力，保留原有打开方式。
- 聊天中可识别的工作区文件链接可接入同一入口；普通外链、附件下载保持原行为。任意内联代码不自动识别为路径。

### `web/src/workspace/panels/FilePanel.tsx`、`web/src/components/file/FileToolbar.tsx`、文件内容 hook
- 复用现有 MonacoEditor，实现代码文本读取、编辑、真实保存。
- 保存按钮及 Ctrl/Cmd+S；显示未保存状态、保存中、成功/失败反馈。关闭/换文件前处理未保存修改，保存失败不得丢草稿。
- 绑定打开时的工作区与绝对文件路径，避免切会话后写错目标。
- 保存进行中继续编辑时，不得把后续修改误标为已保存；读取与保存的过期响应不得覆盖新文件状态。
- 图片、二进制和 embedded 虚拟文件不作为可写代码文件处理；未知文本扩展名可退回纯文本。

### 文件系统接口及后端（具体文件待路由核实）
- 优先复用已有安全写文件能力；若 Web 缺少写接口，则补齐最小的鉴权写入通道和前端封装。
- 写入必须遵循现有用户/工作区/runner 权限边界与路径解析，不增加无约束主机路径写入接口。
- 核实文件大小/截断标志：截断内容不得直接整文件保存。优先采用冲突检测或版本校验，避免覆盖 Agent/外部工具并发修改；冲突时保留草稿并明确提示。
- 首版不扩展为文件创建/删除/重命名、自动保存或 IDE 语言服务项目。

### 测试及知识文档
- 覆盖代码读取/高亮、编辑、保存真实落盘、只读文件、保存失败、并发编辑/外部修改冲突、截断内容不可保存、路径与权限拒绝。
- 覆盖侧边打开、重复打开复用、聊天保持挂载及窄屏可用。
- 更新相关知识文档，不覆盖当前工作区的既有未提交修改。

## Risks
- 工作区存在大量未提交改动，实施前逐文件核对 diff，避免覆盖。
- 真实写入涉及权限和并发，不能仅复用 Monaco 的 onChange 就宣称支持文件写入。
- Dockview 标签关闭及布局恢复需核实脏状态生命周期；不得将完整文件草稿无界写入布局 localStorage。
- 移动端沿用现有文件工作视图，实施前确认编辑与未保存状态能保留，不强行复制桌面分栏。

## Extraction validation (2026-10-18)
- Extracted only local file editing onto `feat/web-side-file-editor`, base `04447be3`.
- Focused Vitest: 10 files, 74 tests passed (file-content/system/tab-manager, toolbar/explorer/search/panel, mobile shell/work-view, existing API helper tests).
- ESLint: all 24 changed frontend TypeScript/TSX files passed. `git diff --check` passed.
- Go tests and the full frontend build are delegated to the parent; they were not run during extraction. No browser/E2E, server, deployment, commit or push operations were performed.
- Existing `postAPI`/`postRawAPI` support JSON, cancellation and API errors on the clean base; no transport/package changes or Vercel dependency were extracted.

## Decision and boundaries
Local editing reuses FileExplorer/FileSearch, FilePanel/Monaco and explicit right-side Dockview opens. Markdown links and existing plugin APIs keep their base behavior. Remote execution targets reject editing rather than falling back to host access. The authenticated write handler provides bounded UTF-8 content, version conflicts and local atomic replacement; whole-host access remains the existing policy, not a new workspace sandbox. Backend integration-test source is included, but execution and full-build acceptance remain pending parent validation.

## Isolated branch verification

On the extracted branch: 74 focused frontend tests (10 files), focused ESLint, `go test ./channel/web -count=1`, `go build ./...`, and `npm --prefix web run build` passed. The extraction excludes Vercel/preview transport, annotations, immersive controls, and the separate published-attachment preview worktree. No live deployment was changed.
