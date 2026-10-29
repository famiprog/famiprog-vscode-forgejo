import * as vscode from 'vscode';
import * as commandMenu from "./commandMenu.js";
import * as commandOpenMyRepo from "./commandOpenMyRepo.js";
import * as commandOpenMyRepos from "./commandOpenMyRepos.js";
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
		commandMenu.register(),
		commandOpenRepo.register(),
		commandOpenMyRepo.register(),
		commandOpenMyRepos.register(),
		commandSetAccessToken.register(provider)
	);
}

export function deactivate() { }
