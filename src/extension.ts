import * as vscode from 'vscode';

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMMANDS = {
  open: 'searchEverywhere.openCustomSearch',
  bindF: 'searchEverywhere.bindCmdShiftF',
} as const;

type Scope = 'workspace' | 'open' | 'current' | 'node_modules';


// ---- fast search globals ----
let currentSearchCts: vscode.CancellationTokenSource | undefined;
let searchSeq = 0; // 🆕 monotonically increasing id per search
let searchPanel: vscode.WebviewPanel | undefined;
let lastQuery = '';
let lastFlags: { case?: boolean; regex?: boolean; word?: boolean } = {};
let lastScope: Scope = 'workspace';
const MAX_RESULTS = 500;
const MAX_FILE_BYTES = 2_000_000;        // skip giant files (> ~2MB)
const decoder = new TextDecoder('utf-8'); // reuse across files
const EXT_GLOB = '*.{ts,js,json,tsx,jsx,html,css,scss,md,txt}';
const SCAN_CONCURRENCY = 16;
const NODE_EXT_GLOB = '*.{ts,tsx,js,jsx}';
const NODE_EXCLUDE = '{**/node_modules/**/{dist,build,out,.bin,coverage,docs,examples}/**,**/*.min.* ,**/*.map,**/*.d.ts}';

const hasFindTextInFiles = (): boolean =>
  typeof (vscode.workspace as any).findTextInFiles === 'function';


async function tryFindInFilesBuiltin(
  scope: Scope,
  q: string,
  flags: { case?: boolean; regex?: boolean; word?: boolean },
  limit = MAX_RESULTS,
  token?: vscode.CancellationToken
): Promise<{ uri: vscode.Uri; line: number; preview?: string }[]> {
  const fn = (vscode.workspace as any).findTextInFiles;
  if (typeof fn !== 'function') throw new Error('builtin search not available');

  const results: { uri: vscode.Uri; line: number; preview?: string }[] = [];

  const query = {
    pattern: q,
    isRegExp: !!flags.regex,
    isCaseSensitive: !!flags.case,
    isWordMatch: !!flags.word,
  };

  const include =
    scope === 'node_modules'
      ? `**/node_modules/**/${EXT_GLOB}`
      : `**/${EXT_GLOB}`;

  const exclude =
    scope === 'workspace'
      ? '**/{node_modules,.git,dist,build,out}/**'
      : undefined;

  const options = {
    include,
    exclude,
    useIgnoreFiles: true,
    useGlobalIgnoreFiles: true,
    useDefaultExcludes: true,
    maxResults: limit,
  };

  const ret = fn(
    query as any,
    options as any,
    (res: any) => {
      const r = Array.isArray(res.ranges) ? res.ranges[0] : res.ranges;
      const line = Number(r?.start?.line ?? 0);
      results.push({ uri: res.uri, line });
      if (results.length >= limit) {
        try { token?.isCancellationRequested || currentSearchCts?.cancel(); } catch { }
      }
    },
    token
  );

  // חשוב: אם אין then → נופלים לפאלבק
  if (!ret || typeof ret.then !== 'function') {
    throw new Error('builtin search returned non-thenable');
  }

  await ret; // לחכות לסיום החיפוש
  return results;
}



/* tiny, isolated scope helper */
async function getUrisByScope(scope: Scope): Promise<vscode.Uri[]> {
  const strategies: Record<Scope, () => Promise<vscode.Uri[]>> = {
    async workspace() {
      // מוחרג node_modules כמו היום
      const includePattern = `**/${EXT_GLOB}`;
      const excludePattern = '**/{node_modules,.git,dist,build,out}/**';
      return vscode.workspace.findFiles(includePattern, excludePattern, 20000);
    },
    async open() {
      const fromEditors = vscode.window.visibleTextEditors
        .map(e => e.document?.uri)
        .filter(Boolean) as vscode.Uri[];
      const fromDocs = vscode.workspace.textDocuments
        .filter(d => d.uri.scheme === 'file')
        .map(d => d.uri);
      const set = new Map<string, vscode.Uri>();
      [...fromEditors, ...fromDocs].forEach(u => set.set(u.fsPath, u));
      return [...set.values()];
    },
    async current() {
      const u = vscode.window.activeTextEditor?.document?.uri;
      return u ? [u] : [];
    },
    async node_modules() {
      const includePattern = '**/node_modules/**/*.{ts,tsx,js,jsx}';
      return vscode.workspace.findFiles(includePattern, undefined, 50000);
    }


  };
  return strategies[scope]();
}



/* -------- fast FS scanner (no findTextInFiles) -------- */
type Match = { uri: vscode.Uri; line: number; preview?: string };

function buildSource(q: string, flags: { case?: boolean; regex?: boolean; word?: boolean }) {
  const src = flags.regex ? q : escapeRegExp(q);
  return flags.word ? `\\b${src}\\b` : src;
}

function makeLineTester(source: string, flags: { case?: boolean }) {
  const baseFlags = flags.case ? '' : 'i';
  try {
    return new RegExp(source, baseFlags); // per-line test – no 'g'
  } catch {
    return null;
  }
}

const YIELD_EVERY_MS = 25;
const PER_FILE_LIMIT_NODE = 5;           // כמה התאמות מקס' מכל קובץ בתוך node_modules
const MAX_FILE_BYTES_NODE = 600_000;     // קבצים גדולים במיוחד ב-node_modules – לדלג

function isInNodeModulesPath(p: string) {
  return /(^|[\\/])node_modules([\\/]|$)/i.test(p);
}

function slicePreview(lines: string[], hitLine: number, before = 2, after = 2) {
  const start = Math.max(0, hitLine - before);
  const end = Math.min(lines.length - 1, hitLine + after);
  return lines.slice(start, end + 1).join('\n');
}

async function scanFilesFs(
  uris: vscode.Uri[],
  q: string,
  flags: { case?: boolean; regex?: boolean; word?: boolean },
  limit = MAX_RESULTS,
  token?: vscode.CancellationToken,
  onProgress?: (matchesCount: number, filesWithHits: number) => void, // ← NEW
): Promise<Match[]> {
  const matches: Match[] = [];
  const seenFiles = new Set<string>(); // how many files produced at least one hit

  const source = buildSource(q, flags);
  const reTest = makeLineTester(source, flags);
  if (!reTest) return matches;

  let index = 0;

  const worker = async () => {
    let lastYield = Date.now();

    while (true) {
      if (token?.isCancellationRequested) return;
      if (matches.length >= limit) { currentSearchCts?.cancel(); return; }

      const i = index++;
      if (i >= uris.length) return;

      const uri = uris[i];
      const inNode = isInNodeModulesPath(uri.fsPath);

      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const size = (stat as any).size as number | undefined;
        if (typeof size === 'number') {
          const maxSize = inNode ? MAX_FILE_BYTES_NODE : MAX_FILE_BYTES;
          if (size > maxSize) continue;
        }

        // 🔸 cheap path filters for node_modules noise
        if (inNode) {
          const p = uri.fsPath;
          // heavy build dirs
          if (/[\\/](dist|build|out|\.bin|coverage|docs|examples)[\\/]/i.test(p)) continue;
          // files that rarely help
          if (/\.d\.ts$/i.test(p) || /\.map$/i.test(p)) continue;
        }

        const raw = await vscode.workspace.fs.readFile(uri);
        const text = decoder.decode(raw);

        // 🔹 ultra-cheap prefilter for non-regex searches
        if (!flags.regex) {
          const needle = flags.case ? q : q.toLowerCase();
          const hay = flags.case ? text : text.toLowerCase();
          if (!hay.includes(needle)) {
            if (Date.now() - lastYield > YIELD_EVERY_MS) {
              await new Promise(r => setTimeout(r, 0));
              lastYield = Date.now();
            }
            continue;
          }
        }

        const lines = text.split(/\r?\n/);
        let perFileHits = 0;
        const perFileCap = inNode ? PER_FILE_LIMIT_NODE : Number.POSITIVE_INFINITY;
        let fileCounted = false;

        for (let line = 0; line < lines.length; line++) {
          if (token?.isCancellationRequested) return;

          if (reTest.test(lines[line])) {
            matches.push({
              uri,
              line,
              // build preview now to avoid re-opening later
              preview: slicePreview(lines, line, 2, 2),
            });

            if (!fileCounted) {
              seenFiles.add(uri.fsPath);
              fileCounted = true;
            }

            // notify progress (caller throttles if needed)
            onProgress?.(matches.length, seenFiles.size);

            perFileHits++;
            if (matches.length >= limit) { currentSearchCts?.cancel(); return; }
            if (perFileHits >= perFileCap) break; // enough from this file
          }

          // small yield to keep UI responsive
          if (Date.now() - lastYield > YIELD_EVERY_MS) {
            await new Promise(r => setTimeout(r, 0));
            lastYield = Date.now();
          }
        }
      } catch {
        // ignore IO/permission errors
      }
    }
  };

  const runners = Array.from(
    { length: Math.min(SCAN_CONCURRENCY, uris.length) },
    () => worker()
  );
  await Promise.allSettled(runners);

  return matches;
}




// NEW: Singleton handle מחוץ לפונקציה
export function activate(context: vscode.ExtensionContext) {
  // ----- OPEN CUSTOM SEARCH -----
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.open, async () => {
      // 👇 אם כבר פתוח — רק לחשוף ולפקס
      const editor = vscode.window.activeTextEditor;
      const initialQuery = await pickInitialQuery(editor);

      if (searchPanel) {
        searchPanel.reveal(undefined, false);
        setTimeout(() => searchPanel!.webview.postMessage({ type: 'focusSearch', initialQuery }), 40);
        return;
      }

      const column = editor?.viewColumn ?? vscode.ViewColumn.One;


      // 👇 אחרת — ליצור פעם אחת ולשמור את המופע הגלובלי
      const panel = vscode.window.createWebviewPanel(
        'searchEverywhereCustom',
        'Find in Files (Text Search)',
        { viewColumn: column, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );
      searchPanel = panel;
      panel.onDidDispose(() => (searchPanel = undefined));

      await vscode.commands.executeCommand('workbench.action.pinEditor');

      let lastResults: { uri: vscode.Uri; line: number }[] = [];
      panel.webview.html = getWebviewHtml();

      console.log('[SearchEverywhere] sending initialQuery:', initialQuery);
      panel.webview.postMessage({ type: 'init', initialQuery });
      setTimeout(() => panel.webview.postMessage({ type: 'focusSearch' }), 40);



      panel.webview.onDidReceiveMessage(async (msg) => {
        const routes: Record<string, (m: any) => Promise<void>> = {
          async doSearch(m) {
            const queryRaw = (m.query ?? '').toString();
            const q = queryRaw.trim();
            const flags = (m.flags ?? {}) as { case?: boolean; regex?: boolean; word?: boolean };
            const scope = ((m.scope as Scope) || lastScope || 'workspace') as Scope;

            lastQuery = q;
            lastFlags = flags;
            lastScope = scope;

            if (!q) {
              const seq = ++searchSeq; // still advance so UI ignores older payloads
              panel.webview.postMessage({
                type: 'renderResults',
                payload: { total: 0, groups: [], flatIds: [], query: q, elapsed: 0, files: 0, seq }
              });
              return;
            }

            const seq = ++searchSeq;                  // id for this search
            const tStart = Date.now();

            // throttle helper for progress messages
            const throttle = <A extends any[]>(fn: (...a: A) => void, ms: number) => {
              let last = 0;
              return (...a: A) => {
                const now = Date.now();
                if (now - last >= ms) { last = now; fn(...a); }
              };
            };
            const reportProgress = throttle((matchesCount: number, filesWithHits: number) => {
              panel.webview.postMessage({
                type: 'progress',
                payload: { seq, matches: matchesCount, files: filesWithHits, elapsed: Date.now() - tStart }
              });
            }, 150);

            // Build regex safely (also used for open/current path)
            let source = flags.regex ? q : escapeRegExp(q);
            if (flags.word) source = `\\b${source}\\b`;
            const baseFlags = flags.case ? '' : 'i';
            let reTest: RegExp;
            try {
              reTest = new RegExp(source, baseFlags); // no 'g'
            } catch {
              panel.webview.postMessage({
                type: 'renderResults',
                payload: { total: 0, groups: [], flatIds: [], query: q, error: 'Invalid regex', seq }
              });
              return;
            }

            // cancel previous search
            currentSearchCts?.cancel();
            currentSearchCts = new vscode.CancellationTokenSource();
            const { token } = currentSearchCts;

            let matches: Match[] = []; // { uri, line, preview? }

            try {
              const uris = await getUrisByScope(scope);

              // Try VS Code builtin (ripgrep); fall back to our FS scanner
              const tryBuiltin = async (): Promise<Match[]> => {
                const fn = (vscode.workspace as any).findTextInFiles;
                if (typeof fn !== 'function') throw new Error('builtin unavailable');

                const results: Match[] = [];
                const seenFiles = new Set<string>();

                const query = {
                  pattern: q,
                  isRegExp: !!flags.regex,
                  isCaseSensitive: !!flags.case,
                  isWordMatch: !!flags.word,
                };

                const include =
                  scope === 'node_modules'
                    ? `**/node_modules/**/${EXT_GLOB}`
                    : `**/${EXT_GLOB}`;

                const exclude =
                  scope === 'workspace'
                    ? '**/{node_modules,.git,dist,build,out}/**'
                    : undefined;

                const options = {
                  include,
                  exclude,
                  useIgnoreFiles: true,
                  useGlobalIgnoreFiles: true,
                  useDefaultExcludes: true,
                  maxResults: MAX_RESULTS,
                };

                const ret = fn(
                  query as any,
                  options as any,
                  (res: any) => {
                    const r = Array.isArray(res.ranges) ? res.ranges[0] : res.ranges;
                    const line = Number(r?.start?.line ?? 0);
                    results.push({ uri: res.uri, line });

                    const p = res.uri?.fsPath ?? '';
                    if (p && !seenFiles.has(p)) seenFiles.add(p);

                    reportProgress(results.length, seenFiles.size);

                    if (results.length >= MAX_RESULTS) {
                      try { token?.isCancellationRequested || currentSearchCts?.cancel(); } catch { }
                    }
                  },
                  token
                );

                if (!ret || typeof ret.then !== 'function') {
                  throw new Error('builtin returned non-thenable');
                }
                await ret;
                return results;
              };

              if (scope === 'workspace' || scope === 'node_modules') {
                try {
                  matches = await tryBuiltin();
                } catch {
                  // NOTE: scanFilesFs should accept the optional 6th arg (progress cb)
                  // signature: (uris, q, flags, limit, token, onProgress?)
                  matches = await scanFilesFs(uris, q, flags, MAX_RESULTS, token, reportProgress);
                }
              } else {
                // open/current — per-line via openTextDocument (also emit progress)
                const seenFiles = new Set<string>();
                outer: for (const uri of uris) {
                  if (token.isCancellationRequested) break;
                  try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const lines = doc.getText().split(/\r?\n/);
                    let hadHitInThisFile = false;
                    for (let i = 0; i < lines.length; i++) {
                      if (token.isCancellationRequested) break outer;
                      if (reTest.test(lines[i])) {
                        matches.push({ uri, line: i });
                        if (!hadHitInThisFile) {
                          hadHitInThisFile = true;
                          seenFiles.add(uri.fsPath);
                        }
                        reportProgress(matches.length, seenFiles.size);
                        if (matches.length >= MAX_RESULTS) break outer;
                      }
                    }
                  } catch { /* ignore */ }
                }
              }
            } catch (e) {
              console.error('search error', e);
            } finally {
              currentSearchCts = undefined;
            }

            await enrichWithContext(matches);
            lastResults = matches;

            // group + HTML
            const groupsMap = new Map<
              string,
              { file: string; entries: { id: number; line: number; highlightedHtml: string }[] }
            >();
            const flatIds: number[] = [];

            await Promise.all(
              matches.map(async (m: Match, i: number) => {
                const wsFolder = vscode.workspace.getWorkspaceFolder(m.uri);
                const fileName = wsFolder
                  ? m.uri.fsPath.replace(wsFolder.uri.fsPath + '/', '')
                  : m.uri.fsPath;

                const group =
                  groupsMap.get(fileName) ??
                  { file: fileName, entries: [] as { id: number; line: number; highlightedHtml: string }[] };

                const lang = detectLangFromFile(fileName);
                const previewRaw = (m.preview ?? '').replace(/\r\n?/g, '\n');
                const escapedPreview = escapeHtml(previewRaw);
                const prismWrapped =
                  '<pre class="preview"><code class="language-' + lang + '">' + escapedPreview + '</code></pre>';

                group.entries.push({ id: i, line: m.line, highlightedHtml: prismWrapped });
                groupsMap.set(fileName, group);
                flatIds.push(i);
              })
            );

            const elapsed = Date.now() - tStart;
            const fileCount = new Set(matches.map(m => m.uri.fsPath)).size;

            panel.webview.postMessage({
              type: 'renderResults',
              payload: {
                total: matches.length,
                groups: Array.from(groupsMap.values()),
                flatIds,
                query: q,
                elapsed,
                files: fileCount,
                seq,
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

          async scopeChanged(m) {
            const nextScope = (m.scope as Scope) || 'workspace';
            lastScope = nextScope; // מעדכן לזכור את ההחלפה
            if (!lastQuery.trim()) {
              panel.webview.postMessage({ type: 'scopeSet', scope: lastScope });
              setTimeout(() => panel.webview.postMessage({ type: 'focusSearch' }), 10);
              return;
            }
            try { currentSearchCts?.cancel(); } catch { }
            await routes.doSearch({ query: lastQuery, flags: lastFlags, scope: lastScope });
          },

          async flagsChanged(m) {
            const next = (m.flags ?? {}) as { case?: boolean; regex?: boolean; word?: boolean };

            lastFlags = {
              case: !!next.case,
              regex: !!next.regex,
              word: !!next.word,
            };

            if (!lastQuery.trim()) {
              panel.webview.postMessage({ type: 'flagsSet', flags: lastFlags });
              return;
            }

            try { currentSearchCts?.cancel(); } catch { }
            await routes.doSearch({ query: lastQuery, flags: lastFlags, scope: lastScope });
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
      "Not Now": () => { }
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

/* base */
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0; background:var(--bg); color:var(--text); font:13px/1.5 ui-sans-serif,system-ui,-apple-system,Inter,Segoe UI,Roboto,Arial;}
.app{display:grid; grid-template-rows:auto 1fr; height:100%}

/* toolbar container (keeps toolbar nice and compact) */
.container{max-width: 1040px; margin: 0 auto; padding: 0 12px; width: 100%;}
/* WIDER results container (so result panes are wider than the toolbar) */
.containerWide{max-width: 1440px; margin: 0 auto; padding: 0 12px; width: 100%;}

/* toolbar */
.toolbar{
  position:sticky; top:0; z-index:10;
  background:linear-gradient(180deg,var(--bg-elev) 0%,rgba(0,0,0,0) 100%);
  border-bottom:1px solid var(--border);
  backdrop-filter:saturate(1.2) blur(6px);
  will-change: transform;
  transform: translateZ(0);
  overflow: visible;
}
.toolbarInner{display:flex; align-items:center; gap:10px; padding:10px 0; flex-wrap: wrap;}

/* input */
.inputWrap{
  position:relative;
  display:flex; align-items:center;
  background:#20252f; border:1px solid var(--border); border-radius:999px; padding:4px 8px;
  flex: 1 1 520px;
  min-width: 260px;
  max-width: 720px;
}
input[type="text"]{flex:1; font-size:14px; color:var(--text); background:transparent; border:0; outline:0; padding:6px 6px}
.kbdHint{color:var(--muted); font-size:11.5px; margin-left:6px; white-space:nowrap}

.btn{padding:6px 10px; border:1px solid var(--border); background:var(--accent); color:#fff; border-radius:10px; font-weight:600; cursor:pointer; flex:0 0 auto}
.btn:active{transform:translateY(1px)}

/* keep original chips (hidden) */
.chips{display:none}

/* compact dropdown/selects that don't grow */
.select{position:relative; flex:0 0 auto}
.select > select{
  appearance:none; background:#2a3140; border:1px solid var(--border); color:var(--text);
  border-radius:10px; padding:6px 28px 6px 10px; font-size:12px; cursor:pointer; white-space:nowrap
}
.select:after{
  content:'▾'; position:absolute; right:8px; top:50%; transform:translateY(-50%); font-size:11px; color:var(--muted);
}

/* Flags dropdown */
details.menu{position:relative; flex:0 0 auto}
summary.menuBtn{
  list-style:none; padding:6px 10px; border:1px solid var(--border); background:#2a3140; color:var(--text);
  border-radius:10px; font-size:12px; cursor:pointer; user-select:none; white-space:nowrap
}
summary.menuBtn::-webkit-details-marker{display:none}
details[open] .menuBtn{filter:brightness(1.05)}
.menuList{
  position:absolute; top:calc(100% + 6px); right:0; min-width:160px;
  background:#212735; border:1px solid var(--border); border-radius:10px; padding:6px; box-shadow:0 6px 24px rgba(0,0,0,.35);
  will-change: transform;
  transform: translateZ(0);
  z-index: 1000;
}
.menuItem{display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px; cursor:pointer; font-size:12px}
.menuItem:hover{background:rgba(255,255,255,0.04)}
.menuItem input{margin:0}

/* small meta badges */
.meta{margin-left:auto; display:flex; align-items:center; gap:10px; color:var(--muted); flex:0 0 auto}
.meta .badge{background:#222836; border:1px solid var(--border); border-radius:999px; padding:2px 8px; color:#fff; font-size:12px}

/* results */
.results{padding:10px 0 24px; overflow-y:auto}
.group{border:1px solid var(--border); border-radius:10px; background:#212735; margin:8px 0 12px; overflow:hidden}
.groupHeader{display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer; user-select:none; background:var(--bg-elev-2)}
.groupHeader:hover{filter:brightness(1.05)}
.groupHeader .chev{transition:transform .15s ease}
.groupHeader[data-collapsed="true"] .chev{transform:rotate(-90deg)}
.groupHeader .file{flex:1; font-weight:600; min-width:0}
.groupHeader .count{background:#222836; border:1px solid var(--border); border-radius:999px; padding:0 8px; font-size:12px}
ul.entries{list-style:none; margin:0; padding:0}
li.result{display:flex; gap:10px; align-items:flex-start; padding:12px 14px; border-top:1px solid var(--border); cursor:pointer}
li.result:hover{background:rgba(255,255,255,0.03)}
li.result.selected{background:rgba(97,175,239,0.12); outline:1px solid rgba(97,175,239,.4)}
.line{width:56px; min-width:56px; text-align:right; color:var(--accent); font-variant-numeric:tabular-nums; padding-top:1px}

/* keep exact whitespace for code previews */
.preview{
  flex:1;
  white-space: pre;          /* newlines + indentation preserved */
  word-break: normal;
  overflow-wrap: normal;
  font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
  font-size:12.5px;
  max-width: 100%;
}
mark{background-color:var(--mark-bg); color:var(--mark-fg); padding:0 2px; border-radius:3px}
.state{color:var(--muted); padding:20px 6px}
.small{font-size:11.5px; color:var(--muted)}
pre[class*="language-"],
code[class*="language-"]{
  background:none !important;
  margin:0 !important;
  padding:0 !important;
  line-height:1.35 !important;

  /* Force exact whitespace even if Prism/token styles interfere */
  white-space: pre !important;     /* was: inherit */
  overflow-wrap: normal !important;
  word-break: normal !important;
}

</style>
</head>
<body>
<div class="app">
  <div class="toolbar">
    <div class="container">
      <div class="toolbarInner">
        <div class="inputWrap">
          <input id="searchInput" type="text" placeholder="Search text (case-insensitive)" autofocus />
          <span class="kbdHint small">↵ open · ↑/↓ navigate · esc close</span>
        </div>

        <!-- Flags dropdown -->
        <details class="menu" id="flagsMenu">
          <summary class="menuBtn">Flags ▾</summary>
          <div class="menuList" role="menu">
            <label class="menuItem"><input type="checkbox" id="flagCase" /> Case</label>
            <label class="menuItem"><input type="checkbox" id="flagRegex" /> Regex</label>
            <label class="menuItem"><input type="checkbox" id="flagWord" /> Word</label>
          </div>
        </details>

        <!-- Scope select -->
        <div class="select">
          <select id="scopeSelect" title="Search in">
            <option value="workspace" selected>Workspace</option>
            <option value="open">Open files</option>
            <option value="current">Current file</option>
            <option value="node_modules">node_modules only</option>
          </select>
        </div>

        <!-- keep chips (hidden) so old logic never breaks -->
        <div class="chips" id="chips" title="Case / Regex / Word"></div>

        <button class="btn" id="searchBtn">Search</button>

        <div class="meta">
          <span class="badge" id="counter">0 results</span>
          <span class="small" id="elapsed"></span>
        </div>
      </div>
    </div>
  </div>

  <div class="results">
    <div class="containerWide">
      <div id="results"><div class="state">Type to search…</div></div>
    </div>
  </div>
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
  elapsed: document.getElementById('elapsed'),
  flagsMenu: document.getElementById('flagsMenu'),
  flagCase: document.getElementById('flagCase'),
  flagRegex: document.getElementById('flagRegex'),
  flagWord: document.getElementById('flagWord'),
  scopeSelect: document.getElementById('scopeSelect'),
};

let flatIndexToId = [];
let selection = -1;
let currentFlags = { case: false, regex: false, word: false };
let latestSeq = 0; // 🆕 ignore out-of-order results

/* ---- original chips logic kept (hidden) ---- */
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

/* unified getter: prefer dropdown flags, fallback to chips */
const getFlags = () => {
  if (el.flagCase && el.flagRegex && el.flagWord) {
    return {
      case: !!el.flagCase.checked,
      regex: !!el.flagRegex.checked,
      word: !!el.flagWord.checked
    };
  }
  return Object.fromEntries(
    Array.from(el.chips.children).map(c => [c.dataset.key, c.dataset.active === 'true'])
  );
};



const getScope = () => (el.scopeSelect && el.scopeSelect.value) ? el.scopeSelect.value : 'workspace';

const isFlagsOpen = () =>
  !!(el.flagsMenu && 'open' in el.flagsMenu && el.flagsMenu.open);

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => { el.input.focus(); el.input.select(); }, 40);
  renderChips(); // safe: chips exist but hidden
  // defaults each open for dropdowns
  if (el.flagCase) { el.flagCase.checked = false; }
  if (el.flagRegex) { el.flagRegex.checked = false; }
  if (el.flagWord) { el.flagWord.checked = false; }
  if (el.scopeSelect) { el.scopeSelect.value = 'workspace'; }
});

// rerun immediately when scope changes (no need to touch the input)
el.scopeSelect?.addEventListener('change', () => {
  const scope = getScope();
  showSearching();                       // optimistic UI
  vscode.postMessage({ type: 'scopeChanged', scope });

  const fm = el.flagsMenu;
  if (fm && 'open' in fm) fm.open = false;  // optional: close flags dropdown
});

[el.flagCase, el.flagRegex, el.flagWord].forEach(cb => {
  cb?.addEventListener('change', onFlagChange);
});

function showSearching(){
  el.results.innerHTML = '<div class="state">Searching…</div>';
  el.counter.textContent = '…';
  el.elapsed.textContent = '';
}

function onFlagChange() {
  currentFlags = getFlags();   
  vscode.postMessage({         
    type: 'flagsChanged',
    flags: currentFlags
  });
}

// utils
function escapeRegExp(str){return str.replace(/[.*+?^\\$\\{}()|[\\]\\\\]/g,'\\\\$&');}
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
  // 🆕 Ignore stale searches
  var hasSeq = typeof data.seq === 'number';
  if (hasSeq) {
    if (data.seq < latestSeq) return; // older payload, drop it
    latestSeq = data.seq;             // record newest
  }

  const started = t0();
  const total   = data.total;
  const groups  = data.groups;
  const flatIds = data.flatIds;
  const query   = data.query;
  const error   = data.error;
  const elapsed = data.elapsed; // ms from extension
  const files   = data.files;   // file count from extension

  el.results.innerHTML = '';
  flatIndexToId = flatIds || [];

  if (error){
    el.results.innerHTML = '<div class="state">Invalid regex</div>';
    el.counter.textContent = '0 results';
    el.elapsed.textContent = (typeof elapsed === 'number') ? (elapsed + ' ms') : '';
    clearSelection();
    return;
  }
  if (!total){
    el.results.innerHTML = '<div class="state">No results</div>';
    el.counter.textContent = '0 results' + (typeof files === 'number' ? (' · ' + files + ' files') : '');
    el.elapsed.textContent = (typeof elapsed === 'number') ? (elapsed + ' ms') : '';
    clearSelection();
    return;
  }

  const frag = document.createDocumentFragment();
  groups.forEach(function(g){ frag.appendChild(makeGroup(g)); });
  el.results.replaceChildren(frag);

  Prism.highlightAll();
markAfterPrism(query);

// avoid scroll/focus jank while Flags menu is open
const first = document.querySelector('li.result');
const fmOpen = isFlagsOpen();

if (first && !fmOpen) {
  applySelection(0);            // scroll only when flags menu is closed
} else if (!first) {
  clearSelection();
}

// --- robust header computation (payload OR DOM fallback) ---
const isNum = v => typeof v === 'number' && isFinite(v);

// Count matches from payload OR from DOM (safe fallback)
const domMatchCount = () => document.querySelectorAll('li.result').length;

// Count unique files from payload groups OR from DOM (safer than groups.length if payload missing)
const domFileCount = () => {
  const files = new Set();
  document.querySelectorAll('.groupHeader .file').forEach(el => files.add(el.textContent || ''));
  return files.size;
};

const totalMatches = isNum(total) ? total : domMatchCount();
const fileCount    = isNum(files) ? files : domFileCount();
const elapsedText  = isNum(elapsed) ? (elapsed + ' ms') : fmtMs(started, performance.now());

el.counter.textContent =
  totalMatches + (totalMatches === 1 ? ' result' : ' results') +
  ' · ' +
  fileCount + (fileCount === 1 ? ' file' : ' files');

el.elapsed.textContent = elapsedText;

// don't steal focus from the checkbox while flags are open
setTimeout(() => { if (!fmOpen) { el.input.focus(); } }, 20);
}

// debounce + search
let debounceTimer; const debounce = (fn,ms)=>(...a)=>{ clearTimeout(debounceTimer); debounceTimer=setTimeout(()=>fn(...a),ms); };

const doSearch = () => {
  const q = el.input.value.trim();
  if (!q){
    el.results.innerHTML = '<div class="state">Type to search…</div>';
    el.counter.textContent = '0 results';
    el.elapsed.textContent = '';
    clearSelection();
    return;
  }
  el.results.innerHTML = '<div class="state">Searching…</div>';

  // 🔹 clear header for the new search immediately
  el.counter.textContent = '…';
  el.elapsed.textContent = '';

  currentFlags = getFlags(); // persist flags for marking step
  vscode.postMessage({ type:'doSearch', query:q, flags: currentFlags, scope: getScope() });
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

// messages (reset controls each open)
window.addEventListener('message', event => {
  const table = {
    renderResults: () => renderResults(event.data.payload),
    init: () => {
      renderChips();
      if (el.flagCase) el.flagCase.checked = false;
      if (el.flagRegex) el.flagRegex.checked = false;
      if (el.flagWord) el.flagWord.checked = false;
      if (el.scopeSelect) el.scopeSelect.value = 'workspace';

      const q = (event.data.initialQuery || '').toString();
      console.log('[SearchEverywhere:webview] got initialQuery:', q);


      // always set input, even if empty
      el.input.value = q;

      if (q) doSearch();

      setTimeout(() => {
        el.input.focus();
        if (q) el.input.select();
      }, 40);
    },
focusSearch: () => {
  el.input.focus();
  if (el.input.value) el.input.select();
},
       
scopeSet: () => {
      if (el.scopeSelect) el.scopeSelect.value = (event.data.scope || 'workspace');
    },
     flagsSet: () => {
      const f = event.data.flags || {};
      if (el.flagCase)  el.flagCase.checked  = !!f.case;
      if (el.flagRegex) el.flagRegex.checked = !!f.regex;
      if (el.flagWord)  el.flagWord.checked  = !!f.word;
      currentFlags = getFlags();
    },
    progress: () => {
      const { matches, files, elapsed } = event.data.payload || {};
      el.counter.textContent =
      (Number(matches) || 0) + ' results · ' + (Number(files) || 0) + ' files';
      if (typeof elapsed === 'number') el.elapsed.textContent = elapsed + ' ms';
},

  };
  const { type } = event.data || {};
  type && table[type]?.();
});
</script>
</body>
</html>`;
}



async function enrichWithContext(records: { uri: vscode.Uri; line: number; preview?: string }[]) {
  // אם כבר יש preview מהסריקה – לא עושים כלום
  const need = records.filter(r => !r.preview);
  if (need.length === 0) return records;

  const cache = new Map<string, string>(); // fsPath -> text
  for (const rec of need) {
    const p = rec.uri.fsPath;
    if (!cache.has(p)) {
      try {
        const doc = await vscode.workspace.openTextDocument(rec.uri);
        cache.set(p, doc.getText());
      } catch {
        cache.set(p, '');
      }
    }
    const text = cache.get(p) || '';
    rec.preview = getContextPreview(text, rec.line, 2, 2).replace(/\r\n?/g, '\n');
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

async function pickInitialQuery(editor?: vscode.TextEditor): Promise<string> {
  if (!editor) {
    console.log('[SearchEverywhere] no active editor');
    return '';
  }

  const texts = editor.selections
    .filter(sel => !sel.isEmpty)
    .map(sel => editor.document.getText(sel))
    .filter(Boolean);

  const selected = texts.join(' ') || '';
  console.log('[SearchEverywhere] selection(s):', texts, 'final:', selected);

  return selected.slice(0, 512);
}




export function deactivate() { }
