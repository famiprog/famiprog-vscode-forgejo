import { forgejoUriFromRepoUrl } from '../shared/forgejoUri.js';
import { COMMAND_GET_ACCESS_TOKEN, COMMAND_REDIRECT_TO_LOGIN } from '../shared/oauth.js';

/**
 * Boot script imported by .../index.html.
 * Built to dist/web-index-html/index.js.
 *
 * Each page calls {@link setVscodeFileRoot} with its own VS Code directory, then {@link boot}.
 * The Forgejo authorize and token paths are the same for both, so they stay here.
 *
 * The page does the Forgejo round trip. VS Code is created only after an access token is ready.
 * While the IDE is open, it calls {@link COMMAND_GET_ACCESS_TOKEN} for that token. A 401 calls {@link COMMAND_REDIRECT_TO_LOGIN}.
 */

declare global {
    // type inspired from vscode/src/typings/vscode-globals-product.d.ts
    var _VSCODE_FILE_ROOT: string;
    // type inspired from github1s/vscode-web/src/setup.d.ts
    var _VSCODE_WEB: { builtinExtensions: { extensionPath: string; packageJSON: unknown }[] };
    /** Workbench bundle URL. Set by {@link setVscodeFileRoot}. */
    var _VSCODE_FILE_SCRIPT: string;
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

// type inspired from from vscode/src/vs/workbench/browser/web.factory.ts
interface WorkbenchModule {
    create(element: HTMLElement, options: IWorkbenchConstructionOptions): void;
    URI: {
        from(components: { scheme: string; authority: string; path: string }): unknown;
    };
}

export interface BootOptions {
    workbenchConstructionOptions: IWorkbenchConstructionOptions;
    additionalOptions?: AdditionalOptions;
    oauth2Config?: OAuth2Config;
}

// type inspired from vscode/src/vs/workbench/browser/web.api.ts
interface IWorkbenchConstructionOptions {
    commands?: { id: string; handler: () => any }[];
    webviewEndpoint?: string;
    workspaceProvider?: { workspace?: unknown };
}

interface AdditionalOptions {
    /**
     * E.g. `famiprog-vscode-forgejo`, provided this is sibling of index.html.
     */
    extensions?: { pathRelativeToIndexHtml: string }[];
}

const AUTHORIZE_PATH = '/login/oauth/authorize';
const TOKEN_PATH = '/login/oauth/access_token';

export interface OAuth2Config {
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

export async function boot(options: BootOptions): Promise<void> {
    try {
        await bootInternal(options);
    } catch (error) {
        document.body.textContent = error instanceof Error ? error.message : String(error);
        console.error(error);
    }
}

let session: Session;

async function bootInternal(options: BootOptions): Promise<void> {
    const { oauth2Config:oauth } = options;
    if (!oauth) {
        await startWorkbench(options);
        return;
    }

    page = {
        redirectUri: absoluteUrl(oauth.redirectPath) ? oauth.redirectPath : new URL(oauth.redirectPath, location.origin).href,
        authorizeUrl: new URL(AUTHORIZE_PATH, oauth.forgejoOrigin).href,
        tokenUrl: new URL(TOKEN_PATH, oauth.forgejoOrigin).href,
    };
    const params = new URLSearchParams(location.search);
    const isCallback = params.has('code') || params.has('error');
    if (!isCallback) {
        // call 1 to index.html; w/o params; user types the URL to VS Code
        // session = restoreSession()!;
        if (!session) {
            // and is the first load ever; so nothing is saved
            await redirectToAuthorize(oauth.clientId);
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
            client_id: oauth.clientId,
            code,
            grant_type: 'authorization_code',
            redirect_uri: page.redirectUri,
            code_verifier: saved.codeVerifier,
        });
        session = { origin, clientId: oauth.clientId, ...tokensFromServer };
        backupSession(session);
    }

    await startWorkbench(options);
}

/**
 * Should be the very first call. More precisely before the workbench import. Importing it earlier throws "Cannot determine URI for module id!".
 * 
 * This sets `globalThis._VSCODE_FILE_ROOT` (required by VS Code -> create()). 
 * And `globalThis._VSCODE_FILE_SCRIPT`. Useful if you want to import stuff e.g. 
 * 
 * ```ts
 * const { URI } = await import(globalThis._VSCODE_FILE_SCRIPT);
 * ```
 */
export function setVscodeFileRoot(vscodeFileRoot: string) {
    // the "reference" = vscode-web-base/node_modules/@github1s/vscode-web/index.html is:
    // globalThis._VSCODE_FILE_ROOT = new URL('/vscode/', window.location.origin).toString();
    globalThis._VSCODE_FILE_ROOT = new URL(vscodeFileRoot, document.baseURI).toString(); // or .href
    globalThis._VSCODE_FILE_SCRIPT = new URL('vs/workbench/workbench.web.main.internal.js', globalThis._VSCODE_FILE_ROOT).toString();
}

async function startWorkbench({ workbenchConstructionOptions, additionalOptions, oauth2Config } : BootOptions): Promise<void> {
    if (!globalThis._VSCODE_FILE_ROOT) {
        throw new Error('Call setVscodeFileRoot before boot.');
    }
    const builtinExtensionsDir = new URL('../extensions/', globalThis._VSCODE_FILE_ROOT);
    const builtinExtensions = await Promise.all((additionalOptions?.extensions ?? []).map(async extension => {
        const extensionDir = new URL(extension.pathRelativeToIndexHtml.replace(/\/?$/, '/'), document.baseURI);
        // e.g. for input `famiprog-vscode-forgejo`, we have: 
        // './famiprog-vscode-forgejo/package.json'
        const packageJSON = await fetch(new URL('package.json', extensionDir), { cache: 'no-store' }).then(response => response.json());
        // '../../../../famiprog-vscode-forgejo', 
        // Relative to <vscodeRoot>../extensions. A leading "/" is not absolute.
        return { extensionPath: relativePath(builtinExtensionsDir, extensionDir), packageJSON };
    }));
    // This is the mechanism of @github1s/vscode-web to load extensions. I think the original vscode-web also has something (that probably is reused by github1s?)
    // I say this by looking at the doc of IWorkbenchConstructionOptions.additionalBuiltinExtensions
    globalThis._VSCODE_WEB = { builtinExtensions };

    const { create, URI } = await import(globalThis._VSCODE_FILE_SCRIPT) as WorkbenchModule;
    // Query string of type `?repoUrl=http://localhost:3001/forgejo/sample-repo` opens that folder.
    const repoUrl = new URLSearchParams(location.search).get('repoUrl')?.trim();
    if (repoUrl) {
        workbenchConstructionOptions.workspaceProvider = {
            ...workbenchConstructionOptions.workspaceProvider,
            workspace: { folderUri: URI.from(forgejoUriFromRepoUrl(repoUrl)) },
        };
    }
    const commands = [...(workbenchConstructionOptions.commands ?? [])];
    // Both commands are always registered. Without {@link OAuth2Config} there is no session:
    // the token handler returns nothing, and the login handler does nothing.
    commands.push({
        id: COMMAND_GET_ACCESS_TOKEN,
        handler: async (): Promise<string | undefined> => {
            if (!oauth2Config) {
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
            if (!oauth2Config) {
                return;
            }
            backupSession(null);
            void redirectToAuthorize(oauth2Config.clientId);
        },
    });
    // type of create declared in vscode/src/vs/workbench/browser/web.factory.ts
    create(document.body, {
        ...workbenchConstructionOptions,
        commands,
        // bug: webviews didn't work. was .pathname; should be .href
        // .href, not .pathname. The workbench compares this URL's origin with the
        // webview-ready message and drops the message when they differ, so the
        // editor frame stays empty.
        //   .pathname → /node_modules/@github1s/vscode-web/vscode/vs/workbench/contrib/webview/browser/pre
        //   .href     → http://localhost:3002/node_modules/@github1s/vscode-web/vscode/vs/workbench/contrib/webview/browser/pre
        webviewEndpoint: new URL('vs/workbench/contrib/webview/browser/pre', globalThis._VSCODE_FILE_ROOT).href,
    });
}

/**
 * Path from `from` to `to`, both directories. VS Code joins this onto its builtin extensions directory.
 *
 * vscode-web-base, file root `.../node_modules/@github1s/vscode-web/vscode/`:
 *   from `.../node_modules/@github1s/vscode-web/extensions/`
 *   to   `/famiprog-vscode-forgejo/`
 *   → `../../../../famiprog-vscode-forgejo`
 *
 * forgejo-tests, file root `/assets/vscode-web/vscode/`:
 *   from `/assets/vscode-web/extensions/`
 *   to   `/assets/famiprog-vscode-forgejo/`
 *   → `../../famiprog-vscode-forgejo`
 */
function relativePath(from: URL, to: URL): string {
    const fromParts = from.pathname.split('/').filter(Boolean);
    const toParts = to.pathname.split('/').filter(Boolean);
    let shared = 0;
    while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
        shared++;
    }
    return [...Array(fromParts.length - shared).fill('..'), ...toParts.slice(shared)].join('/');
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