"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureFreshIdToken = ensureFreshIdToken;
exports.invalidateToken = invalidateToken;
const constants_1 = require("./constants");
const log_1 = require("./log");
const accountsStore_1 = require("./accountsStore");
const memoryCreds_1 = require("./memoryCreds");
const windsurfApi_1 = require("./windsurfApi");
async function hydrateAccountCreds(account) {
    if (!account.idToken && !account.refreshToken && !account.password && !account.auth1Token) {
        const creds = await (0, memoryCreds_1.getCreds)(account.id);
        if (creds) {
            return {
                ...account,
                password: creds.password || '',
                idToken: creds.idToken || '',
                refreshToken: creds.refreshToken || '',
                auth1Token: creds.auth1Token || '',
                idTokenExpiresAt: creds.idTokenExpiresAt || account.idTokenExpiresAt
            };
        }
        const decrypted = await (0, accountsStore_1.loadAccountWithSecrets)(account.id);
        if (decrypted) {
            return decrypted;
        }
    }
    return account;
}
async function persistLoginResult(context, account, login, passwordOverride) {
    const expiresAt = Date.now() + login.expiresInSeconds * 1000;
    const password = passwordOverride ?? account.password ?? '';
    await (0, accountsStore_1.applyLoginTokens)(account.id, login.idToken, login.refreshToken || '', expiresAt, login.displayName || account.displayName, passwordOverride, login.authProvider, login.auth1Token || '', login.accountId || '', login.primaryOrgId || '');
    await (0, memoryCreds_1.putCreds)(account.id, {
        email: account.email,
        password,
        idToken: login.idToken,
        refreshToken: login.refreshToken || '',
        auth1Token: login.auth1Token || '',
        idTokenExpiresAt: expiresAt
    });
    await updateCache(context, account.id, login.idToken, expiresAt);
    return login.idToken;
}
async function persistAuth1Session(context, account, login) {
    const expiresAt = Date.now() + login.expiresInSeconds * 1000;
    await (0, accountsStore_1.applyAuth1Tokens)(account.id, login.idToken, login.auth1Token || '', expiresAt, login.accountId || '', login.primaryOrgId || '');
    await (0, memoryCreds_1.putCreds)(account.id, {
        email: account.email,
        password: account.password || '',
        idToken: login.idToken,
        refreshToken: '',
        auth1Token: login.auth1Token || '',
        idTokenExpiresAt: expiresAt
    });
    await updateCache(context, account.id, login.idToken, expiresAt);
    return login.idToken;
}
/**
 * Return a Firebase IdToken that will still be valid for at least TOKEN_SKEW_MS.
 *
 * Priority:
 *   1. globalState idToken cache (fastest, no DPAPI / no SecretStorage / no network)
 *   2. Memory / SecretStorage plaintext cache via `getCreds()` — this is our
 *      "zero DPAPI after first ever run" fast path.
 *   3. Last resort: lazy `loadAccountWithSecrets()` which spawns PowerShell.
 *   4. If still expired, firebaseRefresh(refreshToken) or firebaseLogin(email, password).
 */
async function ensureFreshIdToken(context, account, options = {}) {
    const now = Date.now();
    const cache = (context.globalState.get(constants_1.TOKEN_CACHE_STATE_KEY) || {});
    const cached = cache[account.id];
    if (!options.forceRelogin && cached && cached.idToken && cached.idTokenExpiresAt > now + constants_1.TOKEN_SKEW_MS) {
        return cached.idToken;
    }
    account = await hydrateAccountCreds(account);
    if (!options.forceRelogin && account.idToken && account.idTokenExpiresAt > now + constants_1.TOKEN_SKEW_MS) {
        await updateCache(context, account.id, account.idToken, account.idTokenExpiresAt);
        return account.idToken;
    }
    const isAuth1 = (account.authProvider || '').toLowerCase() === constants_1.AUTH1_PROVIDER;
    if (options.forceRelogin) {
        if (options.preferAuth1 && account.email && account.password) {
            try {
                (0, log_1.log)(`ensureFreshIdToken: force Auth1 re-login for ${account.email}`);
                const login = await (0, windsurfApi_1.auth1Login)(account.email, account.password);
                return await persistLoginResult(context, account, login, account.password);
            }
            catch (e) {
                (0, log_1.log)(`force Auth1 re-login failed (${account.email}): ${e?.message || e}`);
            }
        }
        if (isAuth1 && account.auth1Token && !account.password) {
            (0, log_1.log)(`ensureFreshIdToken: force auth1PostAuth only (${account.email})`);
            const login = await (0, windsurfApi_1.auth1PostAuth)(account.auth1Token);
            return await persistAuth1Session(context, account, login);
        }
        if (account.email && account.password) {
            (0, log_1.log)(`ensureFreshIdToken: force re-login via ${isAuth1 ? 'Auth1' : 'Firebase/Auth1 fallback'} for ${account.email}`);
            const login = await (0, windsurfApi_1.login)(account.email, account.password);
            return await persistLoginResult(context, account, login, account.password);
        }
        throw new Error('当前令牌已失效，且账号缺少密码，无法重新登录。请用「修复凭据」补充密码。');
    }
    if (!isAuth1 && account.refreshToken) {
        try {
            (0, log_1.log)(`ensureFreshIdToken: refreshing via Firebase for ${account.email}`);
            const refreshed = await (0, windsurfApi_1.firebaseRefresh)(account.refreshToken);
            return await persistLoginResult(context, account, {
                ...refreshed,
                refreshToken: refreshed.refreshToken || account.refreshToken
            });
        }
        catch (e) {
            (0, log_1.log)(`firebaseRefresh failed (${account.email}): ${e?.message || e}`);
        }
    }
    // Auth1-only account: no password on disk but we still have a valid-ish
    // auth1Token. Try step B alone to mint a fresh sessionToken.
    if (isAuth1 && account.auth1Token && !account.password) {
        try {
            (0, log_1.log)(`ensureFreshIdToken: auth1PostAuth only (${account.email})`);
            const login = await (0, windsurfApi_1.auth1PostAuth)(account.auth1Token);
            return await persistAuth1Session(context, account, login);
        }
        catch (e) {
            (0, log_1.log)(`auth1PostAuth failed (${account.email}): ${e?.message || e}`);
            // Fall through — if we also have password we'll retry below; otherwise throw.
        }
    }
    if (account.email && account.password) {
        (0, log_1.log)(`ensureFreshIdToken: re-login via ${isAuth1 ? 'Auth1' : 'Firebase/Auth1 fallback'} for ${account.email}`);
        const login = await (0, windsurfApi_1.login)(account.email, account.password);
        return await persistLoginResult(context, account, login, account.password);
    }
    throw new Error('无法获取有效的 IdToken：账号缺少可用凭据（密码 / refreshToken / auth1Token 都不可用）。请用「修复凭据」补充密码。');
}
async function updateCache(context, accountId, idToken, idTokenExpiresAt) {
    const cache = (context.globalState.get(constants_1.TOKEN_CACHE_STATE_KEY) || {});
    cache[accountId] = { idToken, idTokenExpiresAt, cachedAt: Date.now() };
    await context.globalState.update(constants_1.TOKEN_CACHE_STATE_KEY, cache);
}
async function invalidateToken(context, accountId) {
    const cache = (context.globalState.get(constants_1.TOKEN_CACHE_STATE_KEY) || {});
    delete cache[accountId];
    await context.globalState.update(constants_1.TOKEN_CACHE_STATE_KEY, cache);
}
//# sourceMappingURL=tokens.js.map