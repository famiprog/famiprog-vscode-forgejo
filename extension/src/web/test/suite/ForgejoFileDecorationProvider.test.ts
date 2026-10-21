import * as assert from "assert";
import * as vscode from "vscode";
import { ForgejoFileDecorationProvider } from "../../ForgejoFileDecorationProvider.js";
import type { ForgejoFileSystemProvider } from "../../ForgejoFileSystemProvider.js";
import { Repo, withOriginalLayer } from "../../Repo.js";
import { RepoUri } from "../../RepoUri.js";
import type { SourceControlChange } from "../../RepoSourceControlChangesWalker.js";

suite("ForgejoFileDecorationProvider", () => {

    test("badge comes from the repo change list", () => {
        const root = vscode.Uri.parse("forgejo://http/localhost:3001/owner/demo/|");
        const modified = vscode.Uri.joinPath(root, "edit.txt");
        const deleted = vscode.Uri.joinPath(root, "gone.txt");
        const repo = new Repo();
        repo.sourceControlChanges = {
            [modified.toString(true)]: change(modified, "modified"),
            [deleted.toString(true)]: change(deleted, "deleted"),
        };
        const decorations = providerFor(modified, repo);

        const modifiedBadge = decorations.provideFileDecoration(modified);
        assert.strictEqual(modifiedBadge?.badge, "M");
        assert.strictEqual(modifiedBadge?.tooltip, "Modified");
        assert.strictEqual(modifiedBadge?.propagate, true);

        const deletedBadge = decorations.provideFileDecoration(deleted);
        assert.strictEqual(deletedBadge?.badge, "D");
        assert.strictEqual(deletedBadge?.tooltip, "Deleted");
        assert.strictEqual(deletedBadge?.propagate, false);

        assert.strictEqual(decorations.provideFileDecoration(vscode.Uri.joinPath(root, "same.txt")), undefined);
        assert.strictEqual(decorations.provideFileDecoration(withOriginalLayer(modified)), undefined);
        assert.strictEqual(decorations.provideFileDecoration(vscode.Uri.parse("file:///edit.txt")), undefined);
    });

    test("asks again once the repo exists", async () => {
        const root = vscode.Uri.parse("forgejo://http/localhost:3001/owner/demo/|");
        const added = vscode.Uri.joinPath(root, "added.txt");
        const repo = new Repo();
        repo.sourceControlChanges = {
            [added.toString(true)]: change(added, "created"),
        };
        let resolveRepo: (repo: Repo) => void;
        const pending = new Promise<Repo>(resolve => {
            resolveRepo = resolve;
        });
        const [repoUriStr] = RepoUri.fileUriToRepoUriStrAndPath(added);
        const repoStore: ForgejoFileSystemProvider["repoStore"] = { [repoUriStr]: pending };
        // Same hand-off as Repo.getOrCreate: the store holds the repo once loading finishes.
        pending.then(created => {
            repoStore[repoUriStr] = created;
        });
        const decorations = new ForgejoFileDecorationProvider({ repoStore } as ForgejoFileSystemProvider);
        const refreshed: vscode.Uri[][] = [];
        decorations.onDidChangeFileDecorations(uris => refreshed.push([...uris]));

        assert.strictEqual(decorations.provideFileDecoration(added), undefined);
        resolveRepo!(repo);
        await pending;
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.deepStrictEqual(refreshed.map(batch => batch.map(uri => uri.toString(true))), [[added.toString(true)]]);
        assert.strictEqual(decorations.provideFileDecoration(added)?.badge, "A");
    });
});

function providerFor(file: vscode.Uri, repo: Repo | Promise<Repo>): ForgejoFileDecorationProvider {
    const [repoUriStr] = RepoUri.fileUriToRepoUriStrAndPath(file);
    return new ForgejoFileDecorationProvider({ repoStore: { [repoUriStr]: repo } } as ForgejoFileSystemProvider);
}

function change(uri: vscode.Uri, kind: SourceControlChange["kind"]): SourceControlChange {
    return { kind, resourceUri: uri };
}
