import * as fs from 'fs/promises';
import * as path from 'path';

export interface Preview { before: string; after: string; existed: boolean; }

/**
 * Workspace-confined file operations with an undo journal.
 * Every write records the original content first, so rollback() restores the workspace
 * (including deleting files the agent created) without relying on git.
 */
export class FileTools {
    private journal = new Map<string, string | null>(); // absolute path -> original content (null = did not exist)

    constructor(
        private readonly root: string,
        /** Lets the extension refuse to overwrite files that have unsaved edits in the editor. */
        private readonly isDirty: (absPath: string) => boolean = () => false
    ) {}

    /** Resolves a workspace-relative path and rejects anything outside the workspace, .git or node_modules. */
    public resolve(rel: string): string {
        if (!rel || typeof rel !== 'string') throw new Error('Missing file path.');
        const abs = path.resolve(this.root, rel);
        const relative = path.relative(this.root, abs);
        if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            throw new Error(`Path is outside the workspace: ${rel}`);
        }
        const parts = relative.split(path.sep);
        if (parts.includes('.git') || parts.includes('node_modules')) {
            throw new Error(`Refusing to modify protected path: ${rel}`);
        }
        return abs;
    }

    public toRelative(abs: string): string {
        return path.relative(this.root, abs).split(path.sep).join('/');
    }

    public async readFile(rel: string): Promise<string> {
        return fs.readFile(this.resolve(rel), 'utf-8');
    }

    private assertWritable(abs: string, rel: string): void {
        if (this.isDirty(abs)) {
            throw new Error(`${rel} has unsaved changes in the editor. Save or close it, then try again.`);
        }
    }

    private async readIfExists(abs: string): Promise<string | null> {
        try { return await fs.readFile(abs, 'utf-8'); } catch { return null; }
    }

    public async previewCreate(rel: string, content: string): Promise<Preview> {
        const abs = this.resolve(rel);
        this.assertWritable(abs, rel);
        const before = await this.readIfExists(abs);
        return { before: before ?? '', after: content, existed: before !== null };
    }

    /** Computes the file after an exact-text replacement. Throws if oldText is missing or ambiguous. */
    public async previewEdit(rel: string, oldText: string, newText: string): Promise<Preview> {
        const abs = this.resolve(rel);
        this.assertWritable(abs, rel);
        const before = await this.readIfExists(abs);
        if (before === null) throw new Error(`File not found: ${rel}`);

        const crlf = before.includes('\r\n');
        const norm = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
        const candidates = [...new Set([oldText, norm(oldText)])];

        for (const cand of candidates) {
            const first = before.indexOf(cand);
            if (first === -1) continue;
            if (before.indexOf(cand, first + cand.length) !== -1) {
                throw new Error(`oldText matches more than once in ${rel}. Include more surrounding lines so it is unique.`);
            }
            const replacement = cand === oldText && !crlf ? newText : norm(newText);
            return { before, after: before.slice(0, first) + replacement + before.slice(first + cand.length), existed: true };
        }
        throw new Error(`oldText was not found in ${rel}. It must match the current file exactly.`);
    }

    /** Writes new content, journaling the original for rollback. */
    public async write(rel: string, content: string): Promise<void> {
        const abs = this.resolve(rel);
        if (!this.journal.has(abs)) this.journal.set(abs, await this.readIfExists(abs));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf-8');
    }

    public changedFiles(): string[] {
        return [...this.journal.keys()].map(a => this.toRelative(a));
    }

    public clearJournal(): void {
        this.journal.clear();
    }

    /** Restores every file touched since the journal was cleared. Returns the relative paths restored. */
    public async rollback(): Promise<string[]> {
        const restored: string[] = [];
        for (const [abs, original] of this.journal) {
            if (original === null) await fs.rm(abs, { force: true });
            else await fs.writeFile(abs, original, 'utf-8');
            restored.push(this.toRelative(abs));
        }
        this.journal.clear();
        return restored;
    }
}
