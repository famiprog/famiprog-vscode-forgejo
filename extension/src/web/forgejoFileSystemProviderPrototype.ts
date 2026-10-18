import * as vscode from 'vscode';

export const SCHEME = 'forgejo';

interface ForgejoEntry {
	name: string;
	path: string;
	type: string;
	size: number;
	encoding: string | null;
	content: string | null;
	download_url: string | null;
	last_commit_when?: string | null;
}

interface RepoLocation {
	origin: string;
	owner: string;
	repo: string;
	path: string;
	ref?: string;
}

export class ForgejoFileSystemProvider implements vscode.FileSystemProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private readonly contentsCache = new Map<string, ForgejoEntry | ForgejoEntry[]>();
	private readonly branchCache = new Map<string, Promise<string>>();

	readonly onDidChangeFile = this.emitter.event;

	watch(): vscode.Disposable {
		return new vscode.Disposable(() => { });
	}

	async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
		const data = await this.getContents(uri);
		if (Array.isArray(data)) {
			return this.toStat(vscode.FileType.Directory, 0);
		}
		return this.toStat(toFileType(data.type), data.size, data.last_commit_when);
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const data = await this.getContents(uri);
		if (!Array.isArray(data)) {
			throw vscode.FileSystemError.FileNotADirectory(uri);
		}
		return data.map((entry) => [entry.name, toFileType(entry.type)]);
	}

	async readFile(uri: vscode.Uri): Promise<Uint8Array> {
		const data = await this.getContents(uri);
		if (Array.isArray(data)) {
			throw vscode.FileSystemError.FileIsADirectory(uri);
		}
		if (data.encoding === 'base64' && typeof data.content === 'string') {
			return decodeBase64(data.content);
		}
		if (data.download_url) {
			const response = await fetch(data.download_url);
			if (!response.ok) {
				throw vscode.FileSystemError.Unavailable(data.download_url);
			}
			return new Uint8Array(await response.arrayBuffer());
		}
		return new Uint8Array();
	}

	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions('Forgejo file system is read-only');
	}

	writeFile(): void {
		throw vscode.FileSystemError.NoPermissions('Forgejo file system is read-only');
	}

	delete(): void {
		throw vscode.FileSystemError.NoPermissions('Forgejo file system is read-only');
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions('Forgejo file system is read-only');
	}

	private async getContents(uri: vscode.Uri): Promise<ForgejoEntry | ForgejoEntry[]> {
		const location = parseUri(uri);
		const ref = location.ref ?? await this.getDefaultBranch(location);
		const cacheKey = `${location.origin}/${location.owner}/${location.repo}@${ref}/${location.path}`;
		const cached = this.contentsCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const url = new URL(
			`/api/v1/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/contents/${encodePath(location.path)}`,
			location.origin,
		);
		url.searchParams.set('ref', ref);
		const response = await fetch(url);
		if (response.status === 404) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable(`${response.status} ${url}`);
		}
		const data = await response.json() as ForgejoEntry | ForgejoEntry[];
		this.contentsCache.set(cacheKey, data);
		return data;
	}

	private getDefaultBranch(location: RepoLocation): Promise<string> {
		const key = `${location.origin}/${location.owner}/${location.repo}`;
		const pending = this.branchCache.get(key);
		if (pending) {
			return pending;
		}
		const branch = this.fetchDefaultBranch(location).catch((error: unknown) => {
			this.branchCache.delete(key);
			throw error;
		});
		this.branchCache.set(key, branch);
		return branch;
	}

	private async fetchDefaultBranch(location: RepoLocation): Promise<string> {
		const url = new URL(
			`/api/v1/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`,
			location.origin,
		);
		const response = await fetch(url);
		if (response.status === 404) {
			throw vscode.FileSystemError.FileNotFound(url.toString());
		}
		if (!response.ok) {
			throw vscode.FileSystemError.Unavailable(`${response.status} ${url}`);
		}
		const repo = await response.json() as { default_branch?: string };
		if (!repo.default_branch) {
			throw vscode.FileSystemError.Unavailable(`No default branch for ${location.owner}/${location.repo}`);
		}
		return repo.default_branch;
	}

	private toStat(type: vscode.FileType, size: number, when?: string | null): vscode.FileStat {
		const mtime = when ? Date.parse(when) : 0;
		return {
			type,
			ctime: Number.isNaN(mtime) ? 0 : mtime,
			mtime: Number.isNaN(mtime) ? 0 : mtime,
			size,
			permissions: vscode.FilePermission.Readonly,
		};
	}
}

function parseUri(uri: vscode.Uri): RepoLocation {
	if (uri.scheme !== SCHEME || !uri.authority) {
		throw vscode.FileSystemError.FileNotFound(uri);
	}
	const parts = uri.path.split('/').filter(Boolean);
	const owner = parts[0];
	const repo = parts[1];
	if (!owner || !repo) {
		throw vscode.FileSystemError.FileNotFound(uri);
	}
	const params = new URLSearchParams(uri.query);
	const ref = params.get('ref') ?? undefined;
	const protocol = params.get('protocol')?.toLowerCase() === 'https' ? 'https' : 'http';
	return {
		origin: `${protocol}://${uri.authority}`,
		owner,
		repo,
		path: parts.slice(2).join('/'),
		ref,
	};
}

function encodePath(path: string): string {
	return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function toFileType(type: string): vscode.FileType {
	switch (type) {
		case 'dir':
		case 'submodule':
			return vscode.FileType.Directory;
		case 'symlink':
			return vscode.FileType.SymbolicLink | vscode.FileType.File;
		default:
			return vscode.FileType.File;
	}
}

function decodeBase64(content: string): Uint8Array {
	const binary = atob(content.replace(/\s/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
