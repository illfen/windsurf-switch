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
exports.SidebarProvider = void 0;
const crypto = __importStar(require("crypto"));
const vscode = __importStar(require("vscode"));
const accountsStore_1 = __importStar(require("./accountsStore"));
const importParser_1 = __importStar(require("./importParser"));
const log_1 = __importStar(require("./log"));
const memoryCreds_1 = __importStar(require("./memoryCreds"));
const autoSwitch_1 = __importStar(require("./autoSwitch"));
const smartSwitch_1 = __importStar(require("./smartSwitch"));
const UI_KEYS = {
    sortCollapsed: 'wm.ui.sortCollapsed',
    filterCollapsed: 'wm.ui.filterCollapsed'
};
/**
 * Primary UI for the extension: a Webview View that lives in the Activity Bar
 * container `windsurfSwitch`. It mirrors the desktop manager's MainWindow
 * (top toolbar + sort chip + filter chips + account cards with per-card
 * action buttons).
 *
 * Design choices:
 *   - Filter & sort state are local to the webview (via getState/setState),
 *     so switching Activity Bar panels and returning keeps the user's view.
 *   - Account data only includes metadata (no tokens/passwords). Secrets
 *     are decrypted on-demand inside the relevant commands.
 */
class SidebarProvider {
    constructor(ctx) {
        this._accounts = [];
        this._loading = false;
        /**
         * Last "filtered + sorted" account id list reported by the webview.
         * Kept in sync via the `candidateIds` message and used by smart switch
         * to only consider accounts the user is currently looking at.
         */
        this._lastCandidateIds = null;
        /**
         * JSON of the last state payload we posted to the webview. Used to
         * suppress duplicate posts so cross-window heartbeat / focus / fs-watcher
         * resyncs don't re-render the UI when nothing actually changed.
         */
        this._lastPostedJson = null;
        // 并发/重复调用只触发一次真正的 disk read，降低批量操作里的抖动。
        this._reloadInFlight = null;
        this.ctx = ctx;
    }
    /** Subscribe to post-reload notifications. Only one listener allowed. */
    setOnDidReload(cb) {
        this._onDidReload = cb;
    }
    get accounts() {
        return this._accounts;
    }
    findAccount(id) {
        return this._accounts.find(a => a.id === id);
    }
    getLastCandidateIds() {
        return this._lastCandidateIds;
    }
    resolveWebviewView(webviewView) {
        (0, log_1.log)('SidebarProvider.resolveWebviewView invoked');
        this._view = webviewView;
        // A fresh webview instance has no prior state; clear the dedup cache
        // so the very first postState() reaches it (otherwise a cache entry
        // from a previously-disposed view would silently drop the new view's
        // initial render, leaving it blank).
        this._lastPostedJson = null;
        try {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [this.ctx.extensionUri]
            };
            webviewView.webview.html = this.getHtml(webviewView.webview);
            webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
            webviewView.onDidDispose(() => {
                this._view = undefined;
                this._lastPostedJson = null;
            });
            void this.reload();
        }
        catch (e) {
            (0, log_1.log)('resolveWebviewView failed:', e?.stack || e?.message || e);
            webviewView.webview.html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:16px;color:#f14c4c">
                <h3>Windsurf Switch 启动失败</h3>
                <pre style="white-space:pre-wrap">${escapeHtml(String(e?.stack || e?.message || e))}</pre>
            </body></html>`;
        }
    }
    reload() {
        if (this._reloadInFlight) {
            return this._reloadInFlight;
        }
        this._reloadInFlight = this._doReload().finally(() => {
            this._reloadInFlight = null;
        });
        return this._reloadInFlight;
    }
    async _doReload() {
        // Only surface the "loading…" intermediate state on the very first
        // reload (when the webview has nothing to show yet).  Subsequent
        // reloads — triggered by the cross-window heartbeat, file watcher,
        // focus events, etc. — keep the existing content visible and only
        // post the final payload, which postState() will suppress entirely
        // if nothing changed.
        const firstLoad = this._accounts.length === 0 && !this._error;
        this._loading = true;
        this._error = undefined;
        if (firstLoad)
            this.postState();
        try {
            this._accounts = await (0, accountsStore_1.loadManagerAccounts)();
        }
        catch (e) {
            this._error = e?.message || String(e);
            this._accounts = [];
            (0, log_1.log)('SidebarProvider.reload failed:', e?.message || e);
        }
        finally {
            this._loading = false;
            this.postState();
            // Notify extension.ts subscribers (status bar, etc.) AFTER the
            // webview has been updated so they see the freshest accounts list.
            try {
                this._onDidReload?.();
            }
            catch (e) {
                (0, log_1.log)('SidebarProvider._onDidReload threw:', e?.message || e);
            }
        }
    }
    postStatus(text, tone = 'info') {
        this._view?.webview.postMessage({ type: 'status', text, tone });
    }
    /** Generic postMessage for control messages like modal open/close. */
    postMessage(payload) {
        this._view?.webview.postMessage(payload);
    }
    reveal() {
        this._view?.show?.(true);
    }
    /** Tell the webview to open the in-sidebar modal overlay. */
    async openModal(kind, opts) {
        // Make sure the view container is focused and the webview resolved,
        // otherwise postMessage gets dropped (webview not yet created).
        try {
            await vscode.commands.executeCommand('workbench.view.extension.windsurfSwitch');
        }
        catch {
            // ignore; may fail in edge environments
        }
        for (let i = 0; i < 20; i++) {
            if (this._view) {
                break;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        this._view?.show?.(true);
        this._view?.webview.postMessage({ type: 'openModal', kind, opts });
    }
    postModalClose() {
        this._view?.webview.postMessage({ type: 'modalClose' });
    }
    postModalError(text) {
        this._view?.webview.postMessage({ type: 'modalError', text });
    }
    postBatchPreview(count) {
        this._view?.webview.postMessage({ type: 'batchPreview', count });
    }
    /** True iff the sidebar view has been resolved at least once. */
    get isReady() {
        return !!this._view;
    }
    postState() {
        if (!this._view)
            return;
        const gs = this.ctx.globalState;
        const rawHistory = gs.get('wm.smartSwitchHistory', {}) || {};
        const history = (0, smartSwitch_1.pruneHistory)(rawHistory);
        // If prune trimmed entries, persist the cleaned copy back.
        if (Object.keys(history).length !== Object.keys(rawHistory).length) {
            void gs.update('wm.smartSwitchHistory', history);
        }
        const payload = {
            type: 'state',
            loading: this._loading,
            error: this._error,
            accounts: this._accounts.map(serialize),
            currentAccountId: gs.get('wm.currentAccountId', null) || null,
            activeEmail: gs.get('wm.activeEmail', null) || null,
            smartHistory: history,
            auto: {
                polling: {
                    enabled: gs.get(autoSwitch_1.STATE_KEYS.pollingEnabled, false),
                    intervalMs: gs.get(autoSwitch_1.STATE_KEYS.pollingIntervalMs, autoSwitch_1.DEFAULT_POLLING_INTERVAL_MS)
                },
                logWatch: {
                    enabled: gs.get(autoSwitch_1.STATE_KEYS.logWatchEnabled, false),
                    patterns: gs.get(autoSwitch_1.STATE_KEYS.logWatchPatterns, autoSwitch_1.DEFAULT_LOG_PATTERNS)
                },
                lowQuotaThreshold: gs.get(autoSwitch_1.STATE_KEYS.lowQuotaThreshold, autoSwitch_1.DEFAULT_LOW_QUOTA_THRESHOLD),
                lowQuotaThresholdEnabled: gs.get(autoSwitch_1.STATE_KEYS.lowQuotaThresholdEnabled, true)
            },
            ui: {
                sortCollapsed: gs.get(UI_KEYS.sortCollapsed, true),
                filterCollapsed: gs.get(UI_KEYS.filterCollapsed, true)
            }
        };
        // Dedup: if the serialized payload is identical to the last one we
        // sent, do NOT post again — avoids the flicker the user saw when the
        // 30s heartbeat or fs-watcher repeatedly fired sidebar.reload() with
        // unchanged data.
        const json = JSON.stringify(payload);
        if (json === this._lastPostedJson)
            return;
        this._lastPostedJson = json;
        this._view.webview.postMessage(payload);
    }
    /** Force the next postState() to go through even if the payload is identical. */
    invalidatePostCache() {
        this._lastPostedJson = null;
    }
    handleMessage(msg) {
        const cmd = msg?.cmd;
        switch (cmd) {
            case 'reload':
                void this.reload();
                return;
            case 'addAccount':
                // Kept for palette compatibility; sidebar toolbar opens modal locally.
                void vscode.commands.executeCommand('windsurfSwitch.addAccount');
                return;
            case 'batchImport':
                void vscode.commands.executeCommand('windsurfSwitch.batchImport');
                return;
            case 'exportAccounts':
                void vscode.commands.executeCommand('windsurfSwitch.exportAccounts');
                return;
            case 'submitAdd':
                void vscode.commands.executeCommand('windsurfSwitch._submitAddFromModal', { email: msg.email, password: msg.password });
                return;
            case 'submitBatch':
                void vscode.commands.executeCommand('windsurfSwitch._submitBatchFromModal', { text: msg.text });
                return;
            case 'previewBatch': {
                // Quick parse on every keystroke — cheap, pure.
                let count = 0;
                try {
                    count = (0, importParser_1.parseBatch)(String(msg.text || '')).length;
                }
                catch {
                    count = 0;
                }
                this.postBatchPreview(count);
                return;
            }
            case 'refreshAll':
                void vscode.commands.executeCommand('windsurfSwitch.refreshAll');
                return;
            case 'switch':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.switchAccountById', msg.id);
                }
                return;
            case 'refresh':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.refreshAccount', msg.id);
                }
                return;
            case 'delete':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.deleteAccountById', msg.id);
                }
                return;
            case 'credentials':
                // 直接复制「账号+密码」。旧的 showCredentials 弹框仍可通过命令面板调用。
                if (msg.id) {
                    void this.copyCredentialToClipboard({
                        id: String(msg.id),
                        field: 'both'
                    });
                }
                return;
            case 'editRemark':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.editRemarkById', msg.id);
                }
                return;
            case 'fixCredentials':
                if (msg.id) {
                    void vscode.commands.executeCommand('windsurfSwitch.fixCredentialsById', msg.id);
                }
                return;
            case 'copyCred':
                if (msg.id && msg.field) {
                    void this.copyCredentialToClipboard({
                        id: String(msg.id),
                        field: String(msg.field)
                    });
                }
                return;
            case 'openAccountsFile':
                void vscode.commands.executeCommand('windsurfSwitch.openAccountsFile');
                return;
            case 'showLog':
                void vscode.commands.executeCommand('windsurfSwitch.showOutput');
                return;
            // --- Smart switch / auto switch ---
            case 'smartSwitch': {
                const ids = Array.isArray(msg.filteredIds)
                    ? msg.filteredIds.map((x) => String(x))
                    : undefined;
                if (ids) {
                    this._lastCandidateIds = ids;
                }
                void vscode.commands.executeCommand('windsurfSwitch._smartSwitchFromSidebar', {
                    filteredIds: ids
                });
                return;
            }
            case 'resetCooldown':
                void vscode.commands.executeCommand('windsurfSwitch.resetSmartCooldown');
                return;
            case 'refreshCurrent': {
                // Let the extension re-probe the Windsurf session first so we
                // don't refresh a stale id when the user already switched away.
                void vscode.commands.executeCommand('windsurfSwitch._refreshCurrentSynced');
                return;
            }
            case 'toggleAuto':
                void vscode.commands.executeCommand('windsurfSwitch._toggleAuto', {
                    kind: msg.kind,
                    enabled: !!msg.enabled
                });
                return;
            case 'setPollingInterval':
                void vscode.commands.executeCommand('windsurfSwitch._setPollingInterval', {
                    intervalMs: Number(msg.intervalMs)
                });
                return;
            case 'setLowQuotaThreshold':
                void vscode.commands.executeCommand('windsurfSwitch._setLowQuotaThreshold', {
                    threshold: Number(msg.threshold)
                });
                return;
            case 'candidateIds': {
                // Webview reports the current filtered+sorted id list any time
                // filters / sort / account set changes.
                if (Array.isArray(msg.ids)) {
                    this._lastCandidateIds = msg.ids.map((x) => String(x));
                }
                return;
            }
            case 'toggleCollapse': {
                const section = String(msg.section || '');
                const collapsed = !!msg.collapsed;
                const key = section === 'sort'
                    ? 'wm.ui.sortCollapsed'
                    : section === 'filter'
                        ? 'wm.ui.filterCollapsed'
                        : null;
                if (key) {
                    void this.ctx.globalState.update(key, collapsed);
                }
                return;
            }
            default:
                (0, log_1.log)('sidebar: unknown message', cmd);
        }
    }
    /**
     * Copy requests are handled inside the provider instead of a globally
     * registered VS Code command, so other extensions cannot invoke the
     * credential-copy path with a guessed account id.
     */
    async copyCredentialToClipboard(args) {
        const accountId = args?.id || '';
        const field = (args?.field || '').toLowerCase();
        if (!accountId || !field) {
            return;
        }
        try {
            // Prefer the in-memory cache (populated on activation + after every
            // add / fix) — avoids spawning PowerShell for DPAPI on every click.
            let email = '';
            let password = '';
            const cached = await (0, memoryCreds_1.getCreds)(accountId);
            if (cached && (cached.email || cached.password)) {
                email = cached.email;
                password = cached.password;
            }
            else {
                const loaded = await (0, accountsStore_1.loadAccountWithSecrets)(accountId);
                if (!loaded) {
                    this.postStatus('无法读取该账号', 'error');
                    return;
                }
                email = loaded.email;
                password = loaded.password;
            }
            if (field === 'email') {
                if (!email) {
                    this.postStatus('账号邮箱为空', 'warn');
                    return;
                }
                await vscode.env.clipboard.writeText(email);
                this.postStatus(`已复制邮箱 ${email}`, 'success');
                return;
            }
            if (field === 'password') {
                if (!password) {
                    this.postStatus('该账号没有存储密码', 'warn');
                    return;
                }
                await vscode.env.clipboard.writeText(password);
                this.postStatus('已复制密码（请尽快粘贴并清空剪贴板）', 'success');
                return;
            }
            if (field === 'both') {
                if (!password) {
                    this.postStatus('该账号没有存储密码', 'warn');
                    return;
                }
                const text = `账号: ${email}    密码: ${password}`;
                await vscode.env.clipboard.writeText(text);
                this.postStatus('已复制 账号+密码', 'success');
                return;
            }
            this.postStatus(`未知字段: ${field}`, 'error');
        }
        catch (e) {
            (0, log_1.log)('copyCredentialToClipboard failed:', e?.message || e);
            this.postStatus(`复制失败: ${e?.message || e}`, 'error');
        }
    }
    getHtml(webview) {
        const nonce = crypto.randomBytes(16).toString('hex');
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `img-src ${webview.cspSource} data:`,
            `font-src ${webview.cspSource}`
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Windsurf Switch</title>
<style>${CSS}</style>
</head>
<body>
    <div id="status-bar" class="status" hidden></div>

    <div class="toolbar">
        <!-- 工具栏三个按钮改为 icon-only：+ 添加 / 下载导入 / 刷新。tooltip 通过 data-tip 挂在按钮下方。 -->
        <button class="btn-primary act" data-cmd="addAccount" data-tip="添加账号">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <button class="btn act" data-cmd="batchImport" data-tip="批量导入">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2.5 13.5h11"/></svg>
        </button>
        <button class="btn act" data-cmd="exportAccounts" data-tip="导出全部账号到剪贴板">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13.5V5M4.5 8.5 8 5l3.5 3.5M2.5 2.5h11"/></svg>
        </button>
        <button class="btn act" data-cmd="refreshAll" data-tip="刷新全部 Plan / Quota">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>
        </button>
        <!-- 自动切号入口：外层 .dropdown 保留，但触发器使用 .btn 类与 toolbar 其他按钮保持一致视觉。
             .dropdown-trigger 类仍然保留以让通用 click handler 接管弹层；外观由更高特异性的 .toolbar .btn.dropdown-trigger 规则接管。
             margin-left: auto 把它推到最右。 -->
        <div class="dropdown" data-dd="auto">
            <button class="btn dropdown-trigger" type="button" data-dd-trigger="auto" title="自动切号设置">
                <span class="ico auto-ico" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M9 1.5 3 9h4l-1 5.5L13 7H9z"/></svg>
                </span>
                <span>自动切号</span>
                <span class="auto-dot" id="auto-dot" hidden></span>
            </button>
            <div class="dropdown-menu auto-menu" id="auto-menu" hidden>
                <div id="auto-options"></div>
            </div>
        </div>
    </div>

    <div class="section-label">当前账号</div>
    <div id="current-account"></div>

    <div class="list-header">
        <div class="count" id="count">—</div>
        <div class="list-header-controls">
            <div class="dropdown" data-dd="sort">
                <button class="dropdown-trigger" type="button" data-dd-trigger="sort">
                    <span class="dropdown-ico">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v10M4 3l-2 2M4 3l2 2M11 13V3M11 13l-2-2M11 13l2-2"/></svg>
                    </span>
                    <span class="dropdown-label" id="sort-label">按到期时间 ↑</span>
                    <span class="dropdown-caret">▾</span>
                </button>
                <div class="dropdown-menu" id="sort-menu" hidden>
                    <button class="dropdown-option" type="button" data-sort="expiry">按到期时间</button>
                    <button class="dropdown-option" type="button" data-sort="quota">按可用额度</button>
                </div>
            </div>
            <div class="dropdown" data-dd="filter">
                <button class="dropdown-trigger" type="button" data-dd-trigger="filter">
                    <span class="dropdown-ico">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12l-4.5 6v4l-3 1v-5z"/></svg>
                    </span>
                    <span class="dropdown-label" id="filter-label">筛选</span>
                    <span class="dropdown-caret">▾</span>
                </button>
                <div class="dropdown-menu" id="filter-menu" hidden>
                    <label class="dropdown-check"><input type="checkbox" data-filter="trial"/><span>Trial 账号</span></label>
                    <label class="dropdown-check"><input type="checkbox" data-filter="exclude-no-quota"/><span>除无额度账号</span></label>
                    <label class="dropdown-check"><input type="checkbox" data-filter="exclude-today-unavailable"/><span>除今日不可用</span></label>
                </div>
            </div>
        </div>
    </div>

    <div id="list"></div>

    <div id="modal-overlay" class="modal-overlay" hidden>
        <div class="modal-card" id="modal-add" hidden>
            <div class="modal-title">添加账号</div>
            <div class="modal-field">
                <label for="modal-add-email">邮箱</label>
                <input id="modal-add-email" type="email" autocomplete="off" spellcheck="false" />
            </div>
            <div class="modal-field">
                <label for="modal-add-password">密码</label>
                <input id="modal-add-password" type="password" autocomplete="off" spellcheck="false" />
            </div>
            <div class="modal-error" id="modal-add-error" hidden></div>
            <div class="modal-actions">
                <button class="btn" data-modal-cancel type="button">取消</button>
                <button class="btn-primary" id="modal-add-submit" type="button">添加</button>
            </div>
        </div>
        <div class="modal-card" id="modal-creds" hidden>
            <div class="modal-title">账号凭据 · <span id="modal-creds-email"></span></div>
            <div class="modal-creds-actions">
                <button class="btn" data-creds-copy="email" type="button">复制邮箱</button>
                <button class="btn" data-creds-copy="password" type="button">复制密码</button>
                <button class="btn-primary" data-creds-copy="both" type="button">复制 账号:xxx 密码:yyy</button>
                <button class="btn" data-creds-copy="remark" type="button">编辑备注</button>
            </div>
            <div class="modal-hint" id="modal-creds-hint">点击按钮后内容将复制到剪贴板。</div>
            <div class="modal-actions">
                <button class="btn" data-modal-cancel type="button">关闭</button>
            </div>
        </div>
        <div class="modal-card" id="modal-batch" hidden>
            <div class="modal-title">批量导入</div>
            <div class="modal-hint">
                每行 1 条账号，以下任一格式均可识别，也可以混合使用：

                <div class="modal-format-group">
                    <div class="modal-format-title">① 分隔符式</div>
                    <div class="modal-format-desc">邮箱和密码之间用以下任一分隔： <code>:</code> <code>,</code> <code>|</code> <code>;</code> <code>----</code> <code>@@</code> 或 空格 / Tab</div>
                    <pre class="modal-format-example">alice@example.com:Pass123
bob@mail.com  Qwerty456
carol@foo.io|MyP@ss</pre>
                </div>

                <div class="modal-format-group">
                    <div class="modal-format-title">② 标签式（中英冒号皆可，可单行可多行）</div>
                    <div class="modal-format-desc">"账号 / 邮箱" 与 "密码" 作为字段名；两者同行用空格/逗号分隔也可识别。</div>
                    <pre class="modal-format-example">邮箱: dave@x.com
密码: 88Dave88

账号: eve@x.com    密码: EvEeve
账号: frank@y.com, 密码: fR4NK</pre>
                    <div class="modal-format-desc" style="margin-top:4px;">点账号卡 🔑 复制出来就是这个单行格式，可以直接粘进来。</div>
                </div>

                <div class="modal-format-group">
                    <div class="modal-format-title">③ 结构化（CSV / URL 参数 / JSON）</div>
                    <pre class="modal-format-example">email,password
email=dave@x.com&amp;password=88Dave88
[{"email":"a@x.com","password":"p"}]</pre>
                </div>

                <div class="modal-format-hint-tail">粘贴后下方会显示「已识别 N 个账号」，确认无误再点开始导入。重复邮箱会被自动跳过。</div>
            </div>
            <textarea id="modal-batch-text" rows="10" spellcheck="false" placeholder="粘贴账号列表..."></textarea>
            <div class="modal-preview" id="modal-batch-preview">已识别 0 个账号</div>
            <div class="modal-actions">
                <button class="btn" data-modal-cancel type="button">取消</button>
                <button class="btn-primary" id="modal-batch-submit" type="button" disabled>开始导入</button>
            </div>
        </div>
    </div>

<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
    }
}
exports.SidebarProvider = SidebarProvider;
SidebarProvider.viewId = 'windsurfSwitch.sidebar';
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
// ---------------------------------------------------------------------------
// account serialization sent to the webview
// ---------------------------------------------------------------------------
function serialize(a) {
    return {
        id: a.id,
        email: a.email,
        displayName: a.displayName,
        authProvider: a.authProvider,
        planName: a.planName,
        dailyRemainPct: a.dailyRemainPct,
        weeklyRemainPct: a.weeklyRemainPct,
        dailyResetUnix: a.dailyResetUnix,
        weeklyResetUnix: a.weeklyResetUnix,
        expiresAt: a.expiresAt,
        gracePeriodStatus: a.gracePeriodStatus,
        lastQueryTime: a.lastQueryTime,
        quotaError: a.quotaError,
        remark: a.remark,
        hasCredentials: a.hasCredentials
    };
}
// ---------------------------------------------------------------------------
// CSS - uses VS Code theme variables so it matches light / dark / HC themes.
// ---------------------------------------------------------------------------
const CSS = /* css */ `
/* ===========================================================================
 * Design tokens — single source of truth for spacing / radius / shadow /
 * motion. All values are theme-adaptive via VSCode CSS variables.
 * ========================================================================= */
:root {
  /* Surfaces */
  --card-bg: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  --card-bg-hover: color-mix(in srgb, var(--vscode-foreground) 4%, var(--card-bg));
  --card-border: var(--vscode-panel-border, rgba(128,128,128,0.28));
  --card-border-hover: color-mix(in srgb, var(--vscode-focusBorder) 50%, var(--card-border));
  --muted: var(--vscode-descriptionForeground);

  /* Semantic */
  --danger: var(--vscode-errorForeground, #f14c4c);
  --success: var(--vscode-testing-iconPassed, #3fb950);
  --warn: var(--vscode-editorWarning-foreground, #cca700);
  --accent: var(--vscode-focusBorder, #007acc);
  --accent-bg: var(--vscode-button-background);
  --accent-fg: var(--vscode-button-foreground);
  --accent-hover: var(--vscode-button-hoverBackground);
  --accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
  --accent-soft-strong: color-mix(in srgb, var(--accent) 22%, transparent);

  --neutral-bg: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
  --neutral-fg: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  --neutral-hover: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));

  /* Spacing scale (4-pt grid) */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px;

  /* Radius scale */
  --r-sm: 4px; --r-md: 6px; --r-lg: 10px; --r-pill: 999px;

  /* Type scale */
  --fs-xs: 10.5px; --fs-sm: 11.5px; --fs-md: 12.5px; --fs-lg: 13.5px;

  /* Elevation — subtle, theme-friendly */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.18);
  --shadow-md: 0 2px 6px rgba(0,0,0,0.22);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.40);

  /* Motion */
  --ease: cubic-bezier(0.2, 0, 0, 1);
  --dur-fast: 120ms;
  --dur-base: 180ms;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
body {
  padding: var(--sp-2) var(--sp-2) var(--sp-4) var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-radius: var(--r-sm);
}

/* ===========================================================================
 * Toolbar
 * ========================================================================= */
.toolbar {
  display: flex;
  gap: var(--sp-1);
  flex-wrap: nowrap; /* 所有按钮常驻一行，空间不够时让文字收缩而不是换行 */
  align-items: center;
  padding: 2px 0 var(--sp-2) 0;
  border-bottom: 1px solid var(--card-border);
  position: relative; /* 授予局部 stacking，注意不能加 overflow: hidden，
                         否则 .dropdown-menu 弹出时会被裁掉。按钮自己的
                         overflow: hidden 已负责文字省略号。 */
  z-index: 5; /* 确保 dropdown 弹层在下面的 #current-account 卡片之上 */
}

/* Toolbar 内按钮自适应：
   - 普通 .btn / .btn-primary：需要时会被挤缩（文字以省略号结尾）。
   - 自动切号按钮：不被挤缩， margin-left: auto 将其推到最右。*/
.toolbar > .btn,
.toolbar > .btn-primary {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* icon-only (.act) 按钮必须 overflow: visible，否则 ::after 伪元素（tooltip）
   会被按钮自身的 overflow: hidden 裁掉，看不到悬停提示。*/
.toolbar > .btn.act,
.toolbar > .btn-primary.act {
  overflow: visible;
}
.toolbar > .dropdown {
  flex: 0 0 auto;
  margin-left: auto;
}
/* Toolbar 里图标按钮的 tooltip 改显在按钮下方（按钮在顶部，上方没空间） */
.toolbar .act[data-tip]::after {
  bottom: auto;
  top: calc(100% + 6px);
  transform: translateX(-50%) translateY(-2px);
}
.toolbar .act[data-tip]:hover::after {
  transform: translateX(-50%) translateY(0);
}
/* 第一个按钮的 tooltip 左对齐（避免被 sidebar 左边界裁掉） */
.toolbar .act[data-tip]:first-child::after {
  left: 0;
  transform: translateY(-2px);
}
.toolbar .act[data-tip]:first-child:hover::after {
  transform: translateY(0);
}
/* 弹层打开时提高 z-index，确保浮在所有卡片之上 */
.toolbar > .dropdown.open {
  z-index: 60;
}
.toolbar .dropdown-menu {
  z-index: 60;
}

/* ===========================================================================
 * Buttons — micro-interactions: subtle lift on hover, press on active
 * ========================================================================= */
.btn, .btn-primary, .btn-icon, .btn-danger {
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 4px 10px;
  cursor: pointer;
  font-size: var(--fs-md);
  line-height: 1.4;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-family: inherit;
  font-weight: 500;
  transition: background var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease),
              transform var(--dur-fast) var(--ease),
              box-shadow var(--dur-fast) var(--ease);
}
.btn-primary {
  background: var(--accent-bg);
  color: var(--accent-fg);
  box-shadow: var(--shadow-sm);
}
.btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn-primary:active { transform: translateY(0); box-shadow: var(--shadow-sm); }
.btn {
  background: var(--neutral-bg);
  color: var(--neutral-fg);
}
.btn:hover { background: var(--neutral-hover); }
.btn:active { transform: translateY(1px); }
.btn-icon {
  background: transparent;
  color: var(--vscode-foreground);
  padding: 4px 6px;
  font-size: 14px;
  border-radius: var(--r-sm);
}
.btn-icon:hover { background: var(--neutral-hover); }
.btn-danger {
  background: transparent;
  color: var(--danger);
  border-color: var(--danger);
}
.btn-danger:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
.btn-primary:disabled, .btn:disabled, .btn-icon:disabled, .btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none !important;
  box-shadow: none !important;
}
.ico { font-weight: bold; }

/* ===========================================================================
 * Section labels — quieter, more refined
 * ========================================================================= */
.section-label {
  font-size: var(--fs-xs);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  margin-top: var(--sp-1);
  padding-left: 2px;
}

/* ===========================================================================
 * Chips — filled style, active uses accent gradient
 * ========================================================================= */
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.chip {
  border: 1px solid var(--card-border);
  background: var(--neutral-bg);
  color: var(--vscode-foreground);
  padding: 3px 10px;
  border-radius: var(--r-pill);
  cursor: pointer;
  font-size: var(--fs-sm);
  line-height: 1.5;
  font-family: inherit;
  transition: background var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease),
              color var(--dur-fast) var(--ease);
}
.chip:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.chip.active {
  background: linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 80%, black) 100%);
  border-color: transparent;
  color: var(--accent-fg);
  box-shadow: var(--shadow-sm);
}
.chip-sort { font-weight: 600; }

.count {
  font-size: var(--fs-sm);
  color: var(--muted);
  padding: 0 2px;
}

/* ===========================================================================
 * Account list & cards
 * ========================================================================= */
#list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--r-lg);
  padding: var(--sp-3) var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  transition: border-color var(--dur-base) var(--ease),
              background var(--dur-base) var(--ease),
              transform var(--dur-fast) var(--ease),
              box-shadow var(--dur-base) var(--ease);
}
.card:hover {
  border-color: var(--card-border-hover);
  background: var(--card-bg-hover);
  box-shadow: var(--shadow-sm);
}
.card-head {
  display: flex;
  gap: var(--sp-2);
  align-items: flex-start;
}
.card-title { flex: 1; min-width: 0; }
.email {
  font-weight: 600;
  font-size: var(--fs-lg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.005em;
}
.sub {
  font-size: var(--fs-sm);
  color: var(--muted);
  margin-top: 2px;
}
.remark {
  display: inline-block;
  margin-top: var(--sp-1);
  padding: 1px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  font-weight: 600;
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.remark:hover { background: var(--accent-soft-strong); }

/* ===========================================================================
 * Plan badge — high-contrast pill
 * ========================================================================= */
.plan-badge {
  padding: 2px 8px;
  border-radius: var(--r-pill);
  font-size: var(--fs-xs);
  font-weight: 700;
  background: var(--neutral-bg);
  color: var(--neutral-fg);
  white-space: nowrap;
  flex-shrink: 0;
  letter-spacing: 0.02em;
}
.plan-pro, .plan-teams {
  background: linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 78%, black) 100%);
  color: var(--accent-fg);
  box-shadow: var(--shadow-sm);
}
.plan-trial {
  background: color-mix(in srgb, var(--warn) 22%, transparent);
  color: var(--warn);
}
.plan-free { background: var(--neutral-bg); }

/* ===========================================================================
 * Quota progress bars — beefier with inner shadow + state gradients
 * ========================================================================= */
.quota-row {
  display: grid;
  grid-template-columns: 40px 1fr 40px;
  align-items: center;
  gap: var(--sp-2);
}
.quota-row + .quota-row { margin-top: var(--sp-1); }
.quota-label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--muted);
}
.progress {
  height: 7px;
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  border-radius: var(--r-pill);
  overflow: hidden;
  box-shadow: inset 0 1px 1px rgba(0,0,0,0.16);
}
.progress > .bar {
  height: 100%;
  background: linear-gradient(90deg, var(--success), color-mix(in srgb, var(--success) 70%, white));
  border-radius: var(--r-pill);
  transition: width 240ms var(--ease);
}
.bar.low {
  background: linear-gradient(90deg, var(--warn), color-mix(in srgb, var(--warn) 75%, white));
}
.bar.crit {
  background: linear-gradient(90deg, var(--danger), color-mix(in srgb, var(--danger) 75%, white));
}
.quota-value {
  font-size: var(--fs-sm);
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* "距下次重置" 行，与 progress bar 左缘对齐（跳过 label 列 + gap） */
.quota-reset {
  font-size: var(--fs-xs);
  color: var(--muted);
  text-align: left;
  font-variant-numeric: tabular-nums;
  padding-left: 48px;   /* 40px label column + 8px gap = progress start */
  margin-top: -2px;
  margin-bottom: 2px;
  letter-spacing: 0.01em;
}

/* ===========================================================================
 * Card footer / expiry / sync badges
 * ========================================================================= */
.card-foot {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.expiry-desc {
  font-size: var(--fs-sm);
  font-weight: 600;
}
.expiry-desc.danger { color: var(--danger); }
.expiry-desc.warn { color: var(--warn); }
.expiry-desc.ok { color: var(--success); }
.expiry-desc.muted { color: var(--muted); }
.sync-hint {
  font-size: var(--fs-xs);
  color: var(--warn);
  font-weight: 600;
}
.expiry-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  justify-content: space-between;
}
.sync-badge {
  font-size: var(--fs-xs);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  flex-shrink: 0;
  letter-spacing: 0.02em;
}
.sync-badge.ok {
  color: var(--success);
  border: 1px solid color-mix(in srgb, var(--success) 60%, transparent);
  background: color-mix(in srgb, var(--success) 10%, transparent);
}
.sync-badge.stale {
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 60%, transparent);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
}

.card-actions {
  display: flex;
  gap: var(--sp-1);
  flex-wrap: wrap;
  justify-content: flex-end;
}
.card-actions .btn, .card-actions .btn-primary, .card-actions .btn-danger {
  padding: 4px 10px;
  font-size: var(--fs-sm);
}

/* Square icon-only action button (.act modifier on .btn / .btn-primary / .btn-danger) */
.btn.act, .btn-primary.act, .btn-danger.act {
  width: 30px;
  height: 28px;
  padding: 0;
  justify-content: center;
  align-items: center;
  border-radius: var(--r-sm);
  position: relative;
}
.btn.act svg, .btn-primary.act svg, .btn-danger.act svg {
  display: block;
  flex-shrink: 0;
}
.btn-primary.act { box-shadow: var(--shadow-sm); }
.btn-primary.act:hover { transform: translateY(-1px); box-shadow: var(--shadow-md); }
.btn-primary.act:active { transform: translateY(0); }
.btn.act { color: var(--vscode-foreground); opacity: 0.85; }
.btn.act:hover { opacity: 1; }
.btn-danger.act { opacity: 0.85; }
.btn-danger.act:hover { opacity: 1; }

/* Custom tooltip — hover a button with [data-tip] and get an instant, themed
 * popover above it. Much snappier than the native title tooltip on webview. */
.act[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%) translateY(2px);
  background: var(--vscode-editorHoverWidget-background, var(--card-bg));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--card-border));
  padding: 4px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  box-shadow: var(--shadow-md);
  z-index: 100;
  transition: opacity var(--dur-fast) var(--ease),
              transform var(--dur-fast) var(--ease);
}
.act[data-tip]:hover::after {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
  transition-delay: 120ms;
}
/* Last buttons in a row would have their tooltip clipped by the sidebar's
 * right edge; nudge them to align to the right instead of center. */
.card-actions .act[data-tip]:last-child::after,
.card-actions .act[data-tip]:nth-last-child(2)::after {
  left: auto;
  right: 0;
  transform: translateY(2px);
}
.card-actions .act[data-tip]:last-child:hover::after,
.card-actions .act[data-tip]:nth-last-child(2):hover::after {
  transform: translateY(0);
}

/* ===========================================================================
 * Empty / loading states — friendlier
 * ========================================================================= */
.empty {
  padding: var(--sp-6) var(--sp-4);
  text-align: center;
  color: var(--muted);
  font-size: var(--fs-md);
  border: 1px dashed var(--card-border);
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--card-bg) 60%, transparent);
}
.empty .cta {
  display: inline-block;
  margin-top: var(--sp-2);
  padding: 6px 14px;
  border-radius: var(--r-sm);
  background: var(--accent-bg);
  color: var(--accent-fg);
  cursor: pointer;
  font-weight: 600;
  transition: background var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.empty .cta:hover { background: var(--accent-hover); transform: translateY(-1px); }

/* ===========================================================================
 * Status sticky bar — clear separation from list
 * ========================================================================= */
.status {
  position: sticky;
  top: 0;
  padding: 6px var(--sp-2);
  font-size: var(--fs-sm);
  border-radius: var(--r-md);
  border: 1px solid var(--card-border);
  background: var(--card-bg);
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(6px);
  z-index: 10;
}
.status.info { color: var(--muted); }
.status.success { color: var(--success); border-color: color-mix(in srgb, var(--success) 60%, transparent); }
.status.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 60%, transparent); }
.status.error { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 60%, transparent); }
.loading-dot::after {
  content: ' …';
  animation: blink 1.2s var(--ease) infinite;
}
@keyframes blink { 50% { opacity: 0.3; } }

/* ===========================================================================
 * Modal overlay (add account / batch import / show credentials)
 * — Backdrop blur (where supported), elevated card with smooth entrance.
 * HTML [hidden] must beat .modal-overlay{display:flex} / .modal-card{display:flex}
 * ========================================================================= */
[hidden] { display: none !important; }
.modal-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, black 55%, transparent);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--sp-5) var(--sp-2);
  z-index: 50;
  overflow-y: auto;
  animation: overlay-in var(--dur-base) var(--ease);
}
@keyframes overlay-in { from { opacity: 0; } to { opacity: 1; } }
.modal-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--r-lg);
  padding: var(--sp-3) var(--sp-3);
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  box-shadow: var(--shadow-lg);
  animation: card-in var(--dur-base) var(--ease);
}
@keyframes card-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.modal-title {
  font-weight: 700;
  font-size: var(--fs-lg);
  padding-bottom: var(--sp-1);
  border-bottom: 1px solid var(--card-border);
  letter-spacing: -0.005em;
}
.modal-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.modal-field label {
  font-size: var(--fs-sm);
  color: var(--muted);
  font-weight: 500;
}
.modal-field input,
.modal-card textarea {
  font-family: inherit;
  font-size: var(--fs-md);
  padding: 6px 9px;
  border: 1px solid var(--vscode-input-border, var(--card-border));
  border-radius: var(--r-sm);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease),
              box-shadow var(--dur-fast) var(--ease);
}
.modal-field input:focus,
.modal-card textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.modal-card textarea {
  resize: vertical;
  min-height: 140px;
  font-family: var(--vscode-editor-font-family, monospace);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-1);
  padding-top: var(--sp-1);
}
.modal-error {
  color: var(--danger);
  font-size: var(--fs-sm);
  word-break: break-word;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
}
.modal-hint {
  font-size: var(--fs-sm);
  color: var(--muted);
  line-height: 1.55;
}
.modal-hint code {
  background: var(--neutral-bg);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: var(--fs-xs);
  font-family: var(--vscode-editor-font-family, monospace);
}
.modal-format-group {
  margin-top: 10px;
}
.modal-format-title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--vscode-foreground);
  margin-bottom: 4px;
}
.modal-format-desc {
  font-size: var(--fs-xs);
  color: var(--muted);
  margin-bottom: 4px;
  line-height: 1.5;
}
.modal-format-example {
  margin: 0;
  padding: 6px 9px;
  background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--vscode-foreground);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}
.modal-format-hint-tail {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--card-border);
  font-size: var(--fs-xs);
  color: var(--muted);
}
.modal-preview {
  font-size: var(--fs-sm);
  color: var(--muted);
  font-weight: 600;
}
.modal-preview.has {
  color: var(--success);
}
.modal-creds-actions {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.modal-creds-actions .btn,
.modal-creds-actions .btn-primary {
  justify-content: center;
  padding: 7px 12px;
  font-size: var(--fs-md);
}

/* ===========================================================================
 * Top-level collapsible section header
 *   • caret: pure character swap, NO rotation animation (avoids the off-axis
 *     rotation glitch that misaligns the glyph against the label).
 * ========================================================================= */
.section-head {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-2) var(--sp-1) var(--sp-1) var(--sp-1);
  cursor: pointer;
  user-select: none;
  border-radius: var(--r-sm);
  transition: background var(--dur-fast) var(--ease);
}
.section-head:hover { background: var(--neutral-bg); }
.section-head .section-label {
  margin-top: 0;
  font-size: var(--fs-xs);
  font-weight: 700;
  color: var(--vscode-foreground);
  opacity: 0.78;
}
.section-head .caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  font-size: 9px;
  line-height: 1;
  color: var(--muted);
}
.section-head .caret::before { content: '▾'; }
.section-head.collapsed .caret::before { content: '▸'; }
.section-body.collapsed {
  display: none;
}

/* ===========================================================================
 * Current account — visually elevated above the list
 * ========================================================================= */
#current-account {
  margin-bottom: var(--sp-2);
}
#current-account .card {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--card-border));
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--accent) 6%, var(--card-bg)) 0%,
    var(--card-bg) 100%);
  box-shadow: var(--shadow-sm);
}
#current-account .card:hover {
  border-color: color-mix(in srgb, var(--accent) 70%, var(--card-border));
  box-shadow: var(--shadow-md);
}
#current-account .card.placeholder {
  opacity: 0.7;
  background: var(--card-bg);
  border-style: dashed;
  border-color: var(--card-border);
}

/* ===========================================================================
 * Auto-switch — 面板内容的 row / label / select / 小提示样式。
 * 面板自己的外容器 (.auto-menu) 在下面 Toolbar dropdown 小节里。
 * ========================================================================= */
.auto-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
  flex-wrap: wrap;
  padding: 2px var(--sp-1);
}
.auto-row label {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  cursor: pointer;
}
.auto-row input[type="checkbox"] {
  accent-color: var(--accent);
}
.auto-row select {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  padding: 3px 8px;
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease);
}
.auto-row select:hover { border-color: var(--accent); }
.auto-row select:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 2px var(--accent-soft); }
.auto-hint {
  font-size: var(--fs-xs);
  color: var(--muted);
  padding-left: 18px;
  opacity: 0.85;
}
/* 自动切号 dropdown 面板：宽度足够容下最长 label（"监听日志即时切号"8 字）+ select */
.auto-menu {
  min-width: 230px;
  max-width: 280px;
  padding: 6px;
}
.auto-menu .auto-row {
  padding: 4px 6px;
  flex-wrap: nowrap; /* 确保 checkbox + label + select 一行排下 */
  gap: 8px;
}
/* label 自适应宽度，但内部文字绝不换行 */
.auto-menu .auto-row label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
}
.auto-menu .auto-row label span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* select 固定宽度，防止它按内容变宽压缩 label */
.auto-menu .auto-row select {
  flex: 0 0 auto;
  width: 82px;
}
/* 阈值数字输入框 + % 后缀的组合容器，整体宽度和其他 select 对齐 */
.auto-menu .auto-row .threshold-input {
  flex: 0 0 auto;
  width: 82px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.auto-menu .auto-row input[data-auto-threshold] {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--card-border);
  border-radius: var(--r-sm);
  padding: 3px 6px;
  font-size: var(--fs-sm);
  font-family: inherit;
  text-align: right;
  transition: border-color var(--dur-fast) var(--ease);
}
.auto-menu .auto-row input[data-auto-threshold]:hover {
  border-color: var(--accent);
}
.auto-menu .auto-row input[data-auto-threshold]:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.auto-menu .auto-row input[data-auto-threshold]:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.auto-menu .auto-row .threshold-suffix {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: var(--fs-sm);
  pointer-events: none;
}

/* ---- Toolbar里的 .btn.dropdown-trigger —— 执行 .btn 实色样式，而非 chip outline --- */
/* 用更高特异性覆盖 .dropdown-trigger 的默认样式，让 toolbar 按钮家族度统一。 */
.toolbar .btn.dropdown-trigger {
  /* 重置为 .btn 样式（与「批量导入」「刷新全部」完全一样） */
  background: var(--neutral-bg);
  color: var(--neutral-fg);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 4px 10px;
  font-size: var(--fs-md);
  font-weight: 500;
  line-height: 1.4;
  gap: var(--sp-1);
  white-space: nowrap;
}
.toolbar .btn.dropdown-trigger:hover {
  background: var(--neutral-hover);
  border-color: transparent;
  transform: none;
}
.toolbar .btn.dropdown-trigger:active {
  transform: translateY(1px);
}
/* 打开面板时 —— 类似 "鼠标悬停" 的往下压感 */
.toolbar .dropdown.open .btn.dropdown-trigger {
  background: var(--neutral-hover);
  border-color: transparent;
}
/* 启用状态 —— 图标变 accent 色，文字和按钮视觉保持中性（不抟眼） */
.toolbar .btn.dropdown-trigger.active .auto-ico {
  color: var(--accent);
}
/* 左边图标固定样式 */
.auto-ico {
  display: inline-flex;
  align-items: center;
  color: var(--neutral-fg);
  opacity: 0.9;
  transition: color var(--dur-fast) var(--ease);
}
/* 后缀小圆点：表示「有自动切号开关开启中」。不用数字徽章，更低调。 */
.auto-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  margin-left: 2px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
}

/* ===========================================================================
 * List header — count + sort/filter dropdowns on the same row.
 * ========================================================================= */
.list-header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-1) var(--sp-1) var(--sp-1);
}
.list-header .count { flex: 0 0 auto; margin: 0; padding: 0; }
.list-header-controls {
  flex: 1 1 auto;
  display: flex;
  gap: var(--sp-1);
  justify-content: flex-end;
  flex-wrap: wrap;
}

/* ---- Generic dropdown (trigger + floating menu) ------------------------- */
.dropdown { position: relative; }
.dropdown-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 8px;
  background: var(--card-bg);
  color: var(--vscode-foreground);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  font-size: var(--fs-xs);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  white-space: nowrap;
  user-select: none;
}
.dropdown-trigger:hover { background: var(--neutral-bg); border-color: var(--accent); }
.dropdown-trigger.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--card-bg)); }
.dropdown-ico { display: inline-flex; opacity: 0.75; }
.dropdown-ico svg { display: block; }
.dropdown-label { font-weight: 500; }
.dropdown-caret {
  font-size: 10px;
  opacity: 0.65;
  transition: transform var(--dur-fast) var(--ease);
}
.dropdown.open .dropdown-caret { transform: rotate(180deg); }
.dropdown-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  margin-left: 2px;
  background: var(--accent);
  color: white;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}
.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  max-width: 240px;
  padding: 4px;
  background: var(--vscode-editorHoverWidget-background, var(--card-bg));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--card-border));
  border-radius: var(--r-md);
  box-shadow: var(--shadow-lg, var(--shadow-md));
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: dd-in var(--dur-fast) var(--ease);
}
@keyframes dd-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.dropdown-option,
.dropdown-check {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: transparent;
  color: var(--vscode-foreground);
  border: 0;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  user-select: none;
}
.dropdown-option:hover,
.dropdown-check:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.dropdown-option.active {
  color: var(--accent);
  font-weight: 600;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.dropdown-option.active::before {
  content: '✓';
  margin-right: 2px;
  font-size: 11px;
}
.dropdown-check input[type="checkbox"] {
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.dropdown-check span { flex: 1 1 auto; }

/* ===========================================================================
 * Scrollbar (webview lives in webkit) — slimmer, theme-aware
 * ========================================================================= */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border-radius: var(--r-pill);
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 32%, transparent);
}

/* ===========================================================================
 * Reduced motion — respect user accessibility preference
 * ========================================================================= */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
// ---------------------------------------------------------------------------
// JS - rendered inside the webview, talks back via acquireVsCodeApi()
// ---------------------------------------------------------------------------
const JS = /* javascript */ `
(function () {
    const vscode = acquireVsCodeApi();
    const prev = vscode.getState() || {};

    const state = {
        loading: true,
        accounts: [],
        error: undefined,
        sort: prev.sort || { mode: 'expiry', dir: 'asc' },
        // Only Trial include remains; Yahoo/Free/Grace chips were removed.
        // Old persisted state may still have those keys — harmless, we just
        // ignore them in passesFilter.
        filters: (() => {
            const merged = Object.assign({
                trial: false,
                'exclude-no-quota': false,
                'exclude-today-unavailable': false
            }, prev.filters || {});
            // Filters whose UI was removed → force off so users aren’t left with
            // a hidden filter quietly hiding accounts.
            merged['exclude-yahoo'] = false;
            merged['exclude-free'] = false;
            return merged;
        })(),
        currentAccountId: null,
        activeEmail: null,
        smartHistory: {},
        auto: {
            polling: { enabled: false, intervalMs: 120000 },
            logWatch: { enabled: false, patterns: [] }
        },
        ui: {
            sortCollapsed: true,
            filterCollapsed: true
        }
    };

    // ---- inline SVG icons (currentColor → theme-friendly) -----------------
    const ICONS = {
        // arrow-swap (switch to this account)
        switch: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5h10.5M11 3l2 2-2 2M13.5 11H3M5 9l-2 2 2 2"/></svg>',
        // zap / lightning (smart switch)
        smartSwitch: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M9.2 1L3 9h4l-1 6 6.2-8H8l1.2-6z"/></svg>',
        // refresh
        refresh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>',
        // clock with back arrow (reset cooldown)
        resetCooldown: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8.5" r="5.2"/><path d="M8 5.5V8.5l2 1.3"/><path d="M3.4 5h2.5M3.4 5V2.5"/></svg>',
        // wrench (fix credentials)
        fixCredentials: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11.6 1.5a3.5 3.5 0 0 0-3.4 4.4L1.6 12.5l1.9 1.9 6.6-6.6a3.5 3.5 0 1 0 1.5-6.3zm0 5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
        // key (show credentials)
        credentials: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="10.5" r="2.7"/><path d="M7.5 8.5l5.5-5.5M11 7l2-2M13 5l1-1"/></svg>',
        // tag (edit remark)
        editRemark: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 8.5V2.5h6l6 6-6 6-6-6z"/><circle cx="5" cy="5.5" r="1" fill="currentColor" stroke="none"/></svg>',
        // trash (delete)
        delete: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V2.5h4V4M5 4l.7 9.5h4.6L11 4M7 7v4M9 7v4"/></svg>'
    };

    const $ = sel => document.querySelector(sel);
    const listEl = $('#list');
    const countEl = $('#count');
    const statusEl = $('#status-bar');
    const currentEl = $('#current-account');

    /** Set when the user clicks "刷新" on a specific card, so the next render
     *  scrolls that card back into view.  Other renders simply restore the
     *  previous scrollTop (no jump-to-top behaviour).
     */
    let scrollToIdAfterRender = null;

    function persist() {
        vscode.setState({ sort: state.sort, filters: state.filters });
    }

    function post(cmd, extra) {
        vscode.postMessage(Object.assign({ cmd }, extra || {}));
    }

    // ---------- classification helpers ------------------------------------
    // yahoo.com / yahoo.co.jp / yahoo.com.tw / yahoo.co.uk 等全部算雅虎
    function isYahoo(a) { return /@yahoo\.[a-z.]+$/i.test(a.email || ''); }
    function isFree(a) { return (a.planName || '').toLowerCase() === 'free'; }
    function isTrial(a) { return (a.planName || '').toLowerCase() === 'trial'; }
    function hasDailyQuota(a) { return (a.dailyRemainPct || 0) > 0; }
    function hasWeeklyQuota(a) { return (a.weeklyRemainPct || 0) > 0; }
    function parseExpiry(a) {
        // Free 账号没有真正的订阅到期 —— Windsurf plan API 对 Free 返回的
        // planEnd 实际是下一个月度计费周期重置（~30 天后），原样当作
        // 「到期时间」会误显示为「30 天后到期」。试用结束降级到 Free 时
        // 这个 bug 最明显。统一返回 null：排序时沉底，fmtExpiry 走专门
        // 的「免费版」分支。Trial / Pro / Teams 不受影响。
        if (isFree(a)) return null;
        if (!a.expiresAt) return null;
        const t = Date.parse(a.expiresAt);
        return Number.isFinite(t) ? t : null;
    }
    function isGracePeriod(a) {
        // 优先看后端直接给的 gracePeriodStatus，没有再用日期推算。
        const s = (a.gracePeriodStatus || '').toLowerCase();
        if (s && s !== 'none' && s !== 'inactive' && s !== 'n/a') {
            return true;
        }
        const exp = parseExpiry(a);
        if (!exp) return false;
        if (exp - Date.now() > 0) return false;
        // fallback：已过期 < 30 天 当宽限期
        return (Date.now() - exp) < 30 * 24 * 3600e3;
    }
    // ---------- quota score ------------------------------------------------
    // Windsurf rules: daily resets 16:00; weekly resets Sun 16:00.
    //   - daily == 0 → today unusable
    //   - weekly == 0 → whole week locked
    //   - So "usable today" = min(daily, weekly).
    // 查询失败时 (quotaError=true) 仍使用历史数据，UI 靠「未同步」徽章提示。
    // 只有从未查询过的账号（两字段均为 null）才 -1 沉底。
    function quotaScore(a) {
        if (a.dailyRemainPct == null && a.weeklyRemainPct == null) return -1;
        return Math.min(a.dailyRemainPct || 0, a.weeklyRemainPct || 0);
    }

    // ---------- filter / sort ---------------------------------------------
    function passesFilter(a) {
        const f = state.filters;
        // Trial 是唯一保留的 include chip
        if (f.trial && !isTrial(a)) return false;
        // 从未查询过的账号 (daily & weekly 均 null) 不参与额度类排除，
        // 避免新导入 / 刚创建的账号被误筛。
        const neverQueried = a.dailyRemainPct == null && a.weeklyRemainPct == null;
        if (f['exclude-yahoo'] && isYahoo(a)) return false;
        if (f['exclude-no-quota'] && !neverQueried && !hasWeeklyQuota(a)) return false;
        if (f['exclude-free'] && isFree(a)) return false;
        if (f['exclude-today-unavailable'] && !neverQueried && (!hasDailyQuota(a) || !hasWeeklyQuota(a))) return false;
        return true;
    }
    function sortAccounts(list) {
        const mode = state.sort.mode;
        const asc = state.sort.dir === 'asc';
        const mult = asc ? 1 : -1;
        const byEmail = (a, b) => (a.email || '').localeCompare(b.email || '');
        if (mode === 'quota') {
            return list.slice().sort((a, b) => {
                const d = quotaScore(a) - quotaScore(b);
                return d ? d * mult : byEmail(a, b);
            });
        }
        // default: expiry — 到期未知的账号始终沉底（不论 asc / desc）。
        return list.slice().sort((a, b) => {
            const ea = parseExpiry(a);
            const eb = parseExpiry(b);
            if (ea == null && eb == null) return byEmail(a, b);
            if (ea == null) return 1;   // a 沉底
            if (eb == null) return -1;  // b 沉底
            if (ea !== eb) return (ea - eb) * mult;
            return byEmail(a, b);
        });
    }

    // ---------- formatting ------------------------------------------------
    function fmtExpiry(a) {
        // Free：parseExpiry 已返回 null（见上面注释）。这里直接给确定文案，
        // 避免和「到期未知」混淆 —— 「免费版」是一个稳定状态，不是数据缺失。
        if (isFree(a)) return { exact: '免费版', desc: '免费版', tone: 'muted' };
        const t = parseExpiry(a);
        if (!t) return { exact: '到期未知', desc: '到期未知', tone: 'muted' };
        const delta = t - Date.now();
        const exact = new Date(t).toLocaleString();
        if (delta <= 0) {
            const daysAgo = Math.floor(-delta / (24 * 3600e3));
            return { exact, desc: '已到期 ' + daysAgo + ' 天', tone: 'danger' };
        }
        const days = Math.floor(delta / (24 * 3600e3));
        const hours = Math.floor((delta % (24 * 3600e3)) / 3600e3);
        if (days > 7) {
            return { exact, desc: days + ' 天后到期', tone: 'ok' };
        }
        if (days > 0) {
            return { exact, desc: days + ' 天 ' + hours + ' 小时后到期', tone: 'warn' };
        }
        return { exact, desc: hours + ' 小时后到期', tone: 'danger' };
    }
    function fmtPct(pct) {
        if (pct == null) return '-';
        return Math.max(0, Math.min(100, pct | 0)) + '%';
    }
    function barClass(pct) {
        // remaining quota → colour band. Smooth transition: 绿 → 黄 → 红
        if (pct == null) return 'crit';
        if (pct <= 20) return 'crit';   // 红：余量告急
        if (pct <= 60) return 'low';    // 黄：警告
        return '';                       // 绿（默认 .bar gradient）
    }
    /** Human readable "distance to next reset + exact timestamp".
     *  e.g. "1h 27m · 05/02 15:07", "2d 3h · 05/05 16:12", "已刷新 · 05/02 11:30". */
    function fmtReset(unixSec) {
        if (!unixSec) return '';
        const t = unixSec * 1000;
        const d = new Date(t);
        const pad = n => String(n).padStart(2, '0');
        const exact = pad(d.getMonth() + 1) + '/' + pad(d.getDate())
            + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        const delta = t - Date.now();
        if (delta <= 0) return '已刷新 · ' + exact;
        const totalMin = Math.floor(delta / 60000);
        const days = Math.floor(totalMin / 1440);
        const hours = Math.floor((totalMin % 1440) / 60);
        const mins = totalMin % 60;
        let rel;
        if (days > 0) rel = days + 'd ' + hours + 'h';
        else if (hours > 0) rel = hours + 'h ' + mins + 'm';
        else rel = mins + 'm';
        return rel + ' · ' + exact;
    }
    function syncState(a) {
        if (a.quotaError) return 'stale';
        if (!a.lastQueryTime) return 'stale';
        return 'synced';
    }
    function planClass(planName) {
        const p = (planName || '').toLowerCase();
        if (p === 'pro' || p === 'teams' || p === 'team') return 'plan-pro';
        if (p === 'trial') return 'plan-trial';
        return 'plan-free';
    }

    // ---------- render ----------------------------------------------------
    function applyCollapseUi() {
        // 排序方式 / 筛选账号 两个 section 的折叠状态
        const sortHead = document.querySelector('.section-head[data-collapse="sort"]');
        const filterHead = document.querySelector('.section-head[data-collapse="filter"]');
        const sortBody = document.querySelector('.section-body[data-body="sort"]');
        const filterBody = document.querySelector('.section-body[data-body="filter"]');
        if (sortHead) sortHead.classList.toggle('collapsed', !!state.ui.sortCollapsed);
        if (filterHead) filterHead.classList.toggle('collapsed', !!state.ui.filterCollapsed);
        if (sortBody) sortBody.classList.toggle('collapsed', !!state.ui.sortCollapsed);
        if (filterBody) filterBody.classList.toggle('collapsed', !!state.ui.filterCollapsed);
    }

    function render() {
        // Sort dropdown: trigger label + option active state
        const sortLabel = (mode, dir) => {
            const base = mode === 'expiry' ? '按到期时间' : '按可用额度';
            return base + ' ' + (dir === 'asc' ? '↑' : '↓');
        };
        const sortLabelEl = document.getElementById('sort-label');
        if (sortLabelEl) sortLabelEl.textContent = sortLabel(state.sort.mode, state.sort.dir);
        document.querySelectorAll('#sort-menu .dropdown-option').forEach(opt => {
            const mode = opt.dataset.sort;
            const isActive = mode === state.sort.mode;
            opt.classList.toggle('active', isActive);
            const base = mode === 'expiry' ? '按到期时间' : '按可用额度';
            opt.textContent = isActive ? base + ' ' + (state.sort.dir === 'asc' ? '↑' : '↓') : base;
        });
        // Filter dropdown: checkboxes reflect state, trigger shows count badge.
        let filterCount = 0;
        document.querySelectorAll('#filter-menu .dropdown-check input').forEach(cb => {
            const key = cb.dataset.filter;
            cb.checked = !!state.filters[key];
            if (cb.checked) filterCount++;
        });
        const filterLabelEl = document.getElementById('filter-label');
        const filterTriggerEl = document.querySelector('[data-dd-trigger="filter"]');
        if (filterLabelEl) {
            filterLabelEl.innerHTML = filterCount > 0
                ? '筛选<span class="dropdown-badge">' + filterCount + '</span>'
                : '筛选';
        }
        if (filterTriggerEl) filterTriggerEl.classList.toggle('active', filterCount > 0);

        applyCollapseUi();

        // Render the "current account" card and the standalone 自动切号 toggles.
        renderCurrent();
        renderAutoOptions();

        // count + list
        if (state.loading) {
            countEl.innerHTML = '<span class="loading-dot">加载中</span>';
            listEl.innerHTML = '';
            return;
        }
        if (state.error) {
            countEl.textContent = '加载失败';
            listEl.innerHTML = '<div class="empty" style="color:var(--danger)">' + escapeHtml(state.error) + '</div>';
            return;
        }

        const filtered = state.accounts.filter(passesFilter);
        const sorted = sortAccounts(filtered);
        const total = state.accounts.length;
        const anyFilter = Object.values(state.filters).some(Boolean);
        countEl.textContent = anyFilter
            ? sorted.length + '/' + total + ' 个账号'
            : total + ' 个账号';

        // Preserve scroll position across reloads. Target a specific card if
        // we just refreshed it (so user can see the updated values).
        const prevScroll = listEl.scrollTop;

        if (total === 0) {
            listEl.innerHTML = '<div class="empty">还没有账号。<br><span class="cta" data-cmd="addAccount">添加账号</span></div>';
        } else if (sorted.length === 0) {
            listEl.innerHTML = '<div class="empty">当前筛选条件下没有账号。</div>';
        } else {
            listEl.innerHTML = sorted.map(a => renderCard(a, 'list')).join('');
        }

        if (scrollToIdAfterRender) {
            const target = listEl.querySelector('[data-id="' + cssEscape(scrollToIdAfterRender) + '"]');
            scrollToIdAfterRender = null;
            if (target && typeof target.scrollIntoView === 'function') {
                target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                listEl.scrollTop = prevScroll;
            }
        } else {
            listEl.scrollTop = prevScroll;
        }

        // Report the filtered+sorted id list back to the extension so smart
        // switch (manual + auto) operates on the exact set the user sees.
        post('candidateIds', { ids: sorted.map(a => a.id) });
    }

    /** Minimal CSS.escape polyfill for id attribute selectors. */
    function cssEscape(s) {
        return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\\\' + c.charCodeAt(0).toString(16) + ' ');
    }

    function renderCard(a, mode) {
        mode = mode || 'list';
        const expiry = fmtExpiry(a);
        const daily = fmtPct(a.dailyRemainPct);
        const weekly = fmtPct(a.weeklyRemainPct);
        const dailyBar = Math.max(0, Math.min(100, a.dailyRemainPct || 0));
        const weeklyBar = Math.max(0, Math.min(100, a.weeklyRemainPct || 0));
        const remark = (a.remark || '').trim();
        const lastQ = a.lastQueryTime ? '· 更新于 ' + new Date(a.lastQueryTime).toLocaleString() : '';
        // Tell the user WHY the switch button is disabled, not just that it is.
        // Legacy accounts (pre-v0.4) have an empty authProvider which we treat
        // as firebase.
        const provider = (a.authProvider || 'firebase').toLowerCase();
        let switchDisableReason = '';
        if (!a.hasCredentials) {
            switchDisableReason = '账号缺少任何凭据（密码 / idToken / refreshToken 都为空）。请先删除再用 \`添加账号\` 重新导入。';
        } else if (provider !== 'firebase' && provider !== 'auth1') {
            switchDisableReason = '未识别的登录方式 "' + provider + '"。扩展当前仅支持 firebase 与 auth1。';
        }
        const switchable = !switchDisableReason;
        return \`
<div class="card" data-id="\${escapeAttr(a.id)}">
  <div class="card-head">
    <div class="card-title">
      <div class="email" title="\${escapeAttr(a.email)}">\${escapeHtml(a.email)}</div>
      \${remark ? '<div class="remark" data-cmd="editRemark" title="点击编辑备注">📝 ' + escapeHtml(remark) + '</div>' : ''}
    </div>
    <div class="plan-badge \${planClass(a.planName)}">\${escapeHtml(a.planName || '-')}</div>
  </div>
  <div class="quota">
    <div class="quota-row">
      <div class="quota-label">日额度</div>
      <div class="progress"><div class="bar \${barClass(a.dailyRemainPct)}" style="width:\${dailyBar}%"></div></div>
      <div class="quota-value">\${daily}</div>
    </div>
    \${a.dailyResetUnix ? '<div class="quota-reset">重置 ' + escapeHtml(fmtReset(a.dailyResetUnix)) + '</div>' : ''}
    <div class="quota-row">
      <div class="quota-label">周额度</div>
      <div class="progress"><div class="bar \${barClass(a.weeklyRemainPct)}" style="width:\${weeklyBar}%"></div></div>
      <div class="quota-value">\${weekly}</div>
    </div>
    \${a.weeklyResetUnix ? '<div class="quota-reset">重置 ' + escapeHtml(fmtReset(a.weeklyResetUnix)) + '</div>' : ''}
  </div>
  <div class="card-foot">
    <div class="expiry-row">
      <span class="expiry-desc \${expiry.tone}">\${escapeHtml(expiry.desc)}</span>
    </div>
    <div class="card-actions">
      \${mode === 'current'
        ? '<button class="btn act" data-cmd="smartSwitch" data-current data-tip="智能切号">' + ICONS.smartSwitch + '</button>'
          + '<button class="btn act" data-cmd="refreshCurrent" data-current data-tip="刷新 Plan / 额度">' + ICONS.refresh + '</button>'
          + '<button class="btn act" data-cmd="resetCooldown" data-current data-tip="重置切号冷却">' + ICONS.resetCooldown + '</button>'
        : '<button class="btn act" data-cmd="switch"' + (switchable ? ' data-tip="切换到该账号"' : ' disabled data-tip="' + escapeAttr(switchDisableReason) + '"') + '>' + ICONS.switch + '</button>'
          + '<button class="btn act" data-cmd="refresh" data-tip="刷新 Plan / 额度">' + ICONS.refresh + '</button>'
          + (a.hasCredentials ? '' : '<button class="btn act" data-cmd="fixCredentials" data-tip="补充密码并重登">' + ICONS.fixCredentials + '</button>')
          + '<button class="btn act" data-cmd="credentials" data-tip="复制 账号+密码">' + ICONS.credentials + '</button>'
          + '<button class="btn act" data-cmd="editRemark" data-tip="编辑备注">' + ICONS.editRemark + '</button>'
          + '<button class="btn-danger act" data-cmd="delete" data-tip="删除账号">' + ICONS.delete + '</button>'}
    </div>
  </div>
</div>
        \`;
    }

    // ---------- current account section -----------------------------------
    /** Render only the inner <auto-row>s. The outer <section-head> + <section-body>
     *  containers live in static HTML; this fills #auto-options with the two
     *  toggle rows whose checked/value/disabled need to reflect state. */
    function renderAutoOptions() {
        const optionsEl = document.querySelector('#auto-options');
        if (!optionsEl) return;
        const p = state.auto.polling || {};
        const l = state.auto.logWatch || {};
        const intervalMs = p.intervalMs | 0;
        const intervals = [
            { label: '30 秒', ms: 30000 },
            { label: '1 分钟', ms: 60000 },
            { label: '2 分钟', ms: 120000 },
            { label: '5 分钟', ms: 300000 },
            { label: '10 分钟', ms: 600000 }
        ];
        const options = intervals.map(i =>
            '<option value="' + i.ms + '"' + (i.ms === intervalMs ? ' selected' : '') + '>' + i.label + '</option>'
        ).join('');
        // 额度阈值：直接输入数字，配一个 % 后缀。输入在 blur 时生效。
        //   不断设实候选在 0-99 之间（>=100 无意义，软顾下 max="99"）
        const threshold = state.auto.lowQuotaThreshold | 0;
        const thresholdEnabled = !!state.auto.lowQuotaThresholdEnabled;
        optionsEl.innerHTML = \`
<div class="auto-row">
  <label>
    <input type="checkbox" data-auto-toggle="polling" \${p.enabled ? 'checked' : ''} />
    <span>账号刷新</span>
  </label>
  <select data-auto-interval \${p.enabled ? '' : 'disabled'}>\${options}</select>
</div>
<div class="auto-row">
  <label>
    <input type="checkbox" data-auto-toggle="threshold" \${thresholdEnabled ? 'checked' : ''} />
    <span>触发阈值</span>
  </label>
  <div class="threshold-input">
    <input type="text" data-auto-threshold inputmode="numeric" pattern="[0-9]*" maxlength="2" value="\${threshold}" \${thresholdEnabled ? '' : 'disabled'} />
    <span class="threshold-suffix">%</span>
  </div>
</div>
<div class="auto-row">
  <label>
    <input type="checkbox" data-auto-toggle="logWatch" \${l.enabled ? 'checked' : ''} />
    <span>监听日志即时切号</span>
  </label>
</div>\`;
        // 同步更新 toolbar 「自动」按钮的状态：
        //   有任一开关开启 → 显示小圆点 + 图标变 accent 色
        //   都没开         → 圆点隐藏、按钮保持中性
        const hasActive = !!(p.enabled || l.enabled);
        const dot = document.querySelector('#auto-dot');
        const trigger = document.querySelector('[data-dd-trigger="auto"]');
        if (dot) {
            dot.hidden = !hasActive;
        }
        if (trigger) {
            trigger.classList.toggle('active', hasActive);
        }
    }

    function renderCurrent() {
        const id = state.currentAccountId;
        const acc = id ? state.accounts.find(a => a.id === id) : null;

        if (!acc) {
            const email = (state.activeEmail || '').trim();
            const looksLikeEmail = /@/.test(email);
            const headLine = email
                ? (looksLikeEmail
                    ? '<div class="email" title="' + escapeAttr(email) + '">' + escapeHtml(email) + '</div>' +
                      '<div class="sub">⚠ 未在账号列表中 · 点击「刷新」尝试识别，或先把此账号导入</div>'
                    : '<div class="email" title="' + escapeAttr(email) + '">' + escapeHtml(email) + '</div>' +
                      '<div class="sub">⚠ 已检测到 Windsurf 当前登录显示名，但邮箱仍在同步中 · 点击「刷新」重试</div>')
                : '<div class="email">（尚未检测到当前账号）</div>' +
                  '<div class="sub">点击「刷新」从 Windsurf 读取当前登录状态</div>';
            currentEl.innerHTML =
                '<div class="card placeholder">' +
                '  <div class="card-head"><div class="card-title">' + headLine + '</div></div>' +
                '  <div class="card-foot">' +
                '    <div class="card-actions">' +
                '      <button class="btn act" data-cmd="smartSwitch" data-current title="智能切号">' + ICONS.smartSwitch + '</button>' +
                '      <button class="btn act" data-cmd="refreshCurrent" data-current title="刷新">' + ICONS.refresh + '</button>' +
                '      <button class="btn act" data-cmd="resetCooldown" data-current title="重置智能切号冷却">' + ICONS.resetCooldown + '</button>' +
                '    </div>' +
                '  </div>' +
                '</div>';
            return;
        }

        currentEl.innerHTML = renderCard(acc, 'current');
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
    function escapeAttr(s) {
        return escapeHtml(s).replace(/"/g, '&quot;');
    }

    // ---------- modal overlay (add account / batch import / creds) -------
    const overlayEl = document.getElementById('modal-overlay');
    const addCardEl = document.getElementById('modal-add');
    const batchCardEl = document.getElementById('modal-batch');
    const credsCardEl = document.getElementById('modal-creds');
    const credsEmailEl = document.getElementById('modal-creds-email');
    const credsHintEl = document.getElementById('modal-creds-hint');
    const addEmailEl = document.getElementById('modal-add-email');
    const addPwdEl = document.getElementById('modal-add-password');
    const addErrorEl = document.getElementById('modal-add-error');
    const addSubmitEl = document.getElementById('modal-add-submit');
    const batchTextEl = document.getElementById('modal-batch-text');
    const batchPreviewEl = document.getElementById('modal-batch-preview');
    const batchSubmitEl = document.getElementById('modal-batch-submit');

    let currentModal = null; // 'add' | 'batch' | 'creds' | null
    let credsTarget = null;  // { id, email } for the creds modal
    let addSubmitting = false;
    let previewTimer = null;

    function setAddBusy(busy) {
        addSubmitting = busy;
        addSubmitEl.disabled = busy;
        addEmailEl.disabled = busy;
        addPwdEl.disabled = busy;
        addSubmitEl.textContent = busy ? '添加中…' : '添加';
    }

    function openModal(kind, opts) {
        currentModal = kind;
        overlayEl.hidden = false;
        addCardEl.hidden = kind !== 'add';
        batchCardEl.hidden = kind !== 'batch';
        credsCardEl.hidden = kind !== 'creds';
        if (kind === 'add') {
            addEmailEl.value = '';
            addPwdEl.value = '';
            addErrorEl.hidden = true;
            addErrorEl.textContent = '';
            setAddBusy(false);
            setTimeout(() => addEmailEl.focus(), 0);
        } else if (kind === 'batch') {
            batchTextEl.value = '';
            batchPreviewEl.textContent = '已识别 0 个账号';
            batchPreviewEl.classList.remove('has');
            batchSubmitEl.disabled = true;
            batchSubmitEl.textContent = '开始导入';
            setTimeout(() => batchTextEl.focus(), 0);
        } else if (kind === 'creds') {
            credsTarget = opts && opts.id ? { id: opts.id, email: opts.email || '' } : null;
            credsEmailEl.textContent = (opts && opts.email) || '';
            credsHintEl.textContent = '点击按钮后内容将复制到剪贴板。';
            credsHintEl.classList.remove('error');
        }
    }

    function closeModal() {
        currentModal = null;
        credsTarget = null;
        overlayEl.hidden = true;
        addCardEl.hidden = true;
        batchCardEl.hidden = true;
        credsCardEl.hidden = true;
        addSubmitting = false;
    }

    function requestPreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            post('previewBatch', { text: batchTextEl.value });
        }, 120);
    }

    function submitAdd() {
        if (addSubmitting) return;
        const email = (addEmailEl.value || '').trim();
        const password = addPwdEl.value || '';
        if (!email || email.indexOf('@') < 0) {
            addErrorEl.textContent = '请输入合法邮箱';
            addErrorEl.hidden = false;
            addEmailEl.focus();
            return;
        }
        if (!password) {
            addErrorEl.textContent = '密码不能为空';
            addErrorEl.hidden = false;
            addPwdEl.focus();
            return;
        }
        addErrorEl.hidden = true;
        setAddBusy(true);
        post('submitAdd', { email, password });
    }

    function submitBatch() {
        if (batchSubmitEl.disabled) return;
        const text = batchTextEl.value || '';
        if (!text.trim()) return;
        post('submitBatch', { text });
        // Close immediately; batch progress is reported via VS Code notifications.
        closeModal();
    }

    // Cancel buttons
    document.querySelectorAll('[data-modal-cancel]').forEach(el => {
        el.addEventListener('click', () => {
            if (!addSubmitting) closeModal();
        });
    });
    // Click outside card to close
    overlayEl.addEventListener('click', ev => {
        if (ev.target === overlayEl && !addSubmitting) closeModal();
    });
    // Escape to close
    document.addEventListener('keydown', ev => {
        if (!currentModal) return;
        if (ev.key === 'Escape' && !addSubmitting) {
            closeModal();
        } else if (ev.key === 'Enter' && currentModal === 'add' && ev.target !== batchTextEl) {
            ev.preventDefault();
            submitAdd();
        }
    });

    addSubmitEl.addEventListener('click', submitAdd);
    batchSubmitEl.addEventListener('click', submitBatch);
    batchTextEl.addEventListener('input', requestPreview);
    batchTextEl.addEventListener('paste', () => setTimeout(requestPreview, 0));

    // Creds modal: action buttons
    credsCardEl.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-creds-copy]');
        if (!btn || !credsTarget) return;
        const field = btn.dataset.credsCopy;
        if (field === 'remark') {
            post('editRemark', { id: credsTarget.id });
            closeModal();
            return;
        }
        post('copyCred', { id: credsTarget.id, field });
    });

    // ---------- events ----------------------------------------------------
    function computeFilteredIds() {
        try {
            return sortAccounts(state.accounts.filter(passesFilter)).map(a => a.id);
        } catch {
            return state.accounts.map(a => a.id);
        }
    }

    // Section head collapse — 排序方式 / 筛选账号
    document.querySelectorAll('.section-head[data-collapse]').forEach(head => {
        head.addEventListener('click', () => {
            const section = head.dataset.collapse;
            if (section === 'sort') {
                state.ui.sortCollapsed = !state.ui.sortCollapsed;
                applyCollapseUi();
                post('toggleCollapse', { section, collapsed: state.ui.sortCollapsed });
            }
            else if (section === 'filter') {
                state.ui.filterCollapsed = !state.ui.filterCollapsed;
                applyCollapseUi();
                post('toggleCollapse', { section, collapsed: state.ui.filterCollapsed });
            }
        });
    });

    // 阈值输入框三道防线：
    //   1) HTML maxlength="2" —— 最多 2 个字符能进入，天然上限 99
    //   2) keydown —— 非数字键直接拦截（Backspace/Arrow 等导航键放行）
    //   3) input —— 兑底粘贴等渠道，删除非数字字符
    document.addEventListener('keydown', ev => {
        const thr = ev.target.closest('[data-auto-threshold]');
        if (!thr) return;
        // 功能/导航键（Backspace / Delete / Arrow / Tab / Enter …）一律放行
        if (ev.key.length > 1) return;
        // 修饰键组合（Cmd/Ctrl/Alt + X）不拦，比如全选 / 复制 / 粘贴
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        // 只放行 0-9
        if (!/^[0-9]$/.test(ev.key)) {
            ev.preventDefault();
        }
    });
    document.addEventListener('input', ev => {
        const thr = ev.target.closest('[data-auto-threshold]');
        if (!thr) return;
        // 兼底：清理所有非数字字符（IME / 特殊粘贴）。
        // maxlength="2" 已确保值不超 99，无需 clamp。
        const clean = (thr.value || '').replace(/\\D/g, '');
        if (clean !== thr.value) thr.value = clean;
    });

    // 自动切号 toggles — auto-row lives in #auto-options (top-level, NOT in currentEl)
    document.addEventListener('change', ev => {
        const chk = ev.target.closest('[data-auto-toggle]');
        if (chk) {
            const kind = chk.dataset.autoToggle;
            // optimistic update so the interval select enables/disables without waiting
            if (kind === 'polling') state.auto.polling.enabled = !!chk.checked;
            if (kind === 'logWatch') state.auto.logWatch.enabled = !!chk.checked;
            if (kind === 'threshold') state.auto.lowQuotaThresholdEnabled = !!chk.checked;
            post('toggleAuto', { kind, enabled: !!chk.checked });
            // re-render to refresh the select's disabled state
            renderAutoOptions();
            return;
        }
        const sel = ev.target.closest('[data-auto-interval]');
        if (sel) {
            const ms = Number(sel.value) | 0;
            if (ms) {
                state.auto.polling.intervalMs = ms;
                post('setPollingInterval', { intervalMs: ms });
            }
            return;
        }
        const thr = ev.target.closest('[data-auto-threshold]');
        if (thr) {
            // 对非法输入做防御：空值 / 非数字 / 超出 0-99
            const raw = (thr.value || '').trim();
            const v = Math.round(Number(raw));
            if (raw !== '' && Number.isFinite(v) && v >= 0 && v <= 99) {
                state.auto.lowQuotaThreshold = v;
                post('setLowQuotaThreshold', { threshold: v });
            } else {
                // 回退到当前合法值，避免输入框显示垂死的非法内容
                thr.value = String(state.auto.lowQuotaThreshold | 0);
            }
            return;
        }
    });

    document.addEventListener('click', ev => {
        const el = ev.target.closest('[data-cmd]');
        if (!el) return;
        const cmd = el.dataset.cmd;
        // Intercept toolbar add/batch buttons: open local modal instead of
        // delegating to extension command (which would fall back to
        // InputBox / openTextDocument flows).
        if (cmd === 'addAccount') {
            openModal('add');
            return;
        }
        if (cmd === 'batchImport') {
            openModal('batch');
            return;
        }

        // Current-account card buttons (smart switch / refresh current / reset cooldown)
        if (el.hasAttribute('data-current')) {
            if (cmd === 'smartSwitch') {
                post('smartSwitch', { filteredIds: computeFilteredIds() });
                return;
            }
            if (cmd === 'refreshCurrent') {
                // Intentionally do NOT set scrollToIdAfterRender: refreshing the
                // current-account card shouldn't hijack the user's scroll.
                post('refreshCurrent', {});
                return;
            }
            if (cmd === 'resetCooldown') {
                post('resetCooldown');
                return;
            }
        }

        const cardEl = el.closest('.card');
        const id = cardEl ? cardEl.dataset.id : undefined;
        // Single-account refresh in the list: keep the card in view after reload.
        if (cmd === 'refresh' && id) {
            scrollToIdAfterRender = id;
        }
        post(cmd, id ? { id } : undefined);
    });

    // ---- Dropdown (sort + filter) ---------------------------------------
    /** Close every open dropdown. Called on outside-click / Escape / selection. */
    function closeAllDropdowns() {
        document.querySelectorAll('.dropdown.open').forEach(d => {
            d.classList.remove('open');
            const m = d.querySelector('.dropdown-menu');
            if (m) m.hidden = true;
        });
    }
    document.querySelectorAll('.dropdown-trigger').forEach(trig => {
        trig.addEventListener('click', e => {
            e.stopPropagation();
            const dd = trig.closest('.dropdown');
            if (!dd) return;
            const isOpen = dd.classList.contains('open');
            closeAllDropdowns();
            if (!isOpen) {
                dd.classList.add('open');
                const m = dd.querySelector('.dropdown-menu');
                if (m) m.hidden = false;
            }
        });
    });
    // Sort option click:
    //   * already-active option → toggle direction (asc ↔ desc), KEEP menu open
    //     so user can keep flipping if they want.
    //   * other option         → switch mode to its default direction, close menu.
    document.querySelectorAll('#sort-menu .dropdown-option').forEach(opt => {
        opt.addEventListener('click', e => {
            e.stopPropagation();
            const mode = opt.dataset.sort;
            const wasActive = state.sort.mode === mode;
            if (wasActive) {
                state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
            } else {
                state.sort.mode = mode;
                state.sort.dir = mode === 'expiry' ? 'asc' : 'desc';
            }
            persist();
            render();
            if (!wasActive) closeAllDropdowns();
        });
    });
    // Filter checkbox toggle → keep menu open, re-render.
    document.querySelectorAll('#filter-menu .dropdown-check input').forEach(cb => {
        cb.addEventListener('change', () => {
            const key = cb.dataset.filter;
            state.filters[key] = cb.checked;
            persist();
            render();
        });
    });
    // Click inside filter menu (but not on the checkbox itself) keeps it open;
    // but allow clicks on <label> to toggle (native label click triggers input).
    document.querySelectorAll('.dropdown-menu').forEach(m => {
        m.addEventListener('click', e => e.stopPropagation());
    });
    // Outside click / Escape → close.
    document.addEventListener('click', () => closeAllDropdowns());
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeAllDropdowns();
    });

    window.addEventListener('message', ev => {
        const msg = ev.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'state') {
            state.loading = !!msg.loading;
            state.accounts = Array.isArray(msg.accounts) ? msg.accounts : [];
            state.error = msg.error;
            if ('currentAccountId' in msg) state.currentAccountId = msg.currentAccountId || null;
            if ('activeEmail' in msg) state.activeEmail = msg.activeEmail || null;
            if (msg.smartHistory && typeof msg.smartHistory === 'object') state.smartHistory = msg.smartHistory;
            if (msg.auto) state.auto = msg.auto;
            if (msg.ui) state.ui = msg.ui;
            render();
            return;
        }
        if (msg.type === 'status') {
            statusEl.className = 'status ' + (msg.tone || 'info');
            statusEl.textContent = msg.text || '';
            statusEl.hidden = !msg.text;
            if (msg.text) {
                clearTimeout(statusEl._t);
                statusEl._t = setTimeout(() => { statusEl.hidden = true; }, 2000);
            }
            return;
        }
        if (msg.type === 'batchPreview') {
            const n = (msg.count | 0);
            batchPreviewEl.textContent = '已识别 ' + n + ' 个账号';
            batchPreviewEl.classList.toggle('has', n > 0);
            batchSubmitEl.disabled = n === 0;
            return;
        }
        if (msg.type === 'modalClose') {
            closeModal();
            return;
        }
        if (msg.type === 'modalError') {
            if (currentModal === 'add') {
                setAddBusy(false);
                addErrorEl.textContent = msg.text || '操作失败';
                addErrorEl.hidden = false;
            }
            return;
        }
        if (msg.type === 'openModal') {
            if (msg.kind === 'add' || msg.kind === 'batch' || msg.kind === 'creds') {
                openModal(msg.kind, msg.opts);
            }
            return;
        }
    });

    render();
})();
`;
//# sourceMappingURL=sidebar.js.map