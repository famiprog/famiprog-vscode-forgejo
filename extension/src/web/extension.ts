import * as vscode from 'vscode';
import * as commandOpenRepo from "./commandOpenRepo.js";
import { ForgejoFileDecorationProvider } from './ForgejoFileDecorationProvider.js';
import { ForgejoFileSystemProvider } from './ForgejoFileSystemProvider.js';

export { ForgejoFileSystemProvider };

export function activate(context: vscode.ExtensionContext) {
	const provider = new ForgejoFileSystemProvider();
	const decorations = new ForgejoFileDecorationProvider(provider);
	context.subscriptions.push(
		provider.register(),
		decorations.register(),
		commandOpenRepo.register()
	);
}

export function deactivate() { }
