import { InMemory, resolveMountConfig, type FileSystem } from "@zenfs/core";
import * as assert from "assert";
import * as vscode from "vscode";
import { Repo, withOriginalLayer } from "../../Repo.js";
import { RepoSourceControlChangesWalker, type SourceControlChange } from "../../RepoSourceControlChangesWalker.js";

const text = new TextEncoder();

suite("RepoSourceControlChangesWalker", () => {

    test("listSourceControlChanges", async () => {
        const root = vscode.Uri.parse("forgejo://http/localhost:3001/owner/demo/|");
        const repo = new Repo();
        repo.repoUri = root;
        const readable = await resolveMountConfig({ backend: InMemory });
        await writeFile(readable, "/same.txt", "same");
        await writeFile(readable, "/edit.txt", "old");
        await writeFile(readable, "/gone.txt", "bye");
        await repo.openFileSystem(readable, `walker-test-${Date.now()}-${Math.random()}`);

        await repo.fileSystem.write("/same.txt", text.encode("same"), 0);
        await repo.fileSystem.write("/edit.txt", text.encode("edited"), 0);
        await writeFile(repo.fileSystem, "/added.txt", "fresh");
        await repo.fileSystem.unlink("/gone.txt");

        const changes = Object.values(await new RepoSourceControlChangesWalker().listSourceControlChanges(repo));
        const added = vscode.Uri.joinPath(root, "added.txt");
        const edit = vscode.Uri.joinPath(root, "edit.txt");
        const gone = vscode.Uri.joinPath(root, "gone.txt");
        assert.deepStrictEqual(changes.map(summarize).sort(byPath), [
            { path: added.path, kind: "created", tooltip: "Created", strikeThrough: false, command: "vscode.open", openPath: added.path, openQuery: "" },
            { path: edit.path, kind: "modified", tooltip: "Modified", strikeThrough: false, command: "vscode.diff", openPath: withOriginalLayer(edit).path, openQuery: withOriginalLayer(edit).query },
            { path: gone.path, kind: "deleted", tooltip: "Deleted", strikeThrough: true, command: "vscode.open", openPath: withOriginalLayer(gone).path, openQuery: withOriginalLayer(gone).query },
        ].sort(byPath));
    });
});

async function writeFile(fs: FileSystem, path: string, contents: string): Promise<void> {
    await fs.createFile(path, { uid: 0, gid: 0, mode: 0o644 });
    await fs.write(path, text.encode(contents), 0);
}

function summarize(change: SourceControlChange) {
    const open = change.command!.arguments![0] as vscode.Uri;
    return {
        path: change.resourceUri.path,
        kind: change.kind,
        tooltip: change.decorations?.tooltip,
        strikeThrough: change.decorations?.strikeThrough ?? false,
        command: change.command?.command,
        openPath: open.path,
        openQuery: open.query,
    };
}

function byPath(a: { path: string }, b: { path: string }): number {
    return a.path.localeCompare(b.path);
}
