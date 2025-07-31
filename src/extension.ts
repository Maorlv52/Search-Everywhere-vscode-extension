import * as vscode from 'vscode';

/** ---------- Types ---------- */
type ItemType = 'file' | 'symbol' | 'command' | 'setting';
type FilterMode = 'all' | 'file' | 'symbol' | 'command' | 'setting';

interface UnifiedItem {
  type: ItemType;
  label: string;
  description?: string;
  data: unknown;
}

interface Cfg {
  debounceMs: number;
  limits: { files: number; symbols: number; commands: number; settings: number };
  weights: Record<ItemType, number>;
  enable: Record<ItemType, boolean>;
  mru: { max: number; boostBase: number; decay: number };
  excludes: { useWorkspace: boolean; extra: string[] };
}

/** ---------- Configuration ---------- */
function loadCfg(): Cfg {
  const c = vscode.workspace.getConfiguration('searchEverywhere');
  return {
    debounceMs: c.get<number>('debounceMs', 150),
    limits: {
      files: c.get<number>('limits.files', 60),
      symbols: c.get<number>('limits.symbols', 100),
      commands: c.get<number>('limits.commands', 80),
      settings: c.get<number>('limits.settings', 50)
    },
    weights: {
      file: c.get<number>('weights.file', -3),
      symbol: c.get<number>('weights.symbol', -3),
      command: c.get<number>('weights.command', -1),
      setting: c.get<number>('weights.setting', 0)
    },
    enable: {
      file: c.get<boolean>('enable.files', true),
      symbol: c.get<boolean>('enable.symbols', true),
      command: c.get<boolean>('enable.commands', true),
      setting: c.get<boolean>('enable.settings', true)
    },
    mru: {
      max: c.get<number>('mru.max', 100),
      boostBase: c.get<number>('mru.boostBase', -1),
      decay: c.get<number>('mru.decay', 0.1)
    },
    excludes: {
      useWorkspace: c.get<boolean>('excludes.useWorkspace', true),
      extra: c.get<string[]>('excludes.extra', [
        '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**'
      ])
    }
  };
}

/** ---------- Utils ---------- */
const ICON: Record<ItemType, string> = {
  file: '$(file)',
  symbol: '$(symbol-method)',
  command: '$(terminal)',
  setting: '$(gear)'
};
const asPromise = <T>(t: Thenable<T>): Promise<T> => Promise.resolve(t);

function debounce<T extends (...args: any[]) => void>(fn: T, ms = 150) {
  let t: NodeJS.Timeout | undefined;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** ---------- MRU ---------- */
const MRU_KEY = 'searchEverywhere.mru';
type MRUEntry = { key: string; ts: number };

const mru = {
  load(ctx: vscode.ExtensionContext): MRUEntry[] {
    return ctx.globalState.get<MRUEntry[]>(MRU_KEY) ?? [];
  },
  touch(ctx: vscode.ExtensionContext, key: string, cfg: Cfg) {
    const now = Date.now();
    const arr = mru.load(ctx).filter(e => e.key !== key);
    arr.unshift({ key, ts: now });
    ctx.globalState.update(MRU_KEY, arr.slice(0, cfg.mru.max));
  },
  score(ctx: vscode.ExtensionContext, key: string, cfg: Cfg): number {
    const arr = mru.load(ctx);
    const idx = arr.findIndex(e => e.key === key);
    return idx < 0 ? 0 : Math.max(cfg.mru.boostBase * 5, cfg.mru.boostBase - idx * cfg.mru.decay);
  }
};

function makeKey(it: UnifiedItem): string {
  return `${it.type}|${it.label}|${it.description ?? ''}`;
}

/** ---------- Fuzzy ---------- */
const isBoundary = (s: string, i: number) =>
  i === 0 || '/_-. '.includes(s[i - 1]);

function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let qi = 0, score = 0, run = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const boundaryBonus = isBoundary(text, ti) ? 2 : 0;
      const camelBonus = (text[ti] && text[ti] !== text[ti].toLowerCase()) ? 1 : 0;
      run += 1;
      score += 1 + run * 0.3 + boundaryBonus + camelBonus;
      qi++;
    } else {
      run = 0;
    }
  }
  if (qi < q.length) return 0;     // לא כל האותיות נמצאו
  return -score;                   // שלילי = גבוה יותר בדירוג
}

/** ---------- Dispatch: open handlers ---------- */
const openHandlers: Record<ItemType, (item: UnifiedItem) => Promise<void>> = {
  file: async (item) => {
    const uri = item.data as vscode.Uri;
    await vscode.window.showTextDocument(uri, { preview: false });
  },
  symbol: async (item) => {
    const loc = item.data as vscode.Location;
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    ed.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
  },
  command: async (item) => {
    await vscode.commands.executeCommand(item.data as string);
  },
  setting: async (item) => {
    await vscode.commands.executeCommand('workbench.action.openSettings', item.data as string);
  }
};

/** ---------- Settings candidates (basic) ---------- */
const SETTINGS_CANDIDATES: string[] = [
  'editor.wordWrap',
  'editor.tabSize',
  'files.exclude',
  'search.exclude',
  'typescript.tsserver.log',
  'javascript.suggest.completeFunctionCalls'
];

/** ---------- Excludes handling ---------- */
function buildExcludeGlob(cfg: Cfg): string {
  const picks: string[] = [...cfg.excludes.extra];

  if (cfg.excludes.useWorkspace) {
    const filesEx = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') ?? {};
    const searchEx = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude') ?? {};
    picks.push(
      ...Object.entries(filesEx).filter(([, v]) => !!v).map(([k]) => k),
      ...Object.entries(searchEx).filter(([, v]) => !!v).map(([k]) => k)
    );
  }

  const norm = (p: string) => p.includes('*') ? p : (p.endsWith('/') ? `${p}**` : `${p}/**`);
  const unique = Array.from(new Set(picks.map(norm)));
  return unique.length <= 1 ? (unique[0] ?? '') : `{${unique.join(',')}}`;
}

/** ---------- Sources ---------- */
const FILTER_ORDER: FilterMode[] = ['all', 'file', 'symbol', 'command', 'setting'];
const FILTER_LABEL: Record<FilterMode, string> = {
  all: 'All', file: 'Files', symbol: 'Symbols', command: 'Commands', setting: 'Settings'
};

const SOURCES: Record<FilterMode, Array<ItemType>> = {
  all: ['file', 'symbol', 'command', 'setting'],
  file: ['file'],
  symbol: ['symbol'],
  command: ['command'],
  setting: ['setting']
};

/** ---------- Session (to avoid duplicate command registration) ---------- */
let session: {
  qp: vscode.QuickPick<vscode.QuickPickItem> | null;
  mode: FilterMode;
  refresh: (value: string) => void;
  setTitle: () => void;
} = {
  qp: null,
  mode: 'all',
  refresh: () => {},
  setTitle: () => {}
};

/** ---------- Entry ---------- */
export function activate(context: vscode.ExtensionContext) {
  let cfg = loadCfg();

  // האזנה לשינויים בהגדרות
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('searchEverywhere')) {
      cfg = loadCfg();
    }
  }, null, context.subscriptions);

  /** register cycleFilter ONCE (fixes "already exists") */
  const cycleFilterCmd = vscode.commands.registerCommand('searchEverywhere.cycleFilter', () => {
    if (!session.qp) return; // no active QuickPick
    const idx = FILTER_ORDER.indexOf(session.mode);
    session.mode = FILTER_ORDER[(idx + 1) % FILTER_ORDER.length];
    session.setTitle();
    session.refresh(session.qp.value);
  });
  context.subscriptions.push(cycleFilterCmd);

  /** open command */
  const openCmd = vscode.commands.registerCommand('searchEverywhere.open', async () => {
    const qp = vscode.window.createQuickPick();
    qp.placeholder = 'Search files, symbols, commands, settings…';
    qp.matchOnDescription = true;

    let items: UnifiedItem[] = [];

    // כפתורי פילטר (ימין/שמאל)
    const prevBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-left'), tooltip: 'Previous Filter' };
    const nextBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('arrow-right'), tooltip: 'Next Filter' };
    qp.buttons = [prevBtn, nextBtn];

    // הקשר לקיצור ⌥↩︎
    await vscode.commands.executeCommand('setContext', 'searchEverywhere.inQuickPick', true);
    qp.onDidHide(() => {
      vscode.commands.executeCommand('setContext', 'searchEverywhere.inQuickPick', false);
      session.qp = null; // clear session when closed
    });

    // מצב סשן לחיבור הפקודות והכפתורים
    session.qp = qp;
    session.mode = 'all';
    session.setTitle = () => { qp.title = `Filter: ${FILTER_LABEL[session.mode]} (⌥↩︎)`; };

    const refresh = async (raw: string) => {
      const query = raw.trim();
      if (!query) { qp.items = []; items = []; return; }

      const selected = SOURCES[session.mode].filter(k => cfg.enable[k]);
      const wants = (k: ItemType) => selected.includes(k);

      const jobs: Promise<UnifiedItem[]>[] = [];
      const excludePattern = buildExcludeGlob(cfg);

      // Files
      if (wants('file')) {
        jobs.push(
          asPromise(
            vscode.workspace.findFiles(`**/*${query}*`, excludePattern || undefined, cfg.limits.files)
              .then(uris => uris.map(uri => ({
                type: 'file' as const,
                label: `${ICON.file} ${uri.fsPath.split('/').pop()}`,
                description: uri.fsPath,
                data: uri
              })))
          )
        );
      }

      // Symbols
      if (wants('symbol')) {
        jobs.push(
          asPromise(
            vscode.commands.executeCommand<any[]>('vscode.executeWorkspaceSymbolProvider', query)
              .then(arr => (arr ?? []).slice(0, cfg.limits.symbols).map(sym => ({
                type: 'symbol' as const,
                label: `${ICON.symbol} ${sym.name}`,
                description: sym.containerName || sym.location?.uri?.fsPath,
                data: sym.location as vscode.Location
              })))
          ).catch<UnifiedItem[]>(() => [])
        );
      }

      // Commands
      if (wants('command')) {
        jobs.push(
          asPromise(
            vscode.commands.getCommands(true).then(cmds =>
              cmds
                .filter((c: string) => c.toLowerCase().includes(query.toLowerCase()))
                .slice(0, cfg.limits.commands)
                .map((cmd: string) => ({
                  type: 'command' as const,
                  label: `${ICON.command} ${cmd}`,
                  data: cmd
                }))
            )
          )
        );
      }

      // Settings
      if (wants('setting')) {
        const matched: UnifiedItem[] =
          SETTINGS_CANDIDATES
            .filter((s: string) => s.toLowerCase().includes(query.toLowerCase()))
            .slice(0, cfg.limits.settings)
            .map((s: string) => ({ type: 'setting' as const, label: `${ICON.setting} ${s}`, data: s }));
        jobs.push(Promise.resolve(matched));
      }

      const all = (await Promise.all(jobs)).flat();

      // דירוג: משקל סוג + Fuzzy + MRU
      items = all
        .map(it => {
          const text = `${it.label} ${it.description ?? ''}`;
          const base = cfg.weights[it.type];
          const fuzzy = fuzzyScore(query, text);
          const boost = mru.score(context, makeKey(it), cfg);
          return { it, s: base + fuzzy + boost };
        })
        .sort((a, b) => a.s - b.s)
        .map(x => x.it);

      qp.items = items.map(i => ({ label: i.label, description: i.description }));
    };

    // מחברים את פונקציית הריענון לסשן
    session.refresh = (value: string) => { refresh(value); };

    // כפתורים ← / →
    qp.onDidTriggerButton(btn => {
      if (!session.qp) return;
      const delta = btn === nextBtn ? +1 : -1;
      const idx = FILTER_ORDER.indexOf(session.mode);
      session.mode = FILTER_ORDER[(idx + delta + FILTER_ORDER.length) % FILTER_ORDER.length];
      session.setTitle();
      session.refresh(qp.value);
    });

    qp.onDidChangeValue(debounce(refresh, cfg.debounceMs));

    qp.onDidAccept(async () => {
      const sel = qp.selectedItems[0];
      if (!sel) return;
      const chosen = items.find(i => i.label === sel.label && i.description === sel.description);
      if (chosen) {
        await openHandlers[chosen.type](chosen);
        mru.touch(context, makeKey(chosen), cfg);
      }
      qp.hide();
    });

    session.setTitle();
    qp.show();
  });

  context.subscriptions.push(openCmd);
}

export function deactivate() {}
