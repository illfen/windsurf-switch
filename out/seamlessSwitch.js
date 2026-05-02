"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function (o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function () { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function (o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function (o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function (o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function (o) {
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
exports.seamlessSwitch = seamlessSwitch;
exports.isPatchedCommandAvailable = isPatchedCommandAvailable;
const crypto = __importStar(require("crypto"));
const vscode = __importStar(require("vscode"));
const constants_1 = require("./constants");
const log_1 = require("./log");
const windsurfApi_1 = require("./windsurfApi");
const windsurfPatcher_1 = require("./windsurfPatcher");
const DEVIN_TOKEN_PREFIX = 'devin-session-token$';
const DEFAULT_API_SERVER_URL = 'https://server.codeium.com';
/**
 * Cached availability of the patched command. We re-check on each call but
 * memoize positive results to avoid the (cheap) `getCommands` scan on every
 * smart switch. Negative results are NOT cached so a freshly applied patch
 * is picked up on the next switch without a window reload of THIS extension.
 */
let patchedCommandAvailable = false;
async function isPatchedCommandAvailable() {
    if (patchedCommandAvailable) {
        return true;
    }
    try {
        const all = await vscode.commands.getCommands(true);
        patchedCommandAvailable = all.includes(windsurfPatcher_1.PATCH_COMMAND_ID);
        return patchedCommandAvailable;
    }
    catch {
        return false;
    }
}
/**
 * Browser-based seamless switch (legacy path).
 *
 * Mechanism:
 *   vscode.authentication.getSession(..., { forceNewSession: true })
 *   └─ runs Windsurf's provider.createSession
 *      └─ login() { await env.openExternal(loginUrl); await Promise.race([ uri, cancel, timeout ]) }
 *
 * We fire `windsurf://codeium.windsurf#access_token=<IdToken>` after
 * URI_FIRE_DELAY_MS so Windsurf's listener is already attached. Our URI
 * reaches Windsurf via the OS handler in milliseconds, much faster than the
 * browser could complete the real OAuth redirect, so we win the race.
 *
 * Side effect: Windsurf's `login()` always calls `env.openExternal(loginUrl)`
 * — a browser tab pops up to `windsurf.com/windsurf/signin`. The page is
 * unused; the user can close it (or batch-close them). This is the documented
 * "已知折衷". To avoid the tab entirely, install the Windsurf core patch via
 * `windsurfSwitch.patchWindsurf` so the patched-command path below is taken.
 */
async function browserSwitch(firebaseIdToken) {
    const state = crypto.randomBytes(8).toString('hex');
    const callbackUri = `${constants_1.WINDSURF_CALLBACK_URI_BASE}#access_token=${encodeURIComponent(firebaseIdToken)}&state=${state}`;
    (0, log_1.log)(`seamlessSwitch[browser]: scheduling callback URI in ${constants_1.URI_FIRE_DELAY_MS}ms`);
    const uriTimer = setTimeout(() => {
        vscode.env.openExternal(vscode.Uri.parse(callbackUri)).then(ok => (0, log_1.log)(`callback URI dispatched ok=${ok}`), err => (0, log_1.log)('callback URI dispatch failed:', err?.message || err));
    }, constants_1.URI_FIRE_DELAY_MS);
    try {
        const session = await vscode.authentication.getSession(constants_1.WINDSURF_AUTH_PROVIDER_ID, ['Login'], { forceNewSession: true });
        (0, log_1.log)('seamlessSwitch[browser]: getSession resolved ->', session?.account?.label);
        return session;
    }
    finally {
        clearTimeout(uriTimer);
    }
}
/**
 * Patched-command seamless switch.
 *
 * Calls the command injected into Windsurf core by `windsurfPatcher`:
 *   `windsurf.provideAuthTokenToAuthProviderWithShit({apiKey, name, apiServerUrl})`
 *
 * The patched method directly writes Windsurf's SecretStorage and fires
 * `_sessionChangeEmitter`, so the swap is invisible to the user — no
 * browser, no modal, no progress notification.
 *
 * For Auth1 accounts (idToken starts with `devin-session-token$`) we can use
 * the token directly as the apiKey. For Firebase accounts we exchange the
 * idToken for a Windsurf apiKey via `RegisterUser`.
 */
async function patchedSwitch(idToken, hint) {
    let apiKey;
    let name;
    let apiServerUrl = DEFAULT_API_SERVER_URL;
    if (typeof idToken === 'string' && idToken.startsWith(DEVIN_TOKEN_PREFIX)) {
        // Auth1 / Devin session token — accepted directly by Windsurf as apiKey.
        apiKey = idToken;
        name = (hint?.email || hint?.displayName || 'devin-session').trim();
    }
    else {
        // Firebase IdToken — convert via Windsurf's own RegisterUser endpoint.
        (0, log_1.log)('seamlessSwitch[patch]: idToken is Firebase, calling RegisterUser');
        const reg = await (0, windsurfApi_1.registerUser)(idToken);
        apiKey = reg.apiKey;
        name = (hint?.email || reg.name || '').trim() || reg.name || 'firebase-user';
        if (reg.apiServerUrl) {
            apiServerUrl = reg.apiServerUrl;
        }
    }
    if (!apiKey) {
        throw new Error('seamlessSwitch[patch]: empty apiKey after token resolution');
    }
    if (!name) {
        // The patched method validates `!name` and throws; provide a stable fallback.
        name = hint?.email || 'windsurf-user';
    }
    (0, log_1.log)(`seamlessSwitch[patch]: invoking ${windsurfPatcher_1.PATCH_COMMAND_ID} (name=${name})`);
    const result = await vscode.commands.executeCommand(windsurfPatcher_1.PATCH_COMMAND_ID, { apiKey, name, apiServerUrl });
    if (result && typeof result === 'object' && result.error) {
        throw new Error(`patched command error: ${JSON.stringify(result.error)}`);
    }
    return result?.session ?? { account: { label: name, id: name }, scopes: ['Login'], id: '', accessToken: apiKey };
}
/**
 * Trigger a session swap without reloading Windsurf.
 *
 * Tries the in-process patched command first (no browser); falls back to the
 * legacy browser-URI race if the patch isn't applied or the call errors.
 *
 * @param idToken    Firebase IdToken or Auth1 `devin-session-token$...`
 * @param hint       Optional `{ email?, displayName?, apiServerUrl? }` used to
 *                   build a stable session label and skip RegisterUser when
 *                   we already have a usable api key.
 */
async function seamlessSwitch(idToken, hint) {
    if (!idToken) {
        throw new Error('IdToken is empty');
    }
    if (await isPatchedCommandAvailable()) {
        try {
            return await patchedSwitch(idToken, hint);
        }
        catch (e) {
            (0, log_1.log)(`seamlessSwitch[patch] failed (${e?.message || e}); falling back to browser flow`);
            // Invalidate the cache: maybe the command was unregistered (e.g.
            // Windsurf reloaded its auth provider without our patch). The next
            // call will re-probe.
            patchedCommandAvailable = false;
        }
    }
    return await browserSwitch(idToken);
}
//# sourceMappingURL=seamlessSwitch.js.map