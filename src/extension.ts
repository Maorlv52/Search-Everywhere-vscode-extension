import * as vscode from 'vscode';

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMMANDS = {
  open: 'searchEverywhere.openCustomSearch',
  bindF: 'searchEverywhere.bindCmdShiftF',
} as const;

export function activate(context: vscode.ExtensionContext) {
  // ----- OPEN CUSTOM SEARCH -----
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.open, async () => {
      const panel = vscode.window.createWebviewPanel(
        'searchEverywhereCustom',
        'Find in Files (Text Search)',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );

      let lastResults: { uri: vscode.Uri; line: number }[] = [];
      panel.webview.html = getWebviewHtml();

      // initial query: selection > word under cursor > clipboard
      const editor = vscode.window.activeTextEditor;
      const initialQuery = await pickInitialQuery(editor);
      panel.webview.postMessage({ type: 'init', initialQuery });

      // keep focus UX
      setTimeout(() => panel.webview.postMessage({ type: 'focusSearch' }), 50);

      panel.webview.onDidReceiveMessage(async (msg) => {
        const routes: Record<string, (m: any) => Promise<void>> = {
          async doSearch(m) {
            const queryRaw = (m.query ?? '').toString().trim();
            const query = queryRaw.toLowerCase();
            if (!query) {
              panel.webview.postMessage({
                type: 'renderResults',
                payload: { total: 0, groups: [], flatIds: [], query: queryRaw },
              });
              return;
            }

            const matches: { uri: vscode.Uri; line: number; preview?: string }[] = [];
            try {
              const includePattern = '**/*.{ts,js,json,tsx,jsx,html,css,scss,md,txt}';
              const excludePattern = '**/{node_modules,.git,dist,build,out}/**';
              const uris = await vscode.workspace.findFiles(includePattern, excludePattern, 1000);
              for (const uri of uris) {
                try {
                  const doc = await vscode.workspace.openTextDocument(uri);
                  const text = doc.getText();
                  const lines = text.split(/\r?\n/);
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(query)) {
                      matches.push({ uri, line: i, preview: lines[i] });
                      if (matches.length >= 1000) break;
                    }
                  }
                  if (matches.length >= 1000) break;
                } catch {
                  // ignore file read errors
                }
              }
            } catch (e) {
              console.error('Error during manual search', e);
            }

            await enrichWithContext(matches);
            lastResults = matches;

            const groupsMap = new Map<
              string,
              { file: string; entries: { id: number; line: number; highlightedHtml: string }[] }
            >();

            const flatIds: number[] = [];

            await Promise.all(
              matches.map(async (m, i) => {
                const wsFolder = vscode.workspace.getWorkspaceFolder(m.uri);
                const fileName = wsFolder
                  ? m.uri.fsPath.replace(wsFolder.uri.fsPath + '/', '')
                  : m.uri.fsPath;

                const group = groupsMap.get(fileName) ?? { file: fileName, entries: [] };
                const lang = detectLangFromFile(fileName);

                // highlight before escaping HTML
                const previewRaw = m.preview ?? '';
                const highlightedRaw = previewRaw.replace(
                  new RegExp(`(${escapeRegExp(queryRaw)})`, 'gi'),
                  '<mark>$1</mark>'
                );

                // escape HTML, keep <mark>
                const escapedPreview = escapeHtml(highlightedRaw)
                  .replace(/&lt;mark&gt;/g, '<mark>')
                  .replace(/&lt;\/mark&gt;/g, '</mark>');

                const prismWrapped = `<pre class="preview"><code class="language-${lang}">${escapedPreview}</code></pre>`;
                group.entries.push({ id: i, line: m.line, highlightedHtml: prismWrapped });
                groupsMap.set(fileName, group);
                flatIds.push(i);
              })
            );

            panel.webview.postMessage({
              type: 'renderResults',
              payload: {
                total: matches.length,
                groups: Array.from(groupsMap.values()),
                flatIds,
                query: queryRaw,
              },
            });
          },

          async openAt(m) {
            const idx = Number(m.id);
            if (!Number.isFinite(idx)) return;
            const rec = lastResults[idx];
            if (!rec) return;
            const doc = await vscode.workspace.openTextDocument(rec.uri);
            const ed = await vscode.window.showTextDocument(doc, { preview: false });
            const pos = new vscode.Position(rec.line, 0);
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          },

          async esc() {
            panel.dispose();
          },
        };

        if (msg?.type && msg.type in routes) {
          await routes[msg.type](msg);
        }
      });
    })
  );

  // ----- BIND CMD+SHIFT+F ASSISTANT -----
  const bindCmd = vscode.commands.registerCommand(COMMANDS.bindF, async () => {
    const snippet = JSON.stringify(
      [
        {
          "key": "cmd+shift+f",
          "command": "searchEverywhere.openCustomSearch",
          "when": "editorTextFocus || !editorIsOpen"
        },
        {
          "key": "cmd+shift+f",
          "command": "-workbench.action.findInFiles"
        }
      ],
      null,
      2
    );

    await vscode.env.clipboard.writeText(snippet);

    const choice = await vscode.window.showInformationMessage(
      "Snippet to bind ⌘⇧F to Search Everywhere copied to your clipboard. Open keybindings.json and paste it (replace existing ⌘⇧F if needed).",
      "Open keybindings.json"
    );

    if (choice) {
      await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
    }
  });
  context.subscriptions.push(bindCmd);

  // optional prompt if user enabled setting
  const maybePromptTakeOver = async () => {
    const takeOver = vscode.workspace.getConfiguration().get<boolean>('searchEverywhere.takeOverCmdShiftF');
    if (!takeOver) return;

    const selection = await vscode.window.showInformationMessage(
      "Bind ⌘⇧F to Search Everywhere? (will override the default Find in Files)",
      "Bind Now",
      "Not Now"
    );

    const actions: Record<string, () => Thenable<void> | void> = {
      "Bind Now": () => vscode.commands.executeCommand(COMMANDS.bindF),
      "Not Now": () => {}
    };

    if (selection && selection in actions) await actions[selection]();
  };
  maybePromptTakeOver();
}

function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Find in Files (Text Search)</title>

<link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />

<style>
pre[class*="language-"],
code[class*="language-"] {
  font-family: Menlo, Monaco, 'Courier New', monospace !important;
  font-size: 12px !important;
  line-height: 1.3 !important;
  background: none !important;
  margin: 0 !important;
  padding: 0 !important;
  white-space: pre-wrap !important;
  word-break: break-word !important;
}
pre[class*="language-"] { background: none !important; border: none !important; box-shadow: none !important; }
body { font-family: system-ui, sans-serif; margin: 0; background: #282c34; color: #abb2bf; }
header { padding: 12px; background: #21252b; display: flex; gap: 8px; }
input[type="text"] { flex: 1; padding: 8px; font-size: 14px; border-radius: 4px; border: none; outline:none; }
button { padding: 8px 12px; font-size: 14px; border-radius: 4px; border: none; cursor: pointer; background: #61afef; color: white; }
#results { padding: 10px; }
.fileHeader { font-weight: bold; color: #98c379; margin-top: 16px; position: sticky; top: 0; background: #21252b; padding: 4px 8px; }
ul { list-style: none; padding: 0; margin: 0; }
li.result { padding: 8px; border-bottom: 1px solid #3a3a3a; cursor: pointer; }
li.result:hover, li.result.selected { background: #3e4451; }
.line { width: 40px; display: inline-block; color: #61afef; text-align: right; margin-right: 8px; }
.preview { display: inline-block; vertical-align: top; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
mark { background-color: #ffea00; color: black; }
</style>
</head>
<body>
<header>
  <input id="searchInput" type="text" placeholder="Search text (case-insensitive)" autofocus />
  <button id="searchBtn">Search</button>
</header>
<div id="results">Type to search…</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-markup.min.js"></script>

<script>
const vscode = acquireVsCodeApi();
const input = document.getElementById('searchInput');
const btn = document.getElementById('searchBtn');
const results = document.getElementById('results');

let flatIndexToId = [];
let selection = -1;

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => { input.focus(); input.select(); }, 50);
});

function escapeRegExp(str) {
  return str.replace(/[.*+?^\\\\$\\{}()|[\\]\\\\]/g, '\\\\$&');
}

function clearSelection() {
  document.querySelectorAll('li.result.selected').forEach(el => el.classList.remove('selected'));
  selection = -1;
}

function applySelection(index) {
  const all = Array.from(document.querySelectorAll('li.result'));
  if (!all.length) return;
  selection = Math.max(0, Math.min(index, all.length - 1));
  all.forEach(el => el.classList.remove('selected'));
  const sel = all[selection];
  if (sel) {
    sel.classList.add('selected');
    sel.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }
}

function openSelected() {
  if (selection < 0) return;
  const id = flatIndexToId[selection];
  if (typeof id !== 'number') return;
  vscode.postMessage({ type: 'openAt', id });
  vscode.postMessage({ type: 'esc' });
}

function renderResults(data) {
  const { total, groups, flatIds } = data;
  results.innerHTML = '';
  if (!total) {
    results.textContent = 'No results';
    clearSelection();
    setTimeout(() => { input.focus(); }, 50);
    return;
  }

  const fragment = document.createDocumentFragment();
  groups.forEach(group => {
    const header = document.createElement('div');
    header.className = 'fileHeader';
    header.textContent = group.file;
    fragment.appendChild(header);

    const ul = document.createElement('ul');
    group.entries.forEach(entry => {
      const li = document.createElement('li');
      li.className = 'result';
      li.dataset.id = String(entry.id);
      li.innerHTML = '<span class="line">' + (entry.line + 1) + '</span>' + entry.highlightedHtml;
      li.addEventListener('click', () => vscode.postMessage({ type: 'openAt', id: entry.id }));
      ul.appendChild(li);
    });
    fragment.appendChild(ul);
  });

  results.appendChild(fragment);
  flatIndexToId = flatIds;

  Prism.highlightAll();

  if (data.query) {
    var escapedQuery = escapeRegExp(data.query);
    var regex = new RegExp(escapedQuery, 'gi');

    document.querySelectorAll('code').forEach(function(codeEl) {
      var segments = [];
      var plainText = '';
      (function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          segments.push({ start: plainText.length, end: plainText.length + node.nodeValue.length, node: node });
          plainText += node.nodeValue;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          node.childNodes.forEach(walk);
        }
      })(codeEl);

      var matches = [];
      var m;
      while ((m = regex.exec(plainText)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length });
      }
      if (!matches.length) return;

      matches.reverse().forEach(function(match) {
        segments.forEach(function(seg) {
          if (seg.end <= match.start || seg.start >= match.end) return;
          var nodeMatchStart = Math.max(seg.start, match.start) - seg.start;
          var nodeMatchEnd = Math.min(seg.end, match.end) - seg.start;
          if (nodeMatchStart < nodeMatchEnd) {
            var text = seg.node.nodeValue;
            var before = text.slice(0, nodeMatchStart);
            var mid = text.slice(nodeMatchStart, nodeMatchEnd);
            var after = text.slice(nodeMatchEnd);

            var mark = document.createElement('mark');
            mark.textContent = mid;

            var frag = document.createDocumentFragment();
            if (before) frag.appendChild(document.createTextNode(before));
            frag.appendChild(mark);
            if (after) frag.appendChild(document.createTextNode(after));

            seg.node.parentNode.replaceChild(frag, seg.node);
            seg.node = mark.nextSibling || mark;
          }
        });
      });
    });
  }

  const first = document.querySelector('li.result');
  if (first) applySelection(0);
  else clearSelection();
  setTimeout(() => { input.focus(); }, 50);
}

let debounceTimer;
function debounce(fn, ms) {
  return function(...args) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), ms);
  };
}

const doSearch = () => {
  const query = input.value.trim();
  if (!query) {
    results.textContent = 'Type to search…';
    clearSelection();
    return;
  }
  results.textContent = 'Searching…';
  vscode.postMessage({ type: 'doSearch', query });
};

const cfgDebounce = 300; // UI-side fallback; real search debounce is handled by extension setting if needed
input.addEventListener('input', debounce(doSearch, cfgDebounce));
btn.addEventListener('click', doSearch);

input.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); if (selection >= 0) openSelected(); else doSearch(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); const all = document.querySelectorAll('li.result'); if (!all.length) return; if (selection < 0) applySelection(0); else applySelection(selection + 1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); const all = document.querySelectorAll('li.result'); if (!all.length) return; if (selection < 0) applySelection(0); else applySelection(selection - 1); }
  if (e.key === 'Escape') { e.preventDefault(); vscode.postMessage({ type: 'esc' }); }
});

// init + focus
window.addEventListener('message', event => {
  const handlers = {
    renderResults: () => renderResults(event.data.payload),
    init: () => {
      const q = (event.data.initialQuery || '').toString();
      if (q) { input.value = q; doSearch(); }
      setTimeout(() => { input.focus(); if (q) input.select(); }, 30);
    },
    focusSearch: () => { input.focus(); input.select(); }
  };
  const type = event?.data?.type;
  if (type && type in handlers) handlers[type]();
});
</script>
</body>
</html>`;
}

async function enrichWithContext(records: { uri: vscode.Uri; line: number; preview?: string }[]) {
  const fileContentCache = new Map<string, string>();
  for (const rec of records) {
    const path = rec.uri.fsPath;
    if (!fileContentCache.has(path)) {
      try {
        const doc = await vscode.workspace.openTextDocument(rec.uri);
        fileContentCache.set(path, doc.getText());
      } catch {
        fileContentCache.set(path, '');
      }
    }
    const text = fileContentCache.get(path) ?? '';
    rec.preview = getContextPreview(text, rec.line, 2, 2);
  }
  return records;
}

function getContextPreview(text: string, line: number, before = 2, after = 2) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - before);
  const end = Math.min(lines.length - 1, line + after);
  return lines.slice(start, end + 1).join('\n');
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&#39;';
      default: return m;
    }
  });
}

function detectLangFromFile(path: string): 'ts' | 'js' | 'json' {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'ts';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'js';
  if (path.endsWith('.json')) return 'json';
  return 'ts';
}

// strategy table for initial query (selection > word > clipboard)
async function pickInitialQuery(editor?: vscode.TextEditor): Promise<string> {
  const getSelection = () =>
    editor?.selections?.[0]?.isEmpty ? '' : (editor?.document.getText(editor.selection) ?? '');

  const v = (await getSelection()).trim();
  return v ? v.slice(0, 512) : '';
}


export function deactivate() { }
