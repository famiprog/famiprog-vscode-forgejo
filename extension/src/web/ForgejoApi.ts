/**
 * Thin client for the parts of the Forgejo REST API needed by the file system provider.
 * HTTP calls go through the generated client. See https://forgejo.org/docs/latest/user/api-usage/
 */

import * as forgejots from '@llamaduck/forgejo-ts';
import type { GitEntry } from '@llamaduck/forgejo-ts';
import { createClient, createConfig } from '@llamaduck/forgejo-ts/client';
import axios, { isAxiosError } from 'axios';
import * as vscode from 'vscode';
import { COMMAND_GET_ACCESS_TOKEN, COMMAND_REDIRECT_TO_LOGIN } from '../shared/oauth.js';
import { Repo } from './Repo';

/** A page is capped by the server (`MAX_RESPONSE_ITEMS`), so we only ask for "as much as possible". */
const TREE_PAGE_SIZE = 1000;

export class ForgejoApi {

    /** Set in {@link create} or {@link setAccessToken} once the branch to read is known. */
    protected ref!: string;

    /** Forgejo personal access token. Sent as `Authorization: token <value>`. */
    accessToken?: string;

    private givenRef: string | undefined;

    /**
     * Requests use `fetch`, which the browser extension host and the recorded tests both intercept.
     * `false` keeps axios from adding `Accept` and `User-Agent`; the recordings have no request headers.
     */
    private readonly http = axios.create({
        adapter: 'fetch',
        headers: { Accept: false, 'User-Agent': false },
    });

    private readonly client = createClient(createConfig({
        axios: this.http,
        baseURL: `${this.origin}/api/v1`,
    }));

    /** Spread into every generated call so a failed response rejects and the return type says so. */
    private readonly callOptions = {
        client: this.client,
        throwOnError: true as const,
    };

    private constructor(readonly origin: string, readonly owner: string, readonly repoName: string) {
        this.http.interceptors.request.use(async config => {
            if (!await Repo.getIndexedDB()) {
                // desktop mode
                return config;
            }
            // Ask every time. A host with sign-in refreshes the token when it is about to expire.
            // A host without sign-in returns nothing, and a public repo is read with no Authorization header.
            const token = await vscode.commands.executeCommand<string | undefined>(COMMAND_GET_ACCESS_TOKEN) || this.accessToken;
            if (token) {
                config.headers.set('Authorization', `token ${token}`);
            }

            return config;
        });

        this.http.interceptors.response.use(undefined, error => {
            if (isAxiosError(error) && error.response?.status === 401) {
                void vscode.commands.executeCommand(COMMAND_REDIRECT_TO_LOGIN);
            }
            throw error;
        });
    }

    /**
     * @param origin e.g. `http://localhost:3001`
     * @param owner e.g. `forgejo`
     * @param repoName e.g. `hello-world`
     * @param ref e.g. `main`, `myBranch`, a commit id. If not specified, the default branch is retrieved.
     */
    static async create(origin: string, owner: string, repoName: string, ref: string | undefined): Promise<ForgejoApi> {
        const result = new ForgejoApi(origin, owner, repoName);
        result.givenRef = ref;
        if (ref) {
            result.ref = ref;
        } else {
            try {
                result.ref = await result.getDefaultBranch();
            } catch {
                // might error if trying to access a private repo, w/ no credentials
            }
        }
        return result;
    }

    async retrieveOauthTokens() {
        if (!await Repo.getIndexedDB()) {
            // desktop mode
            return;
        }
        // TODO use command GET_ACCESS_TOKEN and enrich the headers w/ the token
    }

    async setAccessToken(accessToken: string) {
        this.accessToken = accessToken;
        this.http.defaults.headers.common['Authorization'] = `token ${accessToken}`;
        // The default branch was requested without the token, and that rejection is cached on `ref`.
        if (this.givenRef === undefined) {
            this.ref = await this.getDefaultBranch();
        }
    }

    async getDefaultBranch(): Promise<string> {
        const { data } = await forgejots.repoGet({
            ...this.callOptions,
            path: { owner: this.owner, repo: this.repoName },
        });
        if (!data.default_branch) {
            throw new Error(`No default branch for ${this.owner}/${this.repoName}`);
        }
        return data.default_branch;
    }

    /**
     * Loads the whole tree (files and directories, but w/o content) with as few requests as possible.
     *
     * `ref` is passed in place of the tree `sha`; Forgejo accepts branch names, tags and commit ids for it.
     */
    async getTree(): Promise<GitEntry[]> {
        const entries: GitEntry[] = [];
        for (let page = 1; ; page++) {
            const { data } = await forgejots.getTree({
                ...this.callOptions,
                path: { owner: this.owner, repo: this.repoName, sha: await this.ref },
                query: { recursive: true, per_page: TREE_PAGE_SIZE, page },
            });
            entries.push(...(data.tree ?? []));
            if (!data.truncated || !data.tree?.length) {
                break;
            }
        }
        return entries;
    }

    /**
     * Content of a blob, identified by its (immutable) `sha`.
     *
     * Calls GET /repos/{owner}/{repo}/git/blobs/{sha}, and that response is JSON, so Forgejo puts the file bytes in content as base64.
     * The encoding field is always "base64". The payload is about a third larger than the file, and both sides do the encode and decode. ☹️
     *
     * The same bytes are available without that wrapping:
     * GET /api/v1/repos/{owner}/{repo}/raw/{filepath}?ref={branch|tag|commit}
     * That returns the file body directly. It is addressed by path and ref, while the blob route is addressed by the immutable sha you
     * already have from the tree.
     *
     * Forgejo still has no raw mode on the sha URL. That request is https://codeberg.org/forgejo/forgejo/issues/5071.
     * GitHub serves the raw blob when you send Accept: application/vnd.github.raw.
     */
    async getBlob(sha: string): Promise<Uint8Array> {
        const { data } = await forgejots.getBlob({
            ...this.callOptions,
            path: { owner: this.owner, repo: this.repoName, sha },
        });
        if (data.encoding !== 'base64' || typeof data.content !== 'string') {
            throw new Error(`Unexpected blob encoding "${data.encoding}" for ${sha}`);
        }
        return decodeBase64(data.content);
    }
}

function decodeBase64(content: string): Uint8Array {
    const binary = atob(content.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
