import * as vscode from 'vscode';
import * as commandOpenRepo from "./commandOpenRepo.js";
import { ForgejoFileSystemProvider } from './ForgejoFileSystemProvider.js';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		new ForgejoFileSystemProvider().register(),
		commandOpenRepo.register()
	);
}

export function deactivate() { }
