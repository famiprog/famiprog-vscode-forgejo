/**
 * Thin client for the parts of the Forgejo REST API needed by the file system provider.
 * See https://forgejo.org/docs/latest/user/api-usage/
 */

export interface ForgejoTreeEntry {
    /** Path relative to the repo root, w/o leading slash. */
    path: string;
    /** Octal mode as string: "040000" (tree), "100644"/"100755" (blob), "120000" (symlink), "160000" (submodule). */
    mode: string;
    type: 'blob' | 'tree' | 'commit';
    /** Size in bytes. Meaningful only for blobs. */
    size: number;
    sha: string;
}

export interface ForgejoTree {
    /** The ref (branch/tag/commit) for which the tree was loaded. */
    ref: string;
    entries: ForgejoTreeEntry[];
}

export class ForgejoApiError extends Error {
    constructor(readonly status: number, readonly url: string) {
        super(`${status} ${url}`);
        this.name = 'ForgejoApiError';
    }
}

/** A page is capped by the server (`MAX_RESPONSE_ITEMS`), so we only ask for "as much as possible". */
const TREE_PAGE_SIZE = 1000;

export class ForgejoApi {

    protected ref: Promise<string>;

    /**
     * @param origin e.g. `http://localhost:3001`
     * @param owner e.g. `forgejo`
     * @param repoName e.g. `hello-world`
     * @param ref e.g. `main`, `myBranch`, a commit id. If not specified, the default branch is retrieved.
     */
    constructor(readonly origin: string, readonly owner: string, readonly repoName: string, ref: string | undefined) {
        this.ref = ref ? Promise.resolve(ref) : this.getDefaultBranch();
    }

    async getDefaultBranch(): Promise<string> {
        const data = await this.getJson<{ default_branch?: string }>(this.repoUrl());
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
    async getTree(): Promise<ForgejoTree> {
        const entries: ForgejoTreeEntry[] = [];
        for (let page = 1; ; page++) {
            const url = new URL(`${this.repoUrl()}/git/trees/${encodeURIComponent(await this.ref)}`);
            url.searchParams.set('recursive', 'true');
            url.searchParams.set('per_page', String(TREE_PAGE_SIZE));
            url.searchParams.set('page', String(page));
            const data = await this.getJson<{ tree?: ForgejoTreeEntry[]; truncated?: boolean }>(url);
            entries.push(...(data.tree ?? []));
            if (!data.truncated || !data.tree?.length) {
                break;
            }
        }
        return { ref: await this.ref, entries };
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
        const data = await this.getJson<{ content?: string; encoding?: string }>(
            `${this.repoUrl()}/git/blobs/${encodeURIComponent(sha)}`);
        if (data.encoding !== 'base64' || typeof data.content !== 'string') {
            throw new Error(`Unexpected blob encoding "${data.encoding}" for ${sha}`);
        }
        return decodeBase64(data.content);
    }

    private repoUrl(): string {
        return `${this.origin}/api/v1/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repoName)}`;
    }

    private async getJson<T>(url: string | URL): Promise<T> {
        const response = await fetch(url.toString());
        if (!response.ok) {
            throw new ForgejoApiError(response.status, url.toString());
        }
        return await response.json() as T;
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
