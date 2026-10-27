import * as vscode from 'vscode';
import * as commandOpenRepo from "./commandOpenRepo.js";
import * as commandSetAccessToken from "./commandSetAccessToken.js";
import { ForgejoFileDecorationProvider } from './ForgejoFileDecorationProvider.js';
import { ForgejoFileSystemProvider } from './ForgejoFileSystemProvider.js';
import { RepoUri } from './RepoUri.js';

export { ForgejoFileSystemProvider };

export function activate(context: vscode.ExtensionContext) {
	// A folder opened from `?repoUrl=` is named `|`, the last segment of the repo URI.
	// `Forgejo: Open repo` sets owner/repo instead. Match that before the provider listens
	// for folder removal, and ignore a removal that is only this rename.
	for (const folder of [...(vscode.workspace.workspaceFolders ?? [])]) {
		if (folder.uri.scheme === RepoUri.SCHEME && folder.name === RepoUri.SEPARATOR) {
			vscode.workspace.updateWorkspaceFolders(folder.index, 1, {
				uri: folder.uri,
				name: commandOpenRepo.folderName(folder.uri),
			});
		}
	}
	const provider = new ForgejoFileSystemProvider();
	const decorations = new ForgejoFileDecorationProvider(provider);
	context.subscriptions.push(
		provider.register(),
		decorations.register(),
		commandOpenRepo.register(),
		commandSetAccessToken.register(provider)
	);
}

export function deactivate() { }
