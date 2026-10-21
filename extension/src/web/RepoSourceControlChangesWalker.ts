import { type CopyOnWriteFS, type FileSystem, isDirectory } from '@zenfs/core';
import * as vscode from 'vscode';
import { Repo, withOriginalLayer } from './Repo';

export type ChangeKind = 'created' | 'modified' | 'deleted';

/** A source-control row, plus the kind the explorer badge is built from. */
export interface SourceControlChange extends vscode.SourceControlResourceState {
    kind: ChangeKind;
}

export type SourceControlChanges = { [fileUriStr: string]: SourceControlChange };

export class RepoSourceControlChangesWalker {

    /**
     * Diff of the writable layer against the readable one.
     *
     * A writable file whose bytes match the readable copy is omitted: it stays on the writable
     * layer (an edit that was saved and then undone) but it is not a pending change.
     * Deletes come from the journal, because those paths are no longer on the writable layer.
     * A path that is in the journal and also on the writable layer was created again, so it is not a delete.
     */
    async listSourceControlChanges(repo: Repo): Promise<SourceControlChanges> {
        const changes: SourceControlChanges = {};
        for (const path of await this.deletedPathsStillGone(repo.fileSystem)) {
            this.addChange(changes, repo, path, 'deleted');
        }
        await this.collectWritable(repo, '/', changes);
        return changes;
    }

    /** Journal deletes expanded to files. A path present on the writable layer is left out. */
    private async deletedPathsStillGone(fs: CopyOnWriteFS): Promise<Set<string>> {
        const deleted = new Set<string>();
        for (const path of this.deletedPaths(fs.journal.toString())) {
            if (await fs.writable.exists(path)) {
                continue;
            }
            for (const expanded of await this.expandDeleted(fs.readable, path)) {
                if (!(await fs.writable.exists(expanded))) {
                    deleted.add(expanded);
                }
            }
        }
        return deleted;
    }

    /**
     * One pass over the writable layer. Change rows are recorded here.
     * Deleted paths are not on this layer, so the walk does not enter them.
     */
    private async collectWritable(repo: Repo, dir: string, changes: SourceControlChanges): Promise<void> {
        const { readable, writable } = repo.fileSystem;
        let names: string[];
        try {
            names = await writable.readdir(dir);
        } catch {
            return;
        }
        for (const name of names) {
            const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
            const stat = await writable.stat(path);
            if (isDirectory(stat)) {
                const children = await writable.readdir(path);
                if (children.length === 0) {
                    if (!(await this.presentOnReadable(repo.fileSystem, path))) {
                        this.addChange(changes, repo, path, 'created');
                    }
                    continue;
                }
                await this.collectWritable(repo, path, changes);
                continue;
            }
            if (!(await this.presentOnReadable(repo.fileSystem, path))) {
                this.addChange(changes, repo, path, 'created');
                continue;
            }
            const committed = await readable.stat(path);
            const committedBytes = stat.size === committed.size
                ? await this.readWhole(readable, path, committed.size)
                : undefined;
            const differs = isDirectory(committed)
                || committedBytes === undefined
                || !this.sameBytes(await this.readWhole(writable, path, stat.size), committedBytes);
            if (differs) {
                this.addChange(changes, repo, path, 'modified');
            }
        }
    }

    private addChange(changes: SourceControlChanges, repo: Repo, path: string, kind: ChangeKind) {
        const change = this.toChange(repo, path, kind);
        changes[change.resourceUri.toString(true)] = change;
    }

    private toChange(repo: Repo, path: string, kind: ChangeKind): SourceControlChange {
        const uri = this.toUri(repo.repoUri, path);
        const name = baseName(uri.path);
        return {
            kind,
            resourceUri: uri,
            command: openCommand(uri, name, kind),
            decorations: {
                strikeThrough: kind === 'deleted',
                tooltip: kind === 'created' ? 'Created' : kind === 'deleted' ? 'Deleted' : 'Modified',
            },
        };
    }

    async presentOnReadable(fs: CopyOnWriteFS, path: string): Promise<boolean> {
        return !fs.journal.isDeleted(path) && await fs.readable.exists(path);
    }

    /** Files under `path`, or `path` itself when it is a file or an empty directory. */
    async expandDeleted(fs: FileSystem, path: string): Promise<string[]> {
        if (!(await fs.exists(path))) {
            return [];
        }
        const stat = await fs.stat(path);
        if (!isDirectory(stat)) {
            return [path];
        }
        const children = await fs.readdir(path);
        if (children.length === 0) {
            return [path];
        }
        const files: string[] = [];
        for (const name of children) {
            const child = `${path}/${name}`;
            files.push(...await this.expandDeleted(fs, child));
        }
        return files;
    }

    deletedPaths(text: string): string[] {
        const paths: string[] = [];
        for (const line of text.split('\n')) {
            if (!line || line.startsWith('#')) {
                continue;
            }
            const space = line.indexOf(' ');
            if (space < 0) {
                continue;
            }
            const op = line.slice(0, space).trim();
            const path = line.slice(space + 1).trim();
            if (op === 'delete' && path) {
                paths.push(path);
            }
        }
        return paths;
    }

    async readWhole(fs: FileSystem, path: string, size: number): Promise<Uint8Array> {
        const data = new Uint8Array(size);
        if (size > 0) {
            await fs.read(path, data, 0, size);
        }
        return data;
    }

    sameBytes(a: Uint8Array, b: Uint8Array): boolean {
        if (a.byteLength !== b.byteLength) {
            return false;
        }
        for (let i = 0; i < a.byteLength; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    toUri(root: vscode.Uri, repoPath: string): vscode.Uri {
        const relative = repoPath.replace(/^\//, '');
        return relative ? vscode.Uri.joinPath(root, relative) : root;
    }

}

function openCommand(uri: vscode.Uri, name: string, kind: ChangeKind): vscode.Command {
    if (kind === 'modified') {
        return {
            title: 'Open',
            command: 'vscode.diff',
            arguments: [withOriginalLayer(uri), uri, `${name} (Working Tree)`],
        };
    }
    if (kind === 'deleted') {
        return {
            title: 'Open',
            command: 'vscode.open',
            arguments: [withOriginalLayer(uri)],
        };
    }
    return {
        title: 'Open',
        command: 'vscode.open',
        arguments: [uri],
    };
}

function baseName(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? path : path.slice(slash + 1);
}
