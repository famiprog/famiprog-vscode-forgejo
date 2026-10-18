import * as vscode from 'vscode';
import * as commandOpenRepo from "./commandOpenRepo.js";
import { ForgejoFileSystemProvider } from './forgejoFileSystemProviderPrototype.js';

export function activate(context: vscode.ExtensionContext) {
	const provider = new ForgejoFileSystemProvider();
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider('forgejo', provider, {
			isCaseSensitive: true,
			isReadonly: true,
		}),
		commandOpenRepo.register()
	);
}

export function deactivate() { }
