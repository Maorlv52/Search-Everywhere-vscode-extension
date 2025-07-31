"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
/** ---------- Configuration ---------- */
function loadCfg() {
    const c = vscode.workspace.getConfiguration('searchEverywhere');
    return {
        debounceMs: c.get('debounceMs', 150),
        limits: {
            files: c.get('limits.files', 60),
            symbols: c.get('limits.symbols', 100),
            commands: c.get('limits.commands', 80),
            settings: c.get('limits.settings', 50)
        },
        weights: {
            file: c.get('weights.file', -3),
            symbol: c.get('weights.symbol', -3),
            command: c.get('weights.command', -1),
            setting: c.get('weights.setting', 0)
        },
        enable: {
            file: c.get('enable.files', true),
            symbol: c.get('enable.symbols', true),
            command: c.get('enable.commands', true),
            setting: c.get('enable.settings', true)
        },
        mru: {
            max: c.get('mru.max', 100),
            boostBase: c.get('mru.boostBase', -1),
            decay: c.get('mru.decay', 0.1)
        },
        excludes: {
            useWorkspace: c.get('excludes.useWorkspace', true),
            extra: c.get('excludes.extra', [
                '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/out/**'
            ])
        }
    };
}
/** ---------- Utils ---------- */
const ICON = {
    file: '$(file)',
    symbol: '$(symbol-method)',
    command: '$(terminal)',
    setting: '$(gear)'
};
const asPromise = (t) => Promise.resolve(t);
function debounce(fn, ms = 150) {
    let t;
    return (...args) => {
        if (t)
            clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}
/** ---------- MRU ---------- */
const MRU_KEY = 'searchEverywhere.mru';
const mru = {
    load(ctx) {
        return ctx.globalState.get(MRU_KEY) ?? [];
    },
    touch(ctx, key, cfg) {
        const now = Date.now();
        const arr = mru.load(ctx).filter(e => e.key !== key);
        arr.unshift({ key, ts: now });
        ctx.globalState.update(MRU_KEY, arr.slice(0, cfg.mru.max));
    },
    score(ctx, key, cfg) {
        const arr = mru.load(ctx);
        const idx = arr.findIndex(e => e.key === key);
        return idx < 0 ? 0 : Math.max(cfg.mru.boostBase * 5, cfg.mru.boostBase - idx * cfg.mru.decay);
    }
};
function makeKey(it) {
    return `${it.type}|${it.label}|${it.description ?? ''}`;
}
/** ---------- Fuzzy ---------- */
const isBoundary = (s, i) => i === 0 || '/_-. '.includes(s[i - 1]);
function fuzzyScore(query, text) {
    if (!query)
        return 0;
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
        }
        else {
            run = 0;
        }
    }
    if (qi < q.length)
        return 0; // לא כל האותיות נמצאו
    return -score; // שלילי = גבוה יותר בדירוג
}
/** ---------- Dispatch: open handlers ---------- */
const openHandlers = {
    file: async (item) => {
        const uri = item.data;
        await vscode.window.showTextDocument(uri, { preview: false });
    },
    symbol: async (item) => {
        const loc = item.data;
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const ed = await vscode.window.showTextDocument(doc, { preview: false });
        ed.revealRange(loc.range, vscode.TextEditorRevealType.InCenter);
    },
    command: async (item) => {
        await vscode.commands.executeCommand(item.data);
    },
    setting: async (item) => {
        await vscode.commands.executeCommand('workbench.action.openSettings', item.data);
    }
};
/** ---------- Settings candidates (basic) ---------- */
const SETTINGS_CANDIDATES = [
    'editor.wordWrap',
    'editor.tabSize',
    'files.exclude',
    'search.exclude',
    'typescript.tsserver.log',
    'javascript.suggest.completeFunctionCalls'
];
/** ---------- Excludes handling ---------- */
function buildExcludeGlob(cfg) {
    const picks = [...cfg.excludes.extra];
    if (cfg.excludes.useWorkspace) {
        const filesEx = vscode.workspace.getConfiguration('files').get('exclude') ?? {};
        const searchEx = vscode.workspace.getConfiguration('search').get('exclude') ?? {};
        picks.push(...Object.entries(filesEx).filter(([, v]) => !!v).map(([k]) => k), ...Object.entries(searchEx).filter(([, v]) => !!v).map(([k]) => k));
    }
    const norm = (p) => p.includes('*') ? p : (p.endsWith('/') ? `${p}**` : `${p}/**`);
    const unique = Array.from(new Set(picks.map(norm)));
    return unique.length <= 1 ? (unique[0] ?? '') : `{${unique.join(',')}}`;
}
/** ---------- Sources ---------- */
const FILTER_ORDER = ['all', 'file', 'symbol', 'command', 'setting'];
const FILTER_LABEL = {
    all: 'All', file: 'Files', symbol: 'Symbols', command: 'Commands', setting: 'Settings'
};
const SOURCES = {
    all: ['file', 'symbol', 'command', 'setting'],
    file: ['file'],
    symbol: ['symbol'],
    command: ['command'],
    setting: ['setting']
};
/** ---------- Session (to avoid duplicate command registration) ---------- */
let session = {
    qp: null,
    mode: 'all',
    refresh: () => { },
    setTitle: () => { }
};
/** ---------- Entry ---------- */
function activate(context) {
    let cfg = loadCfg();
    // האזנה לשינויים בהגדרות
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('searchEverywhere')) {
            cfg = loadCfg();
        }
    }, null, context.subscriptions);
    /** register cycleFilter ONCE (fixes "already exists") */
    const cycleFilterCmd = vscode.commands.registerCommand('searchEverywhere.cycleFilter', () => {
        if (!session.qp)
            return; // no active QuickPick
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
        let items = [];
        // כפתורי פילטר (ימין/שמאל)
        const prevBtn = { iconPath: new vscode.ThemeIcon('arrow-left'), tooltip: 'Previous Filter' };
        const nextBtn = { iconPath: new vscode.ThemeIcon('arrow-right'), tooltip: 'Next Filter' };
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
        const refresh = async (raw) => {
            const query = raw.trim();
            if (!query) {
                qp.items = [];
                items = [];
                return;
            }
            const selected = SOURCES[session.mode].filter(k => cfg.enable[k]);
            const wants = (k) => selected.includes(k);
            const jobs = [];
            const excludePattern = buildExcludeGlob(cfg);
            // Files
            if (wants('file')) {
                jobs.push(asPromise(vscode.workspace.findFiles(`**/*${query}*`, excludePattern || undefined, cfg.limits.files)
                    .then(uris => uris.map(uri => ({
                    type: 'file',
                    label: `${ICON.file} ${uri.fsPath.split('/').pop()}`,
                    description: uri.fsPath,
                    data: uri
                })))));
            }
            // Symbols
            if (wants('symbol')) {
                jobs.push(asPromise(vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)
                    .then(arr => (arr ?? []).slice(0, cfg.limits.symbols).map(sym => ({
                    type: 'symbol',
                    label: `${ICON.symbol} ${sym.name}`,
                    description: sym.containerName || sym.location?.uri?.fsPath,
                    data: sym.location
                })))).catch(() => []));
            }
            // Commands
            if (wants('command')) {
                jobs.push(asPromise(vscode.commands.getCommands(true).then(cmds => cmds
                    .filter((c) => c.toLowerCase().includes(query.toLowerCase()))
                    .slice(0, cfg.limits.commands)
                    .map((cmd) => ({
                    type: 'command',
                    label: `${ICON.command} ${cmd}`,
                    data: cmd
                })))));
            }
            // Settings
            if (wants('setting')) {
                const matched = SETTINGS_CANDIDATES
                    .filter((s) => s.toLowerCase().includes(query.toLowerCase()))
                    .slice(0, cfg.limits.settings)
                    .map((s) => ({ type: 'setting', label: `${ICON.setting} ${s}`, data: s }));
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
        session.refresh = (value) => { refresh(value); };
        // כפתורים ← / →
        qp.onDidTriggerButton(btn => {
            if (!session.qp)
                return;
            const delta = btn === nextBtn ? +1 : -1;
            const idx = FILTER_ORDER.indexOf(session.mode);
            session.mode = FILTER_ORDER[(idx + delta + FILTER_ORDER.length) % FILTER_ORDER.length];
            session.setTitle();
            session.refresh(qp.value);
        });
        qp.onDidChangeValue(debounce(refresh, cfg.debounceMs));
        qp.onDidAccept(async () => {
            const sel = qp.selectedItems[0];
            if (!sel)
                return;
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
function deactivate() { }
