import fs, { CopyOnWrite, CopyOnWriteFS, FileSystem, InMemory, resolveMountConfig } from "@zenfs/core";
import { IndexedDB } from "@zenfs/dom";
import * as vscode from 'vscode';
import { ForgejoApi } from "./ForgejoApi";
import { ForgejoFetchFS } from "./ForgejoFetchFS";
import { ForgejoJournal } from "./ForgejoJournal";
import { RepoUri } from "./RepoUri";
import { ForgejoFileDecorationProvider } from "./ForgejoFileDecorationProvider";
import { RepoSourceControlChangesWalker, SourceControlChanges } from "./RepoSourceControlChangesWalker";

export type RepoStore = { [repoUriStr: string]: Promise<Repo> | Repo };

export class Repo {

    protected api!: ForgejoApi;
    repoUri!: vscode.Uri;
    mountPoint!: string;
    journal!: ForgejoJournal;

    sourceControl!: vscode.SourceControl;
    protected sourceControlChangesUi!: vscode.SourceControlResourceGroup;
    sourceControlChanges?: SourceControlChanges;
    protected refreshSourceControlDebouncedTimer?: ReturnType<typeof setTimeout>;

    /**
     * Longer name to avoid confusion w/ `fs` = @zenfs/core
     */
    fileSystem!: CopyOnWriteFS;

    public static getOrCreate(repoStore: RepoStore, fileUri: vscode.Uri) {
        const [repoUriStr] = RepoUri.fileUriToRepoUriStrAndPath(fileUri);
        let repo = repoStore[repoUriStr];
        if (!repo) {
            const pending = this.create(repoUriStr).then(created => {
                repoStore[repoUriStr] = created;
                return created;
            });
            // A failed connect must not stick, so the next access can try again.
            void pending.catch(() => {
                if (repoStore[repoUriStr] === pending) {
                    delete repoStore[repoUriStr];
                }
            });
            repo = repoStore[repoUriStr] = pending;
        }
        return repo;
    }

    protected static async create(repoUriStr: string) {
        const repo = new Repo();
        const repoUri = repo.repoUri = vscode.Uri.parse(repoUriStr);
        const repoLocation = RepoUri.toRepoLocation(repoUri);
        {
            // API
            repo.api = new ForgejoApi(repoLocation.origin, repoLocation.owner, repoLocation.repoName, repoLocation.ref);
        }

        {
            // zen fs
            repo.mountPoint = RepoUri.mountPoint(repoUriStr);
            await repo.openFileSystem(await ForgejoFetchFS.create(repo.api), repoUriStr);
            fs.mount(repo.mountPoint, repo.fileSystem);
        }

        {
            // source control
            const sourceControl = repo.sourceControl = vscode.scm.createSourceControl(RepoUri.SCHEME, repoLocation.owner + "/" + repoLocation.repoName, repoUri);
            const sourceControlChanges = repo.sourceControlChangesUi = sourceControl.createResourceGroup('changes', 'Changes');
            sourceControlChanges.hideWhenEmpty = false;
            // Commit is not implemented yet. The list is the staging area; the message box would imply otherwise.
            sourceControl.inputBox.visible = false;
            sourceControl.quickDiffProvider = {
                provideOriginalResource: uri => {
                    if (uri.scheme !== repoUri.scheme || isOriginalLayer(uri) || !owns(repoUri, uri)) {
                        return undefined;
                    }
                    return withOriginalLayer(uri);
                },
            };
            void repo.refreshSourceControl();
        }

        return repo;
    }

    dispose() {
        fs.umount(this.mountPoint);
        if (this.refreshSourceControlDebouncedTimer !== undefined) {
            clearTimeout(this.refreshSourceControlDebouncedTimer);
            this.refreshSourceControlDebouncedTimer = undefined;
        }
        const previous = Object.values(this.sourceControlChanges ?? {});
        this.sourceControlChanges = undefined;
        this.sourceControl.dispose();
        this.refreshFileDecorations(previous);
    }

    async openFileSystem(readable: FileSystem, storeName: string) {
        const writable = await Repo.getIndexedDB() ? await resolveMountConfig({ backend: IndexedDB, storeName }) : await resolveMountConfig({ backend: InMemory });
        this.journal = await ForgejoJournal.restore(storeName);
        this.fileSystem = await resolveMountConfig({
            backend: CopyOnWrite,
            readable,
            writable,
            journal: this.journal,
        }) as CopyOnWriteFS;
    }

    /**
     * @returns `undefined` for the case "run in vscode host, and not browser"
     */
    static async getIndexedDB() {
        const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
        if (idb && await IndexedDB.isAvailable({ idbFactory: idb })) {
            return idb;
        }
        return undefined;
    }

    async refreshSourceControl() {
        const previous = Object.values(this.sourceControlChanges ?? {});
        const changes = await new RepoSourceControlChangesWalker().listSourceControlChanges(this);
        // Closed while the diff was running. The group is disposed.
        if (!this.sourceControl) {
            return;
        }
        this.sourceControlChanges = changes;
        this.sourceControlChangesUi.resourceStates = Object.values(changes);
        this.refreshFileDecorations([...previous, ...Object.values(changes)]);
    }

    private refreshFileDecorations(changes: { resourceUri: vscode.Uri }[]) {
        const uris = new Map<string, vscode.Uri>();
        for (const change of changes) {
            uris.set(change.resourceUri.toString(true), change.resourceUri);
        }
        if (uris.size > 0) {
            ForgejoFileDecorationProvider.INSTANCE?.refresh([...uris.values()]);
        }
    }

    async refreshSourceControlDebounced() {
        // The view is already closed.
        if (!this.sourceControl) {
            return;
        }
        if (this.refreshSourceControlDebouncedTimer !== undefined) {
            // a refresh is already planned
            return;
        }
        this.refreshSourceControlDebouncedTimer = setTimeout(() => {
            try {
                this.refreshSourceControl()
            } finally {
                this.refreshSourceControlDebouncedTimer = undefined;
            }
        }, 200);
    }

}

function owns(repoUri: vscode.Uri, resource: vscode.Uri): boolean {
    if (repoUri.scheme !== resource.scheme || repoUri.authority !== resource.authority) {
        return false;
    }
    const root = repoUri.path.endsWith("/") ? repoUri.path.slice(0, -1) : repoUri.path;
    return resource.path === root || resource.path.startsWith(`${root}/`);
}

const LAYER = 'layer';
const ORIGINAL = 'original';

/** URI of the committed bytes, used as the left side of a diff. Same path, `layer=original` in the query. */
export function withOriginalLayer(uri: vscode.Uri): vscode.Uri {
    const params = new URLSearchParams(uri.query);
    params.set(LAYER, ORIGINAL);
    return uri.with({ query: params.toString() });
}

export function isOriginalLayer(uri: vscode.Uri): boolean {
    return new URLSearchParams(uri.query).get(LAYER) === ORIGINAL;
}