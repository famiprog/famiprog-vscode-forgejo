import FetchAdapter from '@pollyjs/adapter-fetch';
import { Polly } from '@pollyjs/core';
import FSPersister from '@pollyjs/persister-fs';
import * as assert from 'assert';
import path from 'node:path';
import * as vscode from 'vscode';

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

suite("ForgejoFileSystemProvider", () => {

    /**
     * * WHEN1 first connect to the repo
     * * THEN1 the whole tree of files (w/o content) is requested via API
     *   * and stored in a ZenFS store
     * * WHEN2 read only operations happen
     * * THEN2 data is served from the ZenFS store 
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

        // bug in polly: if ('navigator' in global && !navigator.onLine) {
        // navigator exists, but is undefined
        // @ts-ignore
        delete global.navigator;

        try {
            // `onFileSystem:forgejo` activates the extension, which registers the provider.
            // `workspace.fs` then delegates to it.
            const root = vscode.Uri.parse('forgejo://localhost:3001/forgejo/sample-repo');
            const read = async (filePath: string) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, filePath)));

            // WHEN1 + THEN1: the first operation connects; all the tree comes with a single web service call
            const tree = await walk(root);
            assert.deepStrictEqual(tree, SAMPLE_REPO_TREE);
            assert.deepStrictEqual(requestedPaths, [
                API,
                `${API}/git/trees/main?recursive=true&per_page=1000&page=1`,
            ]);

            // WHEN2 + THEN2: the same operations again => nothing new is requested
            assert.deepStrictEqual(await walk(root), SAMPLE_REPO_TREE);
            assert.strictEqual(requestedPaths.length, 2);

            // The content of a file is requested only when it is read (once)
            assert.strictEqual(await read('README.md'), '# sample-repo\n\n');
            assert.strictEqual(await read('doc/sub1/sub1-1/file1.md'), 'file1.md');
            assert.strictEqual(await read('doc/README.md'), 'A nested file in `doc`.');
            assert.strictEqual(await read('README.md'), '# sample-repo\n\n');
            assert.deepStrictEqual(requestedPaths.slice(2).map(p => p.replace(/[0-9a-f]{40}$/, '<sha>')), [
                `${API}/git/blobs/<sha>`,
                `${API}/git/blobs/<sha>`,
                `${API}/git/blobs/<sha>`,
            ]);
        } finally {
            await polly.stop(); // persists the recording
        }
    });
});

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
