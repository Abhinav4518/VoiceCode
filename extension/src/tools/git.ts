import { execFile } from 'child_process';
import * as util from 'util';

const execFileAsync = util.promisify(execFile);

/** Read-only git helpers. Rollback itself is done by FileTools' journal (git reset --hard would destroy the user's own uncommitted work). */
export class GitTools {
    constructor(private readonly root: string) {}

    private async git(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync('git', ['-C', this.root, ...args], { maxBuffer: 10 * 1024 * 1024 });
        return stdout.trim();
    }

    public async isRepo(): Promise<boolean> {
        try { return (await this.git(['rev-parse', '--is-inside-work-tree'])) === 'true'; } catch { return false; }
    }

    /**
     * Safety net for the user's existing uncommitted (tracked) work. `git stash create` builds a snapshot commit without
     * touching the working tree; `stash store` keeps it reachable so it survives garbage collection.
     * Returns the snapshot SHA, or null if the tree was clean / not a repo.
     */
    public async checkpoint(): Promise<string | null> {
        try {
            if (!(await this.isRepo())) return null;
            const sha = await this.git(['stash', 'create']);
            if (!sha) return null;
            await this.git(['stash', 'store', '-m', 'voicecode-checkpoint', sha]);
            return sha;
        } catch {
            return null;
        }
    }

    public async diffStat(): Promise<string> {
        try { return await this.git(['diff', '--stat']); } catch { return ''; }
    }
}
