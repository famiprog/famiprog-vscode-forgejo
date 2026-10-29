import FetchAdapter from '@pollyjs/adapter-fetch';
import { Polly } from '@pollyjs/core';
import FSPersister from '@pollyjs/persister-fs';
import * as assert from 'assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ForgejoFileSystemProvider } from '../../web/ForgejoFileSystemProvider';
import { RepoUri } from '../../web/RepoUri';
import type { Repo } from '../../web/Repo';

Polly.register(FetchAdapter);
Polly.register(FSPersister);

const { File, Directory } = vscode.FileType;

// The content of `forgejo-tests/sample-repo`, as committed on the `main` branch of
// http://localhost:3001/forgejo/sample-repo. [path, type, size]
const SAMPLE_REPO_TREE: [string, vscode.FileType, number][] = [
    ['README.md', File, 15],
    ['doc', Directory, 0],
    ['doc/README.md', File, 23],
    ['doc/sub1', Directory, 0],
    ['doc/sub1/README.md', File, 24],
    ['doc/sub1/sub1-1', Directory, 0],
    ['doc/sub1/sub1-1/file1.md', File, 8],
    ['doc/sub1/sub1-1/file2.md', File, 8],
    ['doc/sub1/sub1-2', Directory, 0],
    ['doc/sub1/sub1-2/file3.md', File, 8],
    ['doc/sub1/sub1-2/file4.md', File, 8],
    ['doc/sub2', Directory, 0],
    ['doc/sub2/README.md', File, 24],
    ['doc/sub2/sub2-1', Directory, 0],
    ['doc/sub2/sub2-1/file5.md', File, 8],
    ['doc/sub2/sub2-1/file6.md', File, 8],
    ['doc/sub2/sub2-2', Directory, 0],
    ['doc/sub2/sub2-2/file7.md', File, 8],
    ['doc/sub2/sub2-2/file8.md', File, 8],
];

const API = '/api/v1/repos/forgejo/sample-repo';

/** The provider `activate` constructed. Load the module VS Code loaded; this bundle's import is another copy. */
function provider(): ForgejoFileSystemProvider {
    const nodeRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const main = nodeRequire(path.join(process.cwd(), 'dist/node/extension.cjs')) as typeof import('../../web/extension');
    const instance = main.ForgejoFileSystemProvider.INSTANCE;
    assert.ok(instance);
    return instance;
}

suite("ForgejoFileSystemProvider", () => {

    // bug in polly: if ('navigator' in global && !navigator.onLine) {
    // navigator exists, but is undefined
    // @ts-ignore
    delete global.navigator;

    /**
     * `Open repo`. Bootstrap of the "forgejo in vs code" experience. When the user inputs an URL of a forgejo repo, then a new workspace dir 
     * is added w/ the `forgejo` scheme and "our URI". Because of the scheme, all the FS operations are managed by `ForgejoFileSystemProvider`.
     *
     * No tests.
     */
    // @Scenario
    test("command_open_repo", () => {
    })

    /**
     * On first connect to a repo (which happens when opening  workspace top dir w/ "our" URI; this dir may be have been added in the workspace via the 
     * "open repo" command) => the whole tree of files (w/o content) is requested via API (and stored in a ZenFS store). When a file is opened in the editor,
     * a new API call is made to retrieve its content, which is then cached in memory.
     * 
     * ## GWT
     * 
     * * WHEN1 first connect to the repo
     * * THEN1a the repo appears under the "Source Control" tab
     * * THEN1b the whole tree of files (w/o content) is requested via API
     * * WHEN2 browse operations happen
     * * THEN2 data is served from the ZenFS store
     * * WHEN3 open file
     * * THEN3 file requested via API
     * * WHEN4 open same file again
     * * THEN4 file comes from mem; no API hit
     * 
     * @see forgejo-tests/run.mjs
     */
    // @Scenario
    test("initial_tree_load_and_read_only_ops", async function () {
        // Records the requests the first time (needs the Forgejo server); replays them afterwards.
        // The fs persister reads and writes the recording itself, so no extra server is involved.
        const polly = new Polly("initial_tree_load_and_read_only_ops", {
            adapters: ['fetch'],
            persister: 'fs',
            persisterOptions: {
                fs: { recordingsDir: path.join(process.cwd(), 'src/node/test/recordings') },
            },
        });
        const requestedPaths: string[] = [];
        polly.server.any().on('request', req => {
            const url = new URL(req.url);
            requestedPaths.push(url.pathname + url.search);
        });

        try {
            // `onFileSystem:forgejo` activates the extension, which registers the provider.
            // `workspace.fs` then delegates to it.
            const root = vscode.Uri.parse('forgejo://http/localhost:3001/forgejo/sample-repo/|');
            const read = async (filePath: string) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, filePath)));

            // WHEN1
            const tree = await walk(root);
            // THEN1a
            const repo = provider().repoStore[root.toString(true)] as Repo;
            assert.strictEqual(repo.sourceControl.id, RepoUri.SCHEME);
            assert.strictEqual(repo.sourceControl.label, 'forgejo/sample-repo');
            // THEN1b
            assert.deepStrictEqual(tree, SAMPLE_REPO_TREE);
            assert.deepStrictEqual(requestedPaths, [
                API,
                `${API}/git/trees/main?recursive=true&per_page=1000&page=1`,
            ]);

            // WHEN2
            const browsed = await walk(root);
            // THEN2
            assert.deepStrictEqual(browsed, SAMPLE_REPO_TREE);
            assert.strictEqual(requestedPaths.length, 2);

            // WHEN3
            assert.strictEqual(await read('README.md'), '# sample-repo\n\n');
            assert.strictEqual(await read('doc/sub1/sub1-1/file1.md'), 'file1.md');
            assert.strictEqual(await read('doc/README.md'), 'A nested file in `doc`.');
            // THEN3
            assert.deepStrictEqual(requestedPaths.slice(2).map(p => p.replace(/[0-9a-f]{40}$/, '<sha>')), [
                `${API}/git/blobs/<sha>`,
                `${API}/git/blobs/<sha>`,
                `${API}/git/blobs/<sha>`,
            ]);

            // WHEN4
            assert.strictEqual(await read('README.md'), '# sample-repo\n\n');
            // THEN4
            assert.strictEqual(requestedPaths.length, 5);
        } finally {
            await polly.stop(); // persists the recording
        }
    });

    /**
     * When file modifications are done (edits, adds, deletes), then the modified file is stored in a ZenFS "copy on write" FS, using a 
     * writeable FS using `IndexedDB`. Hence persistence across browser refresh. 
     * 
     * ## GWT 
     * 
     * * WHEN1 modifs are done via VS Code
     * * THEN1a we see them in ZenFS (the writeable FS and journal)
     * * THEN1b we see them in the "Source control" tab
     * 
     * @see forgejo-tests/run.mjs
     */
    // @Scenario
    test("store_modifications", async function () {
        this.timeout(10_000);
        const polly = new Polly("initial_tree_load_and_read_only_ops", {
            adapters: ['fetch'],
            persister: 'fs',
            persisterOptions: {
                fs: { recordingsDir: path.join(process.cwd(), 'src/node/test/recordings') },
            },
        });
        try {
            const root = vscode.Uri.parse('forgejo://http/localhost:3001/forgejo/sample-repo/|');
            const readme = vscode.Uri.joinPath(root, 'README.md');
            const added = vscode.Uri.joinPath(root, 'added.txt');
            const gone = vscode.Uri.joinPath(root, 'doc/sub1/sub1-1/file1.md');
            const text = new TextEncoder();

            // WHEN1
            await vscode.workspace.fs.writeFile(readme, text.encode('changed\n'));
            await vscode.workspace.fs.writeFile(added, text.encode('fresh\n'));
            await vscode.workspace.fs.delete(gone, { recursive: false });

            const repo = provider().repoStore[root.toString(true)] as Repo;
            // THEN1a
            assert.strictEqual(await readLayer(repo.fileSystem.writable, '/README.md'), 'changed\n');
            assert.strictEqual(await readLayer(repo.fileSystem.writable, '/added.txt'), 'fresh\n');
            assert.strictEqual(await repo.fileSystem.readable.exists('/added.txt'), false);
            assert.strictEqual(await repo.fileSystem.writable.exists('/doc/sub1/sub1-1/file1.md'), false);
            assert.strictEqual(repo.journal.isDeleted('/doc/sub1/sub1-1/file1.md'), true);
            // THEN1b
            await waitForChanges(repo, {
                [readme.toString(true)]: 'modified',
                [added.toString(true)]: 'created',
                [gone.toString(true)]: 'deleted',
            });
        } finally {
            await polly.stop();
        }
    });

    /**
     * In tabs `Explorer` and `Source Control`, the modified files (i.e. the ones from the writeable layer of ZenFS) are shown decorated
     * w/ letters: A(dded), M(odified), D(eleted)
     * 
     * No tests.
     */
    // @Scenario
    test("decorate_modified_files", async function () {
    });

});

async function readLayer(layer: Repo['fileSystem']['writable'], repoPath: string): Promise<string> {
    const stat = await layer.stat(repoPath);
    const data = new Uint8Array(stat.size);
    if (stat.size > 0) {
        await layer.read(repoPath, data, 0, stat.size);
    }
    return new TextDecoder().decode(data);
}

/** The source-control list is filled 200ms after a write, once the diff walk finishes. */
async function waitForChanges(repo: Repo, expected: { [uri: string]: string }): Promise<void> {
    const deadline = Date.now() + 2000;
    let actual: { [uri: string]: string } = {};
    while (Date.now() < deadline) {
        actual = {};
        for (const change of Object.values(repo.sourceControlChanges ?? {})) {
            actual[change.resourceUri.toString(true)] = change.kind;
        }
        if (sameChanges(actual, expected)) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepStrictEqual(actual, expected);
}

function sameChanges(actual: { [uri: string]: string }, expected: { [uri: string]: string }): boolean {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

/** Recursively lists the repo, using only `readDirectory` and `stat`. Result is sorted by path. */
async function walk(directory: vscode.Uri, prefix = ''): Promise<[string, vscode.FileType, number][]> {
    const result: [string, vscode.FileType, number][] = [];
    for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
        const uri = vscode.Uri.joinPath(directory, name);
        const stat = await vscode.workspace.fs.stat(uri);
        assert.strictEqual(stat.type, type);
        result.push([prefix + name, type, stat.size]);
        if (type === Directory) {
            result.push(...await walk(uri, `${prefix}${name}/`));
        }
    }
    return result.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
