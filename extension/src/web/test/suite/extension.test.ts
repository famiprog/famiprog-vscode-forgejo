import * as assert from 'assert';
import * as vscode from 'vscode';
import { ForgejoFileSystemProvider } from '../../forgejoFileSystemProviderPrototype.js';

suite('Forgejo file system', () => {
	const provider = new ForgejoFileSystemProvider();
	const root = vscode.Uri.parse('forgejo://localhost:3001/forgejo/hello-world');

	test('lists the repository root', async () => {
		const stat = await provider.stat(root);
		assert.strictEqual(stat.type, vscode.FileType.Directory);
		const entries = await provider.readDirectory(root);
		assert.deepStrictEqual(entries, [['README.md', vscode.FileType.File]]);
	});

	test('reads README.md', async () => {
		const uri = vscode.Uri.joinPath(root, 'README.md');
		const stat = await provider.stat(uri);
		assert.strictEqual(stat.type, vscode.FileType.File);
		const text = new TextDecoder().decode(await provider.readFile(uri));
		assert.ok(text.includes('hello-world'));
	});
});
