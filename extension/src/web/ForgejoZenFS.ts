import { FetchFS, Index, Inode, InodeLike } from '@zenfs/core';
import { withErrno } from 'kerium';
import type { ForgejoTreeEntry } from './ForgejoApi.js';

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/**
 * ZenFS's own `FetchFS` (an index of the files + lazy loading of their content), except that
 * the content of a file is not found by URL (= baseUrl + path), but by the sha of its blob.
 *
 * It is the "readable" layer of a `CopyOnWrite` file system, so it is never written to.
 */
export class ForgejoReadableFS extends FetchFS {

    private readonly blobs = new Map<string, Promise<Uint8Array>>();

    constructor(
        /** path (with leading slash) -> blob sha */
        private readonly shas: ReadonlyMap<string, string>,
        index: Index,
        private readonly loadBlob: (sha: string) => Promise<Uint8Array>) {
        super(index, 'http://unused.invalid');
    }

    static fromTree(entries: readonly ForgejoTreeEntry[], loadBlob: (sha: string) => Promise<Uint8Array>): ForgejoReadableFS {
        const now = Date.now();
        const inodes: Record<string, InodeLike> = {};
        const shas = new Map<string, string>();
        let nextIno = 0; // the root gets 0
        const add = (path: string, mode: number, size: number) => {
            inodes[path] = {
                ino: nextIno++,
                size, mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
                atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now,
            };
        };

        add('/', S_IFDIR | 0o555, 0);
        for (const { path, type, mode, size, sha } of entries) {
            if (type === 'blob') {
                const isSymlink = (parseInt(mode, 8) & 0o170000) === S_IFLNK;
                add('/' + path, (isSymlink ? S_IFLNK : S_IFREG) | (parseInt(mode, 8) & 0o555), size);
                shas.set('/' + path, sha);
            } else {
                // directories; also submodules, which are shown as empty directories
                add('/' + path, S_IFDIR | 0o555, 0);
            }
        }
        return new ForgejoReadableFS(shas, new Index().fromJSON({ version: 1, entries: inodes }), loadBlob);
    }

    override async read(path: string, buffer: Uint8Array, start = 0, end: number): Promise<void> {
        if (end - start === 0) {
            return;
        }
        const sha = this.shas.get(path);
        if (!sha) {
            throw withErrno('ENOENT', path);
        }
        let blob = this.blobs.get(sha);
        if (!blob) {
            blob = this.loadBlob(sha);
            this.blobs.set(sha, blob);
            blob.catch(() => this.blobs.delete(sha)); // retry on next read
        }
        buffer.set((await blob).subarray(start, end));
    }

    override readSync(): void {
        throw withErrno('ENOSYS', 'Content is loaded asynchronously');
    }
}
