import { Journal } from "@zenfs/core";
import { Repo } from "./Repo";

const DATABASE_NAME = "forgejo-journal";
const STORE_NAME = "entries";

class JournalDatabase {

    private connection: Promise<IDBDatabase> | undefined;

    constructor(private readonly idb: IDBFactory) {
    }

    async get(key: string): Promise<string | undefined> {
        const db = await this.open();
        const value = await this.request<string | undefined>(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key));
        return value ?? undefined;
    }

    async put(key: string, text: string): Promise<void> {
        const db = await this.open();
        await this.request(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(text, key));
    }

    private open(): Promise<IDBDatabase> {
        if (!this.connection) {
            this.connection = new Promise((resolve, reject) => {
                const req = this.idb.open(DATABASE_NAME, 1);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                        req.result.createObjectStore(STORE_NAME);
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error ?? new Error("Failed to open the journal database"));
            });
        }
        return this.connection;
    }

    private request<T>(req: IDBRequest<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error("Journal database request failed"));
        });
    }
}

let database: JournalDatabase | undefined;

async function journalDatabase(): Promise<JournalDatabase | undefined> {
    const idb = await Repo.getIndexedDB();
    if (!idb) {
        return undefined;
    }
    return database ??= new JournalDatabase(idb);
}

/**
 * ZenFS journal (deleted paths) handed to `CopyOnWrite`. The entries live on this instance.
 * In the browser, `load` / `save` persist the serialized form so a later session can rebuild it.
 * File bytes themselves live in the writable layer.
 *
 * Without IndexedDB (the Node extension host) a restart drops the process, and this instance already
 * holds the entries for the session, so `save` does nothing.
 */
export class ForgejoJournal extends Journal {

    private constructor(private readonly key: string) {
        super();
    }

    /** 
     * Empty when nothing was stored, or when the stored text is not a journal. 
     */
    static async restore(key: string): Promise<ForgejoJournal> {
        const journal = new ForgejoJournal(key);
        const text = await (await journalDatabase())?.get(key);
        if (!text?.startsWith("#journal@v0")) {
            return journal;
        }
        try {
            journal.fromString(text.endsWith("\n") ? text : `${text}\n`);
        } catch {
            return new ForgejoJournal(key);
        }
        return journal;
    }

    async backup(): Promise<void> {
        await (await journalDatabase())?.put(this.key, this.toString());
    }
}
