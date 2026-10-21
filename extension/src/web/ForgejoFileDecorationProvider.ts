import * as vscode from 'vscode';
import { ForgejoFileSystemProvider } from './ForgejoFileSystemProvider';
import { isOriginalLayer, Repo } from './Repo';
import { RepoUri } from './RepoUri';
import type { ChangeKind } from './RepoSourceControlChangesWalker';

/**
 * Badges in the explorer for paths that differ from the committed tree.
 * The same list fills the Source Control view; the badge is how those paths are visible in the tree.
 */
export class ForgejoFileDecorationProvider implements vscode.FileDecorationProvider {

    static INSTANCE?: ForgejoFileDecorationProvider;    
    
    private readonly onDidChangeFileDecorationsEmitter = new vscode.EventEmitter<vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this.onDidChangeFileDecorationsEmitter.event;
    
    /**
     * To avoid sending several events until the repo is loaded.
     */
    private readonly reposLoading = new Set<string>();

    constructor(protected forgejoFileSystemProvider: ForgejoFileSystemProvider) {
        ForgejoFileDecorationProvider.INSTANCE = this;
    }

    register(): vscode.Disposable {
        return vscode.Disposable.from(
            vscode.window.registerFileDecorationProvider(this),
            this.onDidChangeFileDecorationsEmitter,
            new vscode.Disposable(() => {
                if (ForgejoFileDecorationProvider.INSTANCE === this) {
                    ForgejoFileDecorationProvider.INSTANCE = undefined;
                }
            }),
        );
    }

    /** Ask the explorer to read these badges again. */
    refresh(uris: vscode.Uri[]) {
        if (uris.length > 0) {
            this.onDidChangeFileDecorationsEmitter.fire(uris);
        }
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== RepoUri.SCHEME || isOriginalLayer(uri)) {
            return undefined;
        }

        const repoOrPromise = Repo.getOrCreate(this.forgejoFileSystemProvider.repoStore, uri);
        if (!(repoOrPromise instanceof Repo)) {
            // so a promise; so repo is loading
            const [repoUriStr] = RepoUri.fileUriToRepoUriStrAndPath(uri);
            if (!this.reposLoading.has(repoUriStr)) {
                this.reposLoading.add(repoUriStr);
                repoOrPromise.then(repo => {
                    this.reposLoading.delete(repoUriStr);
                    // emit for individual resources; there is no down hierarchy
                    const existing = Object.values(repo.sourceControlChanges ?? {}).map(change => change.resourceUri);
                    this.refresh(existing.length > 0 ? existing : [uri]);
                }, () => {
                    this.reposLoading.delete(repoUriStr);
                });
            } // else a second or + hit on the same repo, which is loading; so no need to emit other events
            return undefined;
        }

        const change = repoOrPromise.sourceControlChanges?.[uri.toString(true)];
        return change ? toDecoration(change.kind) : undefined;
    }
}

function toDecoration(kind: ChangeKind): vscode.FileDecoration {
    const decoration = new vscode.FileDecoration(letter(kind), tooltip(kind), new vscode.ThemeColor(color(kind)));
    // Parent folders pick up the mark, so a nested edit is visible without expanding the tree.
    decoration.propagate = kind !== 'deleted';
    return decoration;
}

function letter(kind: ChangeKind): string {
    switch (kind) {
        case 'created':
            return 'A';
        case 'deleted':
            return 'D';
        case 'modified':
            return 'M';
    }
}

function tooltip(kind: ChangeKind): string {
    switch (kind) {
        case 'created':
            return 'Created';
        case 'deleted':
            return 'Deleted';
        case 'modified':
            return 'Modified';
    }
}

function color(kind: ChangeKind): string {
    switch (kind) {
        case 'created':
            return 'forgejo.addedResourceForeground';
        case 'deleted':
            return 'forgejo.deletedResourceForeground';
        case 'modified':
            return 'forgejo.modifiedResourceForeground';
    }
}
