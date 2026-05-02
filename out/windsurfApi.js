"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.firebaseLogin = firebaseLogin;
exports.auth1Login = auth1Login;
exports.auth1PostAuth = auth1PostAuth;
exports.login = login;
exports.firebaseRefresh = firebaseRefresh;
exports.getPlanStatus = getPlanStatus;
exports.registerUser = registerUser;
const constants_1 = require("./constants");
const log_1 = require("./log");
// Default Windsurf endpoints (taken from the bundled `codeium.windsurf`
// extension's `DEFAULT_REGISTER_API_SERVER_URL`).
const REGISTER_API_SERVER_URL = 'https://register.windsurf.com';
const REGISTER_USER_PATH = '/exa.seat_management_pb.SeatManagementService/RegisterUser';
const DEFAULT_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': constants_1.USER_AGENT,
    'Origin': constants_1.WINDSURF_ORIGIN,
    'Referer': constants_1.FIREBASE_REFERER
};
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const POST_JSON_MAX_RETRIES = 3;
const POST_JSON_RETRY_BASE_MS = 600;
const POST_JSON_RETRY_MAX_MS = 4_000;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function parseErrorDetail(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed.error?.message || parsed.detail || parsed.message || text;
    }
    catch {
        return text;
    }
}
function retryDelayMs(attempt, retryAfterHeader) {
    if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(Math.round(seconds * 1000), POST_JSON_RETRY_MAX_MS);
        }
        const dateMs = Date.parse(retryAfterHeader);
        if (Number.isFinite(dateMs)) {
            const delta = dateMs - Date.now();
            if (delta > 0)
                return Math.min(delta, POST_JSON_RETRY_MAX_MS);
        }
    }
    const exponential = Math.min(POST_JSON_RETRY_BASE_MS * (2 ** attempt), POST_JSON_RETRY_MAX_MS);
    const jitter = Math.floor(Math.random() * 250);
    return exponential + jitter;
}
function shouldRetryTransportError(err) {
    const msg = String(err?.message || err || '');
    return (/fetch failed/i.test(msg) ||
        /network/i.test(msg) ||
        /timed?\s*out/i.test(msg) ||
        /ECONNRESET/i.test(msg) ||
        /ETIMEDOUT/i.test(msg) ||
        /EAI_AGAIN/i.test(msg));
}
async function postJson(url, body, extraHeaders = {}) {
    for (let attempt = 0; attempt <= POST_JSON_MAX_RETRIES; attempt++) {
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { ...DEFAULT_HEADERS, ...extraHeaders },
                body: JSON.stringify(body)
            });
            const text = await resp.text();
            if (!resp.ok) {
                const detail = parseErrorDetail(text);
                if (attempt < POST_JSON_MAX_RETRIES && RETRYABLE_STATUS_CODES.has(resp.status)) {
                    const delayMs = retryDelayMs(attempt, resp.headers.get('retry-after'));
                    (0, log_1.log)(`postJson retry ${attempt + 1}/${POST_JSON_MAX_RETRIES}: ${url} (${resp.status}) after ${delayMs}ms - ${detail}`);
                    await sleep(delayMs);
                    continue;
                }
                throw new Error(`${url.split('/').slice(0, 3).join('/')} failed (${resp.status}): ${detail}`);
            }
            if (!text) {
                return {};
            }
            try {
                return JSON.parse(text);
            }
            catch (e) {
                throw new Error(`Invalid JSON from ${url}: ${e?.message || e}`);
            }
        }
        catch (e) {
            if (attempt < POST_JSON_MAX_RETRIES && shouldRetryTransportError(e)) {
                const delayMs = retryDelayMs(attempt, null);
                (0, log_1.log)(`postJson transport retry ${attempt + 1}/${POST_JSON_MAX_RETRIES}: ${url} after ${delayMs}ms - ${e?.message || e}`);
                await sleep(delayMs);
                continue;
            }
            throw e;
        }
    }
    throw new Error(`Unexpected retry flow exit for ${url}`);
}
async function firebaseLogin(email, password) {
    const body = await postJson(constants_1.FIREBASE_LOGIN_URL, { email, password, returnSecureToken: true });
    return {
        idToken: body.idToken,
        refreshToken: body.refreshToken,
        authProvider: constants_1.FIREBASE_PROVIDER,
        auth1Token: '',
        accountId: body.localId || '',
        primaryOrgId: '',
        displayName: body.displayName || body.email || email,
        expiresInSeconds: Number(body.expiresIn) || 3600
    };
}
/**
 * Two-step Auth1 login, ported from Services/WindsurfApiService.cs Auth1LoginAsync.
 *
 * Windsurf has been gradually tightening Firebase signInWithPassword — some
 * accounts now return INVALID_LOGIN_CREDENTIALS / EMAIL_NOT_FOUND even when
 * the password is correct. Those accounts still work via the Auth1 web flow:
 *
 *   Step 1: POST /_devin-auth/password/login  { email, password }
 *            -> { token: auth1Token, user_id, email }
 *   Step 2: POST /_backend/.../WindsurfPostAuth { auth1Token, orgId: "" }
 *            -> { sessionToken, auth1Token, accountId, primaryOrgId }
 *
 * sessionToken is what we store as the account's `idToken`: it's accepted by
 * the same GetPlanStatus endpoint and by the RegisterUser endpoint (which
 * converts it to an sk-ws-01 API key) exactly like a Firebase idToken.
 */
async function auth1Login(email, password) {
    const webHeaders = { Referer: constants_1.WINDSURF_EDITOR_SIGNIN_REFERER };
    const step1 = await postJson(constants_1.AUTH1_PASSWORD_LOGIN_URL, { email, password }, webHeaders);
    const auth1Token = typeof step1?.token === 'string' ? step1.token : '';
    if (!auth1Token) {
        throw new Error('Auth1 password login response missing `token`');
    }
    const result = await auth1PostAuth(auth1Token);
    (0, log_1.log)(`auth1Login ok (${email}) accountId=${result.accountId || step1?.user_id || ''}`);
    return {
        ...result,
        accountId: result.accountId || String(step1?.user_id || ''),
        displayName: String(step1?.email || email)
    };
}
/**
 * Auth1 step B: exchange an existing `auth1Token` for a fresh `sessionToken`.
 * Used when we have a still-valid auth1Token on disk but no password — the
 * "auth1-only" account path.
 */
async function auth1PostAuth(auth1Token) {
    const webHeaders = { Referer: constants_1.WINDSURF_EDITOR_SIGNIN_REFERER };
    const step2 = await postJson(constants_1.WINDSURF_POST_AUTH_URL, { auth1Token, orgId: '' }, webHeaders);
    if (Array.isArray(step2?.orgs) &&
        step2.orgs.length > 0 &&
        !(typeof step2?.sessionToken === 'string' && step2.sessionToken)) {
        throw new Error('此账号有多个组织，请先在 windsurf.com 网页端选好组织再来使用。');
    }
    const sessionToken = typeof step2?.sessionToken === 'string' ? step2.sessionToken : '';
    if (!sessionToken) {
        throw new Error('Auth1 post-auth response missing `sessionToken`');
    }
    return {
        idToken: sessionToken,
        refreshToken: '',
        authProvider: constants_1.AUTH1_PROVIDER,
        auth1Token: (typeof step2?.auth1Token === 'string' && step2.auth1Token) || auth1Token,
        accountId: String(step2?.accountId || ''),
        primaryOrgId: String(step2?.primaryOrgId || ''),
        displayName: '',
        expiresInSeconds: constants_1.AUTH1_EXPIRES_IN_SECONDS
    };
}
/**
 * Smart login: try Firebase first, fall back to Auth1 on ANY Firebase failure.
 *
 * Originally we only fell back on credential-style errors. Google has since
 * enabled Firebase App Check enforcement on the Windsurf project's
 * `signInWithPassword` endpoint, so every plain HTTP login now returns
 * `401 Firebase App Check token is invalid`. Restricting fallback to
 * INVALID_LOGIN_CREDENTIALS / EMAIL_NOT_FOUND / INVALID_PASSWORD made every
 * import dead-end. We now always try Auth1 when Firebase fails — Auth1 lives
 * on `windsurf.com/_devin-auth/...` and is not App-Check-gated.
 */
async function login(email, password) {
    try {
        return await firebaseLogin(email, password);
    }
    catch (e) {
        try {
            (0, log_1.log)(`firebase login failed for ${email} (${e?.message || e}), falling back to Auth1`);
            return await auth1Login(email, password);
        }
        catch (auth1Err) {
            throw new Error(`登录失败。Firebase: ${e?.message || e}；Auth1: ${auth1Err?.message || auth1Err}`);
        }
    }
}
async function firebaseRefresh(refreshToken) {
    const body = await postJson(constants_1.FIREBASE_REFRESH_URL, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });
    return {
        idToken: body.id_token,
        refreshToken: body.refresh_token,
        authProvider: constants_1.FIREBASE_PROVIDER,
        auth1Token: '',
        accountId: body.user_id || '',
        primaryOrgId: '',
        displayName: '',
        expiresInSeconds: Number(body.expires_in) || 3600
    };
}
async function getPlanStatus(idToken) {
    const body = await postJson(constants_1.WINDSURF_PLAN_URL, { auth_token: idToken }, {
        'X-Auth-Token': idToken,
        'x-client-version': 'Chrome/JsCore/11.0.0/FirebaseCore-web'
    });
    const planStatus = body.planStatus ?? body;
    const planInfo = planStatus.planInfo ?? {};
    return {
        planName: String(planInfo.planName || planStatus.planName || 'Free'),
        dailyRemainPct: toNumberOrNull(planStatus.dailyQuotaRemainingPercent) ?? 0,
        weeklyRemainPct: toNumberOrNull(planStatus.weeklyQuotaRemainingPercent) ?? 0,
        dailyResetUnix: toNumberOrNull(planStatus.dailyQuotaResetAtUnix),
        weeklyResetUnix: toNumberOrNull(planStatus.weeklyQuotaResetAtUnix),
        expiresAt: String(planStatus.planEnd || planStatus.expiresAt || ''),
        gracePeriodStatus: String(planStatus.gracePeriodStatus || ''),
        lastQueryTime: new Date().toISOString()
    };
}
function toNumberOrNull(v) {
    if (v === null || v === undefined || v === '') {
        return null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
// ---------------------------------------------------------------------------
// Connect-RPC: SeatManagementService.RegisterUser
// ---------------------------------------------------------------------------
// Hand-rolled minimal protobuf wire-format codec — avoids pulling in any
// runtime dependency, since the request/response schemas are tiny.
//
//   RegisterUserRequest  { string firebase_id_token = 1; }
//   RegisterUserResponse { string api_key = 1; string name = 2; string api_server_url = 3; }
//
// Wire format reference: https://protobuf.dev/programming-guides/encoding/
// Connect HTTP/1.1 unary: body is the raw protobuf bytes (no length prefix).
function encodeVarint(n) {
    const bytes = [];
    while (n > 0x7f) {
        bytes.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 0x80);
    }
    bytes.push(n & 0x7f);
    return Buffer.from(bytes);
}
function decodeVarint(buf, offset) {
    let value = 0;
    let shift = 0;
    let i = offset;
    while (i < buf.length) {
        const b = buf[i++];
        value += (b & 0x7f) * (2 ** shift);
        if ((b & 0x80) === 0) {
            return { value, next: i };
        }
        shift += 7;
        if (shift > 63) {
            throw new Error('varint too long');
        }
    }
    throw new Error('truncated varint');
}
function encodeStringField(fieldNo, s) {
    const tag = (fieldNo << 3) | 2; // wire type 2 (LEN)
    const strBuf = Buffer.from(s, 'utf8');
    return Buffer.concat([encodeVarint(tag), encodeVarint(strBuf.length), strBuf]);
}
function decodeMessage(buf) {
    const out = {};
    let i = 0;
    while (i < buf.length) {
        const { value: tag, next } = decodeVarint(buf, i);
        i = next;
        const fieldNo = Math.floor(tag / 8);
        const wireType = tag & 7;
        if (wireType === 2) {
            const { value: len, next: lenEnd } = decodeVarint(buf, i);
            i = lenEnd;
            const slice = buf.subarray(i, i + len);
            i += len;
            out[fieldNo] = slice;
        }
        else if (wireType === 0) {
            const { next: vEnd } = decodeVarint(buf, i);
            i = vEnd;
        }
        else if (wireType === 1) {
            i += 8;
        }
        else if (wireType === 5) {
            i += 4;
        }
        else {
            throw new Error(`unsupported wire type ${wireType}`);
        }
    }
    return out;
}
/**
 * Exchange a Firebase IdToken for a Windsurf api key + display name + api
 * server url. Mirrors Windsurf core's own `registerUser(...)` call which is
 * normally invoked inside the auth provider's `handleAuthToken` flow.
 *
 * Throws on transport / protocol error. Returns `{apiKey, name, apiServerUrl}`.
 */
async function registerUser(firebaseIdToken) {
    if (!firebaseIdToken) {
        throw new Error('registerUser: empty firebaseIdToken');
    }
    const reqBytes = encodeStringField(1, firebaseIdToken);
    const url = REGISTER_API_SERVER_URL + REGISTER_USER_PATH;
    let lastErr;
    for (let attempt = 0; attempt <= POST_JSON_MAX_RETRIES; attempt++) {
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/proto',
                    'Accept': 'application/proto',
                    'Connect-Protocol-Version': '1',
                    'User-Agent': constants_1.USER_AGENT
                },
                body: reqBytes
            });
            const ab = await resp.arrayBuffer();
            const body = Buffer.from(ab);
            if (!resp.ok) {
                const detail = body.length > 0 ? body.toString('utf8') : '(empty)';
                if (attempt < POST_JSON_MAX_RETRIES && RETRYABLE_STATUS_CODES.has(resp.status)) {
                    const delayMs = retryDelayMs(attempt, resp.headers.get('retry-after'));
                    (0, log_1.log)(`registerUser retry ${attempt + 1}/${POST_JSON_MAX_RETRIES}: (${resp.status}) after ${delayMs}ms - ${detail}`);
                    await sleep(delayMs);
                    continue;
                }
                throw new Error(`RegisterUser failed (${resp.status}): ${detail}`);
            }
            const fields = decodeMessage(body);
            const apiKey = fields[1] ? fields[1].toString('utf8') : '';
            const name = fields[2] ? fields[2].toString('utf8') : '';
            const apiServerUrl = fields[3] ? fields[3].toString('utf8') : '';
            if (!apiKey) {
                throw new Error('RegisterUser response missing api_key');
            }
            return { apiKey, name, apiServerUrl };
        }
        catch (e) {
            lastErr = e;
            if (attempt < POST_JSON_MAX_RETRIES && shouldRetryTransportError(e)) {
                const delayMs = retryDelayMs(attempt, null);
                (0, log_1.log)(`registerUser transport retry ${attempt + 1}/${POST_JSON_MAX_RETRIES}: ${e?.message || e} after ${delayMs}ms`);
                await sleep(delayMs);
                continue;
            }
            throw e;
        }
    }
    throw lastErr || new Error('registerUser unexpected retry exhaustion');
}
//# sourceMappingURL=windsurfApi.js.map