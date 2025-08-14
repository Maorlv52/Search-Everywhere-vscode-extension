# 🔍 Search Everywhere Lite

Fast, minimalistic text search for VS Code & Cursor.  
🚀 Born from the need to move from JetBrains IDEs (like WebStorm) to VS Code/Cursor — this is the perfect “Search Everywhere”-style solution you’ve been missing.

**Last updated:** August 10, 2025

---

## Why this extension?

JetBrains IDEs have an amazing **Search Everywhere** feature that’s quick, smart, and shows results with context.  
When switching to VS Code or Cursor, I couldn’t find anything that felt the same — so I built it.  
Now you can enjoy lightning-fast, keyboard-driven search without leaving your flow.

---

## ✨ Features

- 🔎 **Text search** across files (case-insensitive by default)
- ⚡ **Instant results** with highlighted matches
- 🧠 **Context preview** around each match
- 🌐 **Custom WebView** with Prism.js syntax highlighting
- 🎯 **Keyboard navigation** (`Enter`, `↑/↓`, `Esc`)
- 🧭 **Scopes**: Workspace / Open files / Current file / `node_modules`
- 🏷 **Flags**: Case / Regex / Word — **re-searches immediately** when toggled
- 📌 **Single pinned panel** (no duplicate tabs), opens from **anywhere** in the UI
- 🚦 **Live progress** + cancels previous searches; ignores stale results
- 🧷 **Stable UI**: no flicker while toggling flags or changing scope

---

## 🎯 Scopes & Flags

**Scopes**
- **Workspace** *(default)* — ignores `node_modules`, `.git`, `dist`, `build`, `out`.
- **Open files** — currently visible editors + loaded docs.
- **Current file** — search only in the active file.
- **node_modules** — focused scan with smart limits (caps file size & per-file matches).

**Flags**
- **Case** — case sensitive matches.
- **Regex** — treat query as RegExp *(invalid patterns show a friendly error)*.
- **Word** — whole-word matches.

Switching scope or toggling any flag **re-runs the search immediately** with your last query.

---

## 🏎 Performance & UX

- **Native-first**: prefers VS Code’s built-in search (`findTextInFiles`); falls back to a fast parallel FS scan when needed.
- **Smart scanning**:
  - Cheap prefilter for non-regex queries
  - Size caps for huge files; stricter limits inside `node_modules`
  - Parallel workers with cancellation
- **Responsive by design**:
  - Cancels the previous search when you type/toggle/switch scope
  - Ignores stale results (monotonic sequence IDs)
  - Live progress: updates match & file counts while searching
- **Smooth UI**:
  - Single **pinned** WebView panel (no duplicate tabs)
  - Stable reveal from any view (Explorer/Git/Extensions/Terminal)
  - Atomic results update (no interim blank states)
  - No focus/scroll jank while the **Flags** menu is open

---
## ⌨️ Usage & Keybindings

**Open**
- `Cmd+Shift+A` (macOS) / `Ctrl+Shift+A` (Win/Linux)  
  Works from anywhere (Explorer, Git, Extensions, Terminal).

**Use**
- Type to search; results update instantly (debounced).
- `↑/↓` navigate results · `Enter` open · `Esc` close.
- Change **Scope** or toggle **Flags** — search re-runs immediately.

**Commands**
- `Search Everywhere: Open Custom Search (Text Search)`  
  (`searchEverywhere.openCustomSearch`)
- `Search Everywhere: Bind to ⌘⇧F (override Find in Files)`  
  (`searchEverywhere.bindCmdShiftF`)

**Optional: replace Find in Files (⌘⇧F)**
```json
[
  { "key": "cmd+shift+f", "command": "searchEverywhere.openCustomSearch", "when": "editorTextFocus || !editorIsOpen" },
  { "key": "cmd+shift+f", "command": "-workbench.action.findInFiles" }
]
```

---

✅ **Lightweight** – zero config  
💡 **Perfect for large monorepos**  
🌈 Built with TypeScript, Prism.js, and WebView magic

---

## Screenshots

![Search Panel](https://raw.githubusercontent.com/Maorlv52/Search-Everywhere-vscode-extension/dev/media/singleResult.png)  
*Single result*

![Results Highlight](https://raw.githubusercontent.com/Maorlv52/Search-Everywhere-vscode-extension/dev/media/multipleResults.png)  
*Multiple results*  
*Syntax-highlighted matches with `<mark>` highlighting and context*

![Flags Panel](https://raw.githubusercontent.com/Maorlv52/Search-Everywhere-vscode-extension/dev/media/flags.png)  
*Flags used for search*


---

## 🛠 Development (for contributors)

```bash
pnpm install
pnpm run compile
pnpm exec vsce package
