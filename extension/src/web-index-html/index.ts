import { forgejoUriFromRepoUrl } from '../shared/forgejoUri.js';
import { COMMAND_GET_ACCESS_TOKEN, COMMAND_REDIRECT_TO_LOGIN } from '../shared/oauth.js';

/**
 * Boot script imported by .../index.html.
 * Built to dist/web-index-html/index.js.
 *
 * Each page passes its own paths. The two hosts lay the files out differently.
 * The Forgejo authorize and token paths are the same for both, so they stay here.
 *
 * The page does the Forgejo round trip. VS Code is created only after an access token is ready.
 * While the IDE is open, it calls {@link COMMAND_GET_ACCESS_TOKEN} for that token. A 401 calls {@link COMMAND_REDIRECT_TO_LOGIN}.
 */

declare global {
    var _VSCODE_FILE_ROOT: string;
    var _VSCODE_WEB: { builtinExtensions: { extensionPath: string; packageJSON: unknown }[] };
}

/**
 * Contains a short lived `accessToken`. This is used by the API.
 * When the expiration approaches (or passes), `refreshToken` is used to get a new `accessToken`.
 * This is saved in memory. But also in local storage. On index.html load, if such a session is stored => it's used.
 * We need this. We cannot initiate the redirect flow, because forgejo would always show the "Authorize" button.
 * This happens because the app is "confidential client = false". We cannot put "true", because this would mean to
 * use also client secret. This works when a server exists also.
 */
export interface Session {
    clientId: string;
    origin: string;
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
}

// from vscode/src/vs/workbench/browser/web.factory.ts
interface WorkbenchModule {
    create(element: HTMLElement, options: WorkbenchOptions): void;
    URI: {
        from(components: { scheme: string; authority: string; path: string }): unknown;
    };
}

interface WorkbenchOptions {
    commands?: { id: string; handler: () => any }[];
    webviewEndpoint?: string;
    workspaceProvider?: { workspace?: unknown };
}

const AUTHORIZE_PATH = '/login/oauth/authorize';
const TOKEN_PATH = '/login/oauth/access_token';

export interface BootPaths {
    /**
     * Directory for `globalThis._VSCODE_FILE_ROOT`. Include the trailing slash.
     * A leading "/" is from the origin. A relative path is from this page, so the
     * same index.html works at `/` and under a GitHub Pages prefix.
     */
    vscodeFileRoot: string;
    /**
     * This extension's directory relative to VS Code's builtin extensions directory
     * (`<vscodeFileRoot>../extensions`). A leading "/" is not treated as absolute.
     */
    extensionPath: string;
    extensionPackageJsonUrl: string;
}

export interface OAuth2Config extends BootPaths {
    clientId: string;
    /**
     * OAuth redirect URI. An absolute URL is sent as written, so `http://localhost:3002`
     * does not become `http://localhost:3002/`. A path is resolved against `location.origin`.
     */
    redirectPath: string;
    /** Forgejo origin that issues tokens. The page origin, when Forgejo itself hosts the page. */
    forgejoOrigin: string;
}

const PKCE_KEY = 'famiprog-vscode-forgejo.auth.pkce';
const SESSION_KEY = 'famiprog-vscode-forgejo.auth.session';
/** Refresh this long before `expiresAt`, so a request does not leave with a token that expires in flight. */
const EXPIRY_MARGIN_MS = 60_000;

/** Absolute URLs resolved from {@link OAuth2Config}. */
let page: { redirectUri: string; authorizeUrl: string; tokenUrl: string };

function isOAuth2Config(paths: BootPaths): paths is OAuth2Config {
    return 'clientId' in paths;
}

export async function boot(paths: BootPaths | OAuth2Config, optionsCallback?: () => Promise<WorkbenchOptions | void>): Promise<void> {
    try {
        await bootInternal(paths, optionsCallback);
    } catch (error) {
        document.body.textContent = error instanceof Error ? error.message : String(error);
    }
}

let session: Session;

async function bootInternal(paths: BootPaths | OAuth2Config, optionsCallback?: () => Promise<WorkbenchOptions | void>): Promise<void> {
    if (!isOAuth2Config(paths)) {
        await startWorkbench(paths, optionsCallback);
        return;
    }

    page = {
        redirectUri: absoluteUrl(paths.redirectPath) ? paths.redirectPath : new URL(paths.redirectPath, location.origin).href,
        authorizeUrl: new URL(AUTHORIZE_PATH, paths.forgejoOrigin).href,
        tokenUrl: new URL(TOKEN_PATH, paths.forgejoOrigin).href,
    };
    const params = new URLSearchParams(location.search);
    const isCallback = params.has('code') || params.has('error');
    if (!isCallback) {
        // call 1 to index.html; w/o params; user types the URL to VS Code
        // session = restoreSession()!;
        if (!session) {
            // and is the first load ever; so nothing is saved
            await redirectToAuthorize(paths.clientId);
            return;
        }
    } else {
        // call 2 to index.html; w/ params; so forgejo has done auth, and now redirects here
        const saved = readPkce();
        sessionStorage.removeItem(PKCE_KEY);
        if (!saved) {
            throw new Error("Error reading PCKE");
        }

        const error = params.get('error') ?? '';
        const state = params.get('state') ?? '';
        const code = params.get('code') ?? '';
        // erase the long ?... from the URL
        history.replaceState(null, '', page.redirectUri);
        if (error) {
            throw new Error(`Forgejo sign-in was declined (${error})`);
        }
        const expectedState = saved.state ?? '';
        // `state` is what Forgejo echoed from our authorize redirect. `expectedState` is the random
        // value this page stored before that redirect. They differ when the callback was not started
        // here: a link carrying someone else's authorization code (login CSRF), or a stale callback
        // opened after sessionStorage was cleared.
        if (state !== expectedState) {
            throw new Error('Forgejo sign-in could not be completed. state !== expectedState');
        }

        const origin = new URL(page.tokenUrl).origin;
        const tokensFromServer = await requestToken({
            client_id: paths.clientId,
            code,
            grant_type: 'authorization_code',
            redirect_uri: page.redirectUri,
            code_verifier: saved.codeVerifier,
        });
        session = { origin, clientId: paths.clientId, ...tokensFromServer };
        backupSession(session);
    }

    await startWorkbench(paths, optionsCallback);
}

async function startWorkbench(paths: BootPaths, optionsCallback?: () => Promise<WorkbenchOptions | void>): Promise<void> {
    // Set before the workbench import. Importing it earlier throws "Cannot determine URI for module id!".
    const fileRoot = new URL(paths.vscodeFileRoot, document.baseURI);
    globalThis._VSCODE_FILE_ROOT = fileRoot.toString();

    const packageJSON = await fetch(paths.extensionPackageJsonUrl, { cache: 'no-store' }).then(response => response.json());
    globalThis._VSCODE_WEB = {
        builtinExtensions: [{ extensionPath: paths.extensionPath, packageJSON }],
    };

    // create is declared in vscode/src/vs/workbench/browser/web.factory.ts
    const workbenchUrl = new URL('vs/workbench/workbench.web.main.internal.js', fileRoot);
    const { create, URI } = await import(workbenchUrl.href) as WorkbenchModule;
    const options = await optionsCallback?.() ?? {};
    // `?repoUrl=http://localhost:3001/forgejo/sample-repo` opens that folder.
    // This replaces the temporary workspace the page callback returns.
    const repoUrl = new URLSearchParams(location.search).get('repoUrl')?.trim();
    if (repoUrl) {
        options.workspaceProvider = {
            ...options.workspaceProvider,
            workspace: { folderUri: URI.from(forgejoUriFromRepoUrl(repoUrl)) },
        };
    }
    const commands = [...(options?.commands ?? [])];
    // Both commands are always registered. Without {@link OAuth2Config} there is no session:
    // the token handler returns nothing, and the login handler does nothing.
    commands.push({
        id: COMMAND_GET_ACCESS_TOKEN,
        handler: async (): Promise<string | undefined> => {
            if (!isOAuth2Config(paths)) {
                return undefined;
            }
            const sessionExpiresSoon = session.expiresAt - Date.now() <= EXPIRY_MARGIN_MS;
            if (sessionExpiresSoon) {
                session = await refresh(session);
            }

            return session.accessToken;
        },
    }, {
        id: COMMAND_REDIRECT_TO_LOGIN,
        handler: () => {
            if (!isOAuth2Config(paths)) {
                return;
            }
            backupSession(null);
            void redirectToAuthorize(paths.clientId);
        },
    });
    create(document.body, {
        ...options,
        commands,
        webviewEndpoint: new URL('vs/workbench/contrib/webview/browser/pre', fileRoot).pathname,
    });
}

/**
 * We generate: PKCE = state, codeVerifier.
 * We send: state, codeChallenge (derived from codeVerifier)
 * We remember in session storage: PCKE = state, codeVerifier
 */
async function redirectToAuthorize(clientId: string): Promise<void> {
    if (!clientId) {
        throw new Error('Set the OAuth2 client id in index.html.');
    }
    const state = randomUrlSafe(32);
    const codeVerifier = randomUrlSafe(64);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state, codeVerifier }));
    const codeChallenge = await s256(codeVerifier);
    const authorize = new URL(page.authorizeUrl);
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', page.redirectUri);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('code_challenge', codeChallenge);
    authorize.searchParams.set('state', state);
    location.href = authorize.href;
}

function absoluteUrl(value: string): boolean {
    return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function readPkce(): { codeVerifier: string; state: string } | null {
    try {
        return JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
    } catch {
        return null;
    }
}

let refreshing: Promise<Session> | undefined;

function refresh(session: Session): Promise<Session> {
    if (!refreshing) {
        refreshing = requestToken({
            client_id: session.clientId,
            grant_type: 'refresh_token',
            refresh_token: session.refreshToken,
        }, session.refreshToken).then(tokens => {
            const next = { ...session, ...tokens };
            backupSession(next);
            return next;
        }).finally(() => {
            refreshing = undefined;
        });
    }
    return refreshing;
}

function restoreSession(): Session | null {
    try {
        return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') as Session | null;
    } catch {
        return null;
    }
}

function backupSession(session: Session | null): void {
    if (session) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
        localStorage.removeItem(SESSION_KEY);
    }
}

interface TokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
}

async function requestToken(body: Record<string, string>, previousRefreshToken?: string): Promise<Pick<Session, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
    const response = await fetch(page.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(body),
    });
    let data: TokenResponse;
    try {
        data = await response.json() as TokenResponse;
    } catch {
        throw new Error(`Forgejo token request failed: HTTP ${response.status}`);
    }
    const refreshToken = data.refresh_token || previousRefreshToken;
    if (!response.ok || !data.access_token || !refreshToken) {
        const detail = data.error_description || data.error || `HTTP ${response.status}`;
        throw new Error(`Forgejo token request failed: ${detail}`);
    }
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    return {
        accessToken: data.access_token,
        refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
    };
}

function randomUrlSafe(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
}

async function s256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return base64url(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}