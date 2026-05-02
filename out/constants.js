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
exports.AUTH1_PROVIDER = exports.FIREBASE_PROVIDER = exports.URI_FIRE_DELAY_MS = exports.TOKEN_SKEW_MS = exports.TOKEN_CACHE_STATE_KEY = exports.ACCOUNTS_FILE_NAME = exports.MANAGER_DATA_DIR_NAME = exports.USER_AGENT = exports.AUTH1_EXPIRES_IN_SECONDS = exports.WINDSURF_EDITOR_SIGNIN_REFERER = exports.WINDSURF_POST_AUTH_URL = exports.AUTH1_PASSWORD_LOGIN_URL = exports.FIREBASE_REFERER = exports.WINDSURF_ORIGIN = exports.WINDSURF_PLAN_URL = exports.FIREBASE_REFRESH_URL = exports.FIREBASE_LOGIN_URL = exports.FIREBASE_API_KEY = exports.WINDSURF_CALLBACK_URI_BASE = exports.WINDSURF_AUTH_PROVIDER_ID = void 0;
exports.getAccountsFilePath = getAccountsFilePath;
exports.getAccountsDir = getAccountsDir;
const path = __importStar(require("path"));
const os = __importStar(require("os"));
exports.WINDSURF_AUTH_PROVIDER_ID = 'windsurf_auth';
exports.WINDSURF_CALLBACK_URI_BASE = 'windsurf://codeium.windsurf';
exports.FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
exports.FIREBASE_LOGIN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${exports.FIREBASE_API_KEY}`;
exports.FIREBASE_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${exports.FIREBASE_API_KEY}`;
exports.WINDSURF_PLAN_URL = 'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus';
exports.WINDSURF_ORIGIN = 'https://windsurf.com';
exports.FIREBASE_REFERER = `${exports.WINDSURF_ORIGIN}/`;
// Auth1 (fallback for accounts that Firebase signInWithPassword now refuses).
// Mirrors Services/WindsurfApiService.cs Auth1LoginAsync flow:
//   1) POST /_devin-auth/password/login  -> { token: auth1Token }
//   2) POST /_backend/.../WindsurfPostAuth { auth1Token, orgId:"" } -> { sessionToken, ... }
exports.AUTH1_PASSWORD_LOGIN_URL = `${exports.WINDSURF_ORIGIN}/_devin-auth/password/login`;
exports.WINDSURF_POST_AUTH_URL = `${exports.WINDSURF_ORIGIN}/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`;
exports.WINDSURF_EDITOR_SIGNIN_REFERER = `${exports.WINDSURF_ORIGIN}/editor/signin`;
/** Auth1 sessionToken is valid for 14 days (matches desktop). */
exports.AUTH1_EXPIRES_IN_SECONDS = 14 * 24 * 60 * 60;
exports.USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
exports.MANAGER_DATA_DIR_NAME = 'windsurf-manager-desktop';
exports.ACCOUNTS_FILE_NAME = 'accounts.json';
exports.TOKEN_CACHE_STATE_KEY = 'windsurfSwitch.tokenCache';
exports.TOKEN_SKEW_MS = 60 * 1000;
exports.URI_FIRE_DELAY_MS = 500;
exports.FIREBASE_PROVIDER = 'firebase';
exports.AUTH1_PROVIDER = 'auth1';
function getAccountsDir() {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, exports.MANAGER_DATA_DIR_NAME);
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', exports.MANAGER_DATA_DIR_NAME);
    }
    // Linux / other POSIX: respect XDG_CONFIG_HOME, default ~/.config.
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(xdg, exports.MANAGER_DATA_DIR_NAME);
}
function getAccountsFilePath() {
    return path.join(getAccountsDir(), exports.ACCOUNTS_FILE_NAME);
}
//# sourceMappingURL=constants.js.map