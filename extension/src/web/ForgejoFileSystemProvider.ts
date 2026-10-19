import { CopyOnWrite, fs as zenfs, InMemory, mounts, resolveMountConfig } from '@zenfs/core';
import * as vscode from 'vscode';
import { ForgejoApi, ForgejoApiError } from './ForgejoApi.js';
import { ForgejoReadableFS } from './ForgejoZenFS.js';

export const SCHEME = 'forgejo';

interface RepoLocation {
    origin: string;
    owner: string;
    repo: string;
    /** Path inside the repo, w/o leading slash. Empty for the repo root. */
    path: string;
    ref?: string;
}

/** A repo that was connected to: its tree is cached in a ZenFS file system, mounted at `mountPoint`. */
interface ConnectedRepo {
    mountPoint: string;
}

/**
 * Read-only file system provider for the repos of a Forgejo server.
 *
 * URI format: `forgejo://<host[:port]>/<owner>/<repo>[/<path>][?ref=<branch|tag|commit>&protocol=<http|https>]`.
 * (`protocol` defaults to `http`; `ref` defaults to the default branch of the repo.)
 *
 * * On the first access to a repo, the whole tree (w/o content) is loaded in one go, via web service,
 * and is stored in a ZenFS file system.
 * * All the operations (`stat`, `readDirectory`, `readFile`) are then served from that ZenFS store;
 * the content of a file is lazily fetched from the server, the first time the file is read.
 */
export class ForgejoFileSystemProvider implements vscode.FileSystemProvider {

    private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private readonly repos = new Map<string, Promise<ConnectedRepo>>();

    readonly onDidChangeFile = this.emitter.event;

    register() {
        return vscode.workspace.registerFileSystemProvider(SCHEME, this, {
			isCaseSensitive: true,
			isReadonly: true,
		});
    }

    watch(): vscode.Disposable {
        // Read-only and cached for the lifetime of the provider => nothing ever changes
        return new vscode.Disposable(() => { });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        return this.run(uri, async path => {
            const stats = await zenfs.promises.lstat(path);
            let type: vscode.FileType;
            if (stats.isDirectory()) {
                type = vscode.FileType.Directory;
            } else if (stats.isSymbolicLink()) {
                type = vscode.FileType.SymbolicLink | vscode.FileType.File;
            } else {
                type = vscode.FileType.File;
            }
            return {
                type,
                ctime: stats.ctimeMs,
                mtime: stats.mtimeMs,
                size: stats.size,
                permissions: vscode.FilePermission.Readonly,
            };
        });
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        return this.run(uri, async path => {
            const entries = await zenfs.promises.readdir(path, { withFileTypes: true });
            return entries.map(entry => {
                let type: vscode.FileType;
                if (entry.isDirectory()) {
                    type = vscode.FileType.Directory;
                } else if (entry.isSymbolicLink()) {
                    type = vscode.FileType.SymbolicLink | vscode.FileType.File;
                } else {
                    type = vscode.FileType.File;
                }
                return [entry.name, type] as [string, vscode.FileType];
            });
        });
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        return this.run(uri, async path => {
            // ZenFS silently returns empty content when asked to read a directory
            if ((await zenfs.promises.stat(path)).isDirectory()) {
                throw vscode.FileSystemError.FileIsADirectory(uri);
            }
            const content = await zenfs.promises.readFile(path);
            return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        });
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions('Forgejo file system is read-only');
    }

    writeFile(): void {
        throw vscode.FileSystemError.NoPermissions('Forgejo file system is read-only');
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions('Forgejo file system is read-only');
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions('Forgejo file system is read-only');
    }

    /** Unmounts all the connected repos and drops their cache. */
    dispose(): void {
        for (const connecting of this.repos.values()) {
            connecting.then(repo => zenfs.umount(repo.mountPoint), () => { });
        }
        this.repos.clear();
        this.emitter.dispose();
    }

    /**
     * Connects to the repo (if needed) and runs `operation` with the ZenFS path that corresponds to the `uri`;
     * translates the failures to `vscode.FileSystemError`s.
     */
    private async run<T>(uri: vscode.Uri, operation: (zenfsPath: string) => Promise<T>): Promise<T> {
        const location = parseUri(uri);
        try {
            const repo = await this.connect(location);
            return await operation(repo.mountPoint + (location.path ? '/' + location.path : ''));
        } catch (error) {
            throw toFileSystemError(error, uri);
        }
    }

    private connect(location: RepoLocation): Promise<ConnectedRepo> {
        const key = `${location.origin}/${location.owner}/${location.repo}@${location.ref ?? ''}`;
        let connecting = this.repos.get(key);
        if (!connecting) {
            connecting = this.loadRepo(location).catch((error: unknown) => {
                // don't cache failures; the next access should retry
                this.repos.delete(key);
                throw error;
            });
            this.repos.set(key, connecting);
        }
        return connecting;
    }

    private async loadRepo(location: RepoLocation): Promise<ConnectedRepo> {
        const api = new ForgejoApi(location.origin);
        const ref = location.ref ?? await api.getDefaultBranch(location.owner, location.repo);
        const tree = await api.getTree(location.owner, location.repo, ref);

        // Reads fall through to the (lazy) readable layer; writes (not exposed by the provider yet) would
        // be copied up to the writable layer. Swap InMemory for a persistent backend (e.g. IndexedDB) to
        // keep the local changes across sessions.
        const fs = await resolveMountConfig({
            backend: CopyOnWrite,
            readable: ForgejoReadableFS.fromTree(tree.entries, sha => api.getBlob(location.owner, location.repo, sha)),
            writable: { backend: InMemory },
        });
        // A single path segment, that is unique for repo + ref
        const mountPoint = '/' + encodeURIComponent(`${location.origin}/${location.owner}/${location.repo}@${ref}`);
        if (mounts.has(mountPoint)) {
            // e.g. a previous connect, that was dropped from our cache
            zenfs.umount(mountPoint);
        }
        zenfs.mount(mountPoint, fs);
        return { mountPoint };
    }
}

function parseUri(uri: vscode.Uri): RepoLocation {
    if (uri.scheme !== SCHEME || !uri.authority) {
        throw vscode.FileSystemError.FileNotFound(uri);
    }
    const parts = uri.path.split('/').filter(Boolean);
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) {
        throw vscode.FileSystemError.FileNotFound(uri);
    }
    const params = new URLSearchParams(uri.query);
    const protocol = params.get('protocol')?.toLowerCase() === 'https' ? 'https' : 'http';
    return {
        origin: `${protocol}://${uri.authority}`,
        owner,
        repo,
        path: parts.slice(2).join('/'),
        ref: params.get('ref') ?? undefined,
    };
}

function toFileSystemError(error: unknown, uri: vscode.Uri): Error {
    if (error instanceof vscode.FileSystemError) {
        return error;
    }
    if (error instanceof ForgejoApiError) {
        return error.status === 404
            ? vscode.FileSystemError.FileNotFound(uri)
            : vscode.FileSystemError.Unavailable(error.message);
    }
    // ZenFS errors have POSIX codes
    switch ((error as { code?: string } | undefined)?.code) {
        case 'ENOENT':
            return vscode.FileSystemError.FileNotFound(uri);
        case 'ENOTDIR':
            return vscode.FileSystemError.FileNotADirectory(uri);
        case 'EISDIR':
            return vscode.FileSystemError.FileIsADirectory(uri);
        case 'EROFS':
        case 'EPERM':
        case 'EACCES':
            return vscode.FileSystemError.NoPermissions(uri);
    }
    return vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
}
