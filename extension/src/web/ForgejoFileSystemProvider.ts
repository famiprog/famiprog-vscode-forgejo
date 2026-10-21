import fs, { type FileSystem, isDirectory, isSymbolicLink } from '@zenfs/core';
import * as vscode from 'vscode';
import { isOriginalLayer, Repo, RepoStore } from './Repo';
import { RepoUri } from './RepoUri';
import { ForgejoApiError } from './ForgejoApi';

/**
 * File system provider for the repos of a Forgejo server.
 *
 * URI format: `forgejo://<protocol>/<host>/<path>/<owner>/<repo>[@ref]/|[/<file>]`.
 * Example: `forgejo://http/localhost:3001/forgejo/hello-world/|`. `ref` defaults to the default branch.
 *
 * * On the first access to a repo, the whole tree (w/o content) is loaded in one go, via web service,
 * and is stored in a ZenFS file system.
 * * Reads are served from that store. The content of a file is fetched from the server the first time it is read.
 * * Writes go to the writable layer of a ZenFS `CopyOnWrite` mount. In the browser that layer is IndexedDB,
 * so the pending changes survive a refresh. They are the staging set shown in Source Control.
 * * `?layer=original` reads the committed bytes, for diffs against the writable layer.
 */
export class ForgejoFileSystemProvider implements vscode.FileSystemProvider {

    static INSTANCE?: ForgejoFileSystemProvider;

    private readonly onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.onDidChangeFileEmitter.event;

    repoStore: RepoStore = {};

    constructor() {
        ForgejoFileSystemProvider.INSTANCE = this;
    }

    register() {
        return vscode.Disposable.from(
            vscode.workspace.registerFileSystemProvider(RepoUri.SCHEME, this, {
                isCaseSensitive: true,
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(async event => {
                for (const folder of event.removed) {
                    if (folder.uri.scheme !== RepoUri.SCHEME) {
                        return;
                    }
                    this.removeRepo(folder);
                }
            }),
            new vscode.Disposable(() => this.dispose()),
        );
    }

    private async removeRepo(folder: vscode.WorkspaceFolder) {
        const [repoUriStr] = RepoUri.fileUriToRepoUriStrAndPath(folder.uri);
        const repoOrPromise = this.repoStore[repoUriStr];
        // if needed, if "false" we might readd the repo
        await this.closeEditors(repoUriStr);
        if (!repoOrPromise) {
            // in theory shouldn't happen; if editors => repo exists
            return;
        }
        const pending = repoOrPromise instanceof Repo ? Promise.resolve(repoOrPromise) : repoOrPromise;
        const repo = await pending.catch(() => undefined);
        if (!repo) {
            return;
        }
        delete this.repoStore[repoUriStr];
        repo.dispose();
    }

    /** `true` when every editor of the repo closed. `false` when a dirty editor's save dialog was cancelled. */
    private async closeEditors(repoUriStr: string) {
        const tabs: vscode.Tab[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tabInRepo(tab, repoUriStr)) {
                    tabs.push(tab);
                }
            }
        }
        if (tabs.length === 0) {
            return true;
        }
        return await vscode.window.tabGroups.close(tabs, true);
    }

    watch(): vscode.Disposable {
        // Changes are pushed through `onDidChangeFile` after each write.
        return new vscode.Disposable(() => { });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        return this.run(uri, async (repo, repoPath, pathWithMountPoint) => {
            if (isOriginalLayer(uri)) {
                return this.toFileStat(await repo.fileSystem.readable.stat(repoPath), true);
            }
            return this.toFileStat(await fs.promises.lstat(pathWithMountPoint), false);
        });
    }

    protected toFileStat(stats: { mode: number; size: number; ctimeMs?: number; mtimeMs?: number }, readonly: boolean): vscode.FileStat {
        let type: vscode.FileType;
        if (isDirectory(stats)) {
            type = vscode.FileType.Directory;
        } else if (isSymbolicLink(stats)) {
            type = vscode.FileType.SymbolicLink | vscode.FileType.File;
        } else {
            type = vscode.FileType.File;
        }
        return {
            type,
            ctime: stats.ctimeMs ?? 0,
            mtime: stats.mtimeMs ?? 0,
            size: stats.size,
            permissions: readonly ? vscode.FilePermission.Readonly : undefined,
        };
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        return this.run(uri, async (_repo, _repoPath, pathWithMountPoint) => {
            const entries = await fs.promises.readdir(pathWithMountPoint, { withFileTypes: true });
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
        return this.run(uri, async (repo, repoPath, pathWithMountPoint) => {
            if (isOriginalLayer(uri)) {
                const stat = await repo.fileSystem.readable.stat(repoPath);
                if (isDirectory(stat)) {
                    throw vscode.FileSystemError.FileIsADirectory(uri);
                }
                return readWhole(repo.fileSystem.readable, repoPath, stat.size);
            }
            // ZenFS silently returns empty content when asked to read a directory
            if ((await fs.promises.stat(pathWithMountPoint)).isDirectory()) {
                throw vscode.FileSystemError.FileIsADirectory(uri);
            }
            const content = await fs.promises.readFile(pathWithMountPoint);
            return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        });
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        this.assertWritable(uri);
        await this.mutate(uri, vscode.FileChangeType.Created, (_repo, pathWithMountPoint) => fs.promises.mkdir(pathWithMountPoint));
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        this.assertWritable(uri);
        await this.mutate(uri, vscode.FileChangeType.Changed, async (repo, pathWithMountPoint) => {
            let exists = false;
            try {
                const stat = await fs.promises.stat(pathWithMountPoint);
                if (stat.isDirectory()) {
                    throw vscode.FileSystemError.FileIsADirectory(uri);
                }
                exists = true;
            } catch (error) {
                if (!isMissing(error)) {
                    throw error;
                }
            }
            if (exists && !options.overwrite) {
                throw vscode.FileSystemError.FileExists(uri);
            }
            if (!exists && !options.create) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            const parent = directoryName(pathWithMountPoint);
            // The mount point already exists. `mkdir` on it would fail, and a file in the repo root needs no new parent.
            if (parent !== repo.mountPoint) {
                await fs.promises.mkdir(parent, { recursive: true });
            }
            await fs.promises.writeFile(pathWithMountPoint, content);
        });
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        this.assertWritable(uri);
        await this.mutate(uri, vscode.FileChangeType.Deleted, async (_repo, pathWithMountPoint) => {
            const stat = await fs.promises.lstat(pathWithMountPoint);
            if (stat.isDirectory()) {
                await fs.promises.rm(pathWithMountPoint, { recursive: options.recursive });
            } else {
                await fs.promises.unlink(pathWithMountPoint);
            }
        });
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        this.assertWritable(oldUri);
        this.assertWritable(newUri);
        await this.mutate(oldUri, vscode.FileChangeType.Deleted, async (repo, oldPath) => {
            const target = await Repo.getOrCreate(this.repoStore, newUri);
            const newPath = RepoUri.fileUriToRepoUriStrAndPath(newUri)[2];
            if (await fs.promises.exists(newPath)) {
                if (!options.overwrite) {
                    throw vscode.FileSystemError.FileExists(newUri);
                }
                await fs.promises.rm(newPath, { recursive: true });
            }
            await fs.promises.rename(oldPath, newPath);
            // A rename into another repo updates that repo's writable layer and journal too.
            if (target.mountPoint !== repo.mountPoint) {
                await target.journal.backup();
                target.refreshSourceControlDebounced();
            }
        }, [{ type: vscode.FileChangeType.Created, uri: newUri }]);
    }

    /** Unmounts all the connected repos and drops their in-memory cache. IndexedDB keeps the writable layer. */
    dispose(): void {
        if (ForgejoFileSystemProvider.INSTANCE === this) {
            ForgejoFileSystemProvider.INSTANCE = undefined;
        }
        for (const connecting of Object.values(this.repoStore)) {
            const pending = connecting instanceof Repo ? Promise.resolve(connecting) : connecting;
            pending.then(repo => {
                repo.dispose();
            });
        }
        this.repoStore = {};
        this.onDidChangeFileEmitter.dispose();
    }

    private async run<T>(fileUri: vscode.Uri, operation: (repo: Repo, repoPath: string, pathWithMountPoint: string) => Promise<T>): Promise<T> {
        try {
            const spl = RepoUri.fileUriToRepoUriStrAndPath(fileUri);
            return await operation(await Repo.getOrCreate(this.repoStore, fileUri), spl[1], spl[2]);
        } catch (error) {
            throw toFileSystemError(error, fileUri);
        }
    }

    /** Applies `operation` on the writable layer, then persists the delete journal and notifies listeners. */
    private async mutate(
        uri: vscode.Uri,
        type: vscode.FileChangeType,
        operation: (repo: Repo, pathWithMountPoint: string) => Promise<void>,
        extra: vscode.FileChangeEvent[] = [],
    ): Promise<void> {
        const repo = await this.run(uri, async (connected, _repoPath, pathWithMountPoint) => {
            await operation(connected, pathWithMountPoint);
            return connected;
        });
        await repo.journal.backup();
        // better to call directly, instead of having source control listen to events;
        // this way only the sc of this repo reacts; events are global (and if filter => more logic to look at url)
        repo.refreshSourceControlDebounced();
        this.onDidChangeFileEmitter.fire([{ type, uri }, ...extra]);
    }

    private assertWritable(uri: vscode.Uri): void {
        if (isOriginalLayer(uri)) {
            throw vscode.FileSystemError.NoPermissions('The committed file is read-only');
        }
    }
}

async function readWhole(fileSystem: FileSystem, path: string, size: number): Promise<Uint8Array> {
    const data = new Uint8Array(size);
    if (size > 0) {
        await fileSystem.read(path, data, 0, size);
    }
    return data;
}

function directoryName(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash <= 0 ? '/' : path.slice(0, slash);
}

function isMissing(error: unknown): boolean {
    return (error as { code?: string } | undefined)?.code === 'ENOENT'
        || error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function tabInRepo(tab: vscode.Tab, repoUriStr: string): boolean {
    const input = tab.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
        return uriInRepo(input.uri, repoUriStr);
    }
    if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
        return uriInRepo(input.original, repoUriStr) || uriInRepo(input.modified, repoUriStr);
    }
    return false;
}

function uriInRepo(uri: vscode.Uri, repoUriStr: string): boolean {
    if (uri.scheme !== RepoUri.SCHEME) {
        return false;
    }
    return RepoUri.fileUriToRepoUriStrAndPath(uri)[0] === repoUriStr;
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
        case 'EEXIST':
            return vscode.FileSystemError.FileExists(uri);
        case 'ENOTEMPTY':
            return vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
        case 'EROFS':
        case 'EPERM':
        case 'EACCES':
            return vscode.FileSystemError.NoPermissions(uri);
    }
    return vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
}
