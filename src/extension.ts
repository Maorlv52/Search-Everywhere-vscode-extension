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
        {
          enableScripts: true,
          retainContextWhenHidden: false, // reset chips/flags each open
        }
      );

      let lastResults: { uri: vscode.Uri; line: number }[] = [];
      panel.webview.html = getWebviewHtml();

      const editor = vscode.window.activeTextEditor;
      const initialQuery = await pickInitialQuery(editor);
      panel.webview.postMessage({ type: 'init', initialQuery });
      setTimeout(() => panel.webview.postMessage({ type: 'focusSearch' }), 40);

      panel.webview.onDidReceiveMessage(async (msg) => {
        const routes: Record<string, (m: any) => Promise<void>> = {
          async doSearch(m) {
            const queryRaw = (m.query ?? '').toString();
            const q = queryRaw.trim();
            const flags = (m.flags ?? {}) as { case?: boolean; regex?: boolean; word?: boolean };

            if (!q) {
              panel.webview.postMessage({
                type: 'renderResults',
                payload: { total: 0, groups: [], flatIds: [], query: q }
              });
              return;
            }

            // Build regex safely
            let source = flags.regex ? q : escapeRegExp(q);
            if (flags.word) source = `\\b${source}\\b`;

            const baseFlags = flags.case ? '' : 'i';
            let reTest: RegExp;
            try {
              reTest = new RegExp(source, baseFlags); // no 'g' for per-line testing
            } catch {
              panel.webview.postMessage({
                type: 'renderResults',
                payload: { total: 0, groups: [], flatIds: [], query: q, error: 'Invalid regex' }
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
                  const lines = doc.getText().split(/\r?\n/);
                  for (let i = 0; i < lines.length; i++) {
                    if (reTest.test(lines[i])) {
                      matches.push({ uri, line: i, preview: lines[i] });
                      if (matches.length >= 1000) break;
                    }
                  }
                  if (matches.length >= 1000) break;
                } catch {
                  // ignore file errors
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

                // No <mark> here; Prism first, then client-side marking
                const previewRaw = m.preview ?? '';
                const escapedPreview = escapeHtml(previewRaw);
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
                query: q
              }
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
          }
        };

        if (msg?.type && routes[msg.type]) await routes[msg.type](msg);
      });
    })
  );

  // ----- BIND CMD+SHIFT+F ASSISTANT -----
  const bindCmd = vscode.commands.registerCommand(COMMANDS.bindF, async () => {
    const snippet = JSON.stringify(
      [
        { "key": "cmd+shift+f", "command": "searchEverywhere.openCustomSearch", "when": "editorTextFocus || !editorIsOpen" },
        { "key": "cmd+shift+f", "command": "-workbench.action.findInFiles" }
      ],
      null, 2
    );

    await vscode.env.clipboard.writeText(snippet);

    const choice = await vscode.window.showInformationMessage(
      "Snippet to bind ⌘⇧F to Search Everywhere copied to your clipboard. Open keybindings.json and paste it.",
      "Open keybindings.json"
    );
    if (choice) await vscode.commands.executeCommand('workbench.action.openGlobalKeybindingsFile');
  });
  context.subscriptions.push(bindCmd);

  // Optional prompt (respects setting)
  const maybePromptTakeOver = async () => {
    const takeOver = vscode.workspace.getConfiguration().get<boolean>('searchEverywhere.takeOverCmdShiftF');
    if (!takeOver) return;
    const choice = await vscode.window.showInformationMessage(
      "Bind ⌘⇧F to Search Everywhere? (override default Find in Files)",
      "Bind Now", "Not Now"
    );
    const actions: Record<string, () => Thenable<void> | void> = {
      "Bind Now": () => vscode.commands.executeCommand(COMMANDS.bindF),
      "Not Now": () => {}
    };
    if (choice && actions[choice]) await actions[choice]();
  };
  maybePromptTakeOver();
}

function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Find in Files (Text Search)</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
<style>
:root{
  --bg:#1f232a; --bg-elev:#242933; --bg-elev-2:#2b3140; --text:#cfd6e4; --muted:#8b93a7;
  --accent:#61afef; --accent-2:#98c379; --mark-bg:#ffea00; --mark-fg:#000; --border:#343a46;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0; background:var(--bg); color:var(--text); font:13px/1.5 ui-sans-serif,system-ui,-apple-system,Inter,Segoe UI,Roboto,Arial;}
.app{display:grid; grid-template-rows:auto 1fr; height:100%}
.toolbar{position:sticky; top:0; z-index:10; background:linear-gradient(180deg,var(--bg-elev) 0%,rgba(0,0,0,0) 100%); padding:10px 12px 8px; border-bottom:1px solid var(--border); backdrop-filter:saturate(1.2) blur(6px);}
.row{display:flex; align-items:center; gap:8px}
.inputWrap{position:relative; flex:1; display:flex; align-items:center; background:#20252f; border:1px solid var(--border); border-radius:999px; padding:4px 8px}
input[type="text"]{flex:1; font-size:14px; color:var(--text); background:transparent; border:0; outline:0; padding:6px 6px}
.kbdHint{color:var(--muted); font-size:11.5px; margin-left:6px}
.btn{padding:6px 10px; border:1px solid var(--border); background:var(--accent); color:#fff; border-radius:10px; font-weight:600; cursor:pointer}
.btn:active{transform:translateY(1px)}
.chips{display:flex; gap:6px}
.chip{display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px; background:#2a3140; border:1px solid var(--border); cursor:pointer; user-select:none; font-size:12px}
.chip[data-active="true"]{background:var(--accent-2); color:#101318; border-color:transparent}
.chip .dot{width:7px; height:7px; border-radius:999px; background:currentColor; opacity:.5}
.meta{margin-left:auto; display:flex; align-items:center; gap:10px; color:var(--muted)}
.meta .badge{background:#222836; border:1px solid var(--border); border-radius:999px; padding:2px 8px; color:var(--text); font-size:12px}
.results{padding:10px 12px 24px}
.group{border:1px solid var(--border); border-radius:10px; background:#212735; margin:8px 0 12px; overflow:hidden}
.groupHeader{display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer; user-select:none; background:var(--bg-elev-2)}
.groupHeader:hover{filter:brightness(1.05)}
.groupHeader .chev{transition:transform .15s ease}
.groupHeader[data-collapsed="true"] .chev{transform:rotate(-90deg)}
.groupHeader .file{flex:1; font-weight:600}
.groupHeader .count{background:#222836; border:1px solid var(--border); border-radius:999px; padding:0 8px; font-size:12px}
ul.entries{list-style:none; margin:0; padding:0}
li.result{display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border-top:1px solid var(--border); cursor:pointer}
li.result:hover{background:rgba(255,255,255,0.03)}
li.result.selected{background:rgba(97,175,239,0.12); outline:1px solid rgba(97,175,239,.4)}
.line{width:56px; min-width:56px; text-align:right; color:var(--accent); font-variant-numeric:tabular-nums; padding-top:1px}
.preview{flex:1; white-space:pre-wrap; word-break:break-word; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace; font-size:12.5px}
mark{background-color:var(--mark-bg); color:var(--mark-fg); padding:0 2px; border-radius:3px}
.state{color:var(--muted); padding:20px 6px}
.small{font-size:11.5px; color:var(--muted)}
pre[class*="language-"], code[class*="language-"]{background:none !important; margin:0 !important; padding:0 !important; line-height:1.35 !important}
</style>
</head>
<body>
<div class="app">
  <div class="toolbar">
    <div class="row">
      <div class="inputWrap">
        <input id="searchInput" type="text" placeholder="Search text (case-insensitive)" autofocus />
        <span class="kbdHint small">↵ open · ↑/↓ navigate · esc close</span>
      </div>
      <div class="chips" id="chips" title="Case / Regex / Word"></div>
      <button class="btn" id="searchBtn">Search</button>
      <div class="meta">
        <span class="badge" id="counter">0 results</span>
        <span class="small" id="elapsed"></span>
      </div>
    </div>
  </div>

  <div class="results" id="results"><div class="state">Type to search…</div></div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-markup.min.js"></script>

<script>
const vscode = acquireVsCodeApi();

const el = {
  input: document.getElementById('searchInput'),
  btn: document.getElementById('searchBtn'),
  chips: document.getElementById('chips'),
  results: document.getElementById('results'),
  counter: document.getElementById('counter'),
  elapsed: document.getElementById('elapsed')
};

let flatIndexToId = [];
let selection = -1;
let currentFlags = { case: false, regex: false, word: false };

// chips (default OFF each open)
const toggles = [
  { key: 'case',  label: 'Case',  active: false },
  { key: 'regex', label: 'Regex', active: false },
  { key: 'word',  label: 'Word',  active: false },
];

const chipTpl = ({key,label,active}) => {
  const c = document.createElement('div');
  c.className = 'chip'; c.dataset.key = key; c.dataset.active = String(active);
  c.innerHTML = '<span class="dot"></span>'+label;
  c.addEventListener('click', () => c.dataset.active = String(!(c.dataset.active === 'true')));
  return c;
};
const renderChips = () => { el.chips.innerHTML = ''; toggles.map(chipTpl).forEach(c => el.chips.appendChild(c)); };
const getFlags = () => Object.fromEntries(Array.from(el.chips.children).map(c => [c.dataset.key, c.dataset.active === 'true']));

document.addEventListener('DOMContentLoaded', () => { setTimeout(() => { el.input.focus(); el.input.select(); }, 40); renderChips(); });

// utils
function escapeRegExp(str){return str.replace(/[.*+?^\\\\$\\{}()|[\\]\\\\]/g,'\\\\$&');}
function clearSelection(){ document.querySelectorAll('li.result.selected').forEach(n=>n.classList.remove('selected')); selection=-1; }
function applySelection(index){ const all=[...document.querySelectorAll('li.result')]; if(!all.length) return; selection=Math.max(0,Math.min(index,all.length-1)); all.forEach(n=>n.classList.remove('selected')); const sel=all[selection]; if(sel){ sel.classList.add('selected'); sel.scrollIntoView({block:'center', inline:'nearest', behavior:'smooth'}); } }
function openSelected(){ if(selection<0) return; const id=flatIndexToId[selection]; if(typeof id!=='number') return; vscode.postMessage({type:'openAt', id}); vscode.postMessage({type:'esc'}); }

const t0 = () => performance.now();
const fmtMs = (s,e) => (e-s).toFixed(0)+' ms';

// grouping
const toggleGroup = (wrap) => {
  const header = wrap.querySelector('.groupHeader');
  const entries = wrap.querySelector('.entries');
  const collapsed = header.dataset.collapsed === 'true';
  ({true:()=>{header.dataset.collapsed='false'; entries.style.display='';}, false:()=>{header.dataset.collapsed='true'; entries.style.display='none';}})[String(collapsed)]();
};
function makeGroup(group){
  const wrap=document.createElement('div'); wrap.className='group';
  const header=document.createElement('div'); header.className='groupHeader'; header.dataset.collapsed='false';
  header.innerHTML = \`<span class="chev">▾</span><span class="file">\${group.file}</span><span class="count">\${group.entries.length}</span>\`;
  header.addEventListener('click',()=>toggleGroup(wrap));
  const ul=document.createElement('ul'); ul.className='entries';
  group.entries.forEach(entry=>{ const li=document.createElement('li'); li.className='result'; li.dataset.id=String(entry.id); li.innerHTML='<span class="line">'+(entry.line+1)+'</span>'+entry.highlightedHtml; li.addEventListener('click',()=>vscode.postMessage({type:'openAt', id:entry.id})); ul.appendChild(li); });
  wrap.appendChild(header); wrap.appendChild(ul); return wrap;
}

// marking after Prism using flags
function markAfterPrism(query){
  const src = currentFlags.regex ? query : escapeRegExp(query);
  const wrapped = currentFlags.word ? '\\\\b'+src+'\\\\b' : src;
  const rx = new RegExp(wrapped, currentFlags.case ? 'g' : 'gi');

  document.querySelectorAll('code').forEach(codeEl => {
    const segments = []; let plainText = '';
    (function walk(node){
      if (node.nodeType === Node.TEXT_NODE) {
        segments.push({ start: plainText.length, end: plainText.length + node.nodeValue.length, node });
        plainText += node.nodeValue;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        node.childNodes.forEach(walk);
      }
    })(codeEl);

    const matches = []; let m;
    while ((m = rx.exec(plainText)) !== null) { matches.push({ start:m.index, end:m.index + m[0].length }); if (!rx.global) break; }
    if (!matches.length) return;

    matches.reverse().forEach(match => {
      segments.forEach(seg => {
        if (seg.end <= match.start || seg.start >= match.end) return;
        const nodeStart = Math.max(seg.start, match.start) - seg.start;
        const nodeEnd   = Math.min(seg.end, match.end) - seg.start;
        if (nodeStart < nodeEnd) {
          const text = seg.node.nodeValue;
          const before = text.slice(0, nodeStart);
          const mid    = text.slice(nodeStart, nodeEnd);
          const after  = text.slice(nodeEnd);

          const mark = document.createElement('mark');
          mark.textContent = mid;

          const f = document.createDocumentFragment();
          before && f.appendChild(document.createTextNode(before));
          f.appendChild(mark);
          after && f.appendChild(document.createTextNode(after));

          seg.node.parentNode.replaceChild(f, seg.node);
          seg.node = mark.nextSibling || mark;
        }
      });
    });
  });
}

// render
function renderResults(data){
  const started = t0();
  const { total, groups, flatIds, query, error } = data;
  el.results.innerHTML = '';
  flatIndexToId = flatIds || [];

  if (error){
    el.results.innerHTML = '<div class="state">Invalid regex</div>';
    el.counter.textContent = '0 results'; el.elapsed.textContent = ''; clearSelection(); return;
  }
  if (!total){
    el.results.innerHTML = '<div class="state">No results</div>';
    el.counter.textContent = '0 results'; el.elapsed.textContent = ''; clearSelection(); return;
  }

  const frag=document.createDocumentFragment();
  groups.forEach(g => frag.appendChild(makeGroup(g)));
  el.results.appendChild(frag);

  Prism.highlightAll();     // 1) tokenize
  markAfterPrism(query);    // 2) mark matches

  const first = document.querySelector('li.result');
  first ? applySelection(0) : clearSelection();

  el.counter.textContent = total + (total===1 ? ' result' : ' results');
  el.elapsed.textContent = fmtMs(started, performance.now());
  setTimeout(()=>{ el.input.focus(); }, 20);
}

// debounce + search
let debounceTimer; const debounce = (fn,ms)=>(...a)=>{ clearTimeout(debounceTimer); debounceTimer=setTimeout(()=>fn(...a),ms); };

const doSearch = () => {
  const q = el.input.value.trim();
  if (!q){ el.results.innerHTML='<div class="state">Type to search…</div>'; el.counter.textContent='0 results'; el.elapsed.textContent=''; clearSelection(); return; }
  el.results.innerHTML='<div class="state">Searching…</div>';
  currentFlags = getFlags(); // persist flags for marking step
  vscode.postMessage({ type:'doSearch', query:q, flags: currentFlags });
};

el.input.addEventListener('input', debounce(doSearch, 300));
el.btn.addEventListener('click', doSearch);

el.input.addEventListener('keydown', e => {
  const handlers = {
    'Enter': () => selection >= 0 ? openSelected() : doSearch(),
    'ArrowDown': () => { const all=document.querySelectorAll('li.result'); if(!all.length) return; selection<0 ? applySelection(0) : applySelection(selection+1); },
    'ArrowUp': () => { const all=document.querySelectorAll('li.result'); if(!all.length) return; selection<0 ? applySelection(0) : applySelection(selection-1); },
    'Escape': () => vscode.postMessage({ type:'esc' })
  };
  const fn = handlers[e.key]; if(fn){ e.preventDefault(); fn(); }
});

// messages (reset chips each open)
window.addEventListener('message', event => {
  const table = {
    renderResults: () => renderResults(event.data.payload),
    init: () => {
      renderChips(); // reset OFF
      const q = (event.data.initialQuery || '').toString();
      if (q){ el.input.value = q; doSearch(); }
      setTimeout(() => { el.input.focus(); q && el.input.select(); }, 20);
    },
    focusSearch: () => { el.input.focus(); el.input.select(); }
  };
  const { type } = event.data || {};
  type && table[type]?.();
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

// selection only
async function pickInitialQuery(editor?: vscode.TextEditor): Promise<string> {
  const getSelection = () => editor?.selections?.[0]?.isEmpty ? '' : (editor?.document.getText(editor.selection) ?? '');
  const v = (await getSelection()).trim();
  return v ? v.slice(0, 512) : '';
}

export function deactivate() {}
