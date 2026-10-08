import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TestStatus } from '../agent/types';

export interface CommandResult { code: number; stdout: string; stderr: string; timedOut: boolean; }
export interface TestResult { status: TestStatus; command: string; output: string; errorLog: string; }

const MAX_LOG_CHARS = 6000;
/** Keep the END of long logs: that is where test runners put the failure summary. */
export const tail = (s: string, n = MAX_LOG_CHARS): string => (s.length > n ? '...[truncated]...\n' + s.slice(-n) : s);

export class TerminalTools {
    constructor(
        private readonly root: string,
        private readonly timeoutMs = 120_000,
        /** Optional override from settings (voicecode.testCommand). */
        private readonly testCommandOverride = ''
    ) {}

    /** Runs a shell command in the workspace. Never throws for a non-zero exit; inspect `code`. */
    public runCommand(cmd: string): Promise<CommandResult> {
        return new Promise(resolve => {
            exec(
                cmd,
                {
                    cwd: this.root,
                    timeout: this.timeoutMs,
                    maxBuffer: 10 * 1024 * 1024,
                    windowsHide: true,
                    env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }, // CI=true stops watch-mode test runners
                },
                (err, stdout, stderr) => {
                    if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false });
                    const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
                    resolve({
                        code: typeof e.code === 'number' ? e.code : 1,
                        stdout: stdout ?? '',
                        stderr: stderr || e.message,
                        timedOut: !!e.killed,
                    });
                }
            );
        });
    }

    /** Picks the best available verification command for this project, or null if there is none. */
    public async detectTestCommand(): Promise<string | null> {
        if (this.testCommandOverride.trim()) return this.testCommandOverride.trim();

        const exists = (p: string) => fs.access(path.join(this.root, p)).then(() => true, () => false);

        if (await exists('package.json')) {
            try {
                const pkg = JSON.parse(await fs.readFile(path.join(this.root, 'package.json'), 'utf-8'));
                const test: string | undefined = pkg.scripts?.test;
                // `npm init` generates a placeholder that always exits 1.
                if (test && !/no test specified/i.test(test)) return 'npm test';
            } catch { /* fall through */ }
            if (await exists('tsconfig.json')) return 'npx --no-install tsc --noEmit';
        }
        if ((await exists('pytest.ini')) || (await exists('pyproject.toml')) || (await exists('tests'))) {
            return 'python -m pytest -x -q';
        }
        return null;
    }

    public async runTests(): Promise<TestResult> {
        const command = await this.detectTestCommand();
        if (!command) {
            return { status: 'skipped', command: '', output: '', errorLog: '' };
        }
        const r = await this.runCommand(command);
        if (r.code === 0 && !r.timedOut) {
            return { status: 'passed', command, output: tail(r.stdout), errorLog: '' };
        }
        // Different runners write failures to different streams, so keep both.
        const log = r.timedOut
            ? `Command timed out after ${this.timeoutMs / 1000}s (is it running in watch mode?)\n${r.stdout}\n${r.stderr}`
            : `${r.stdout}\n${r.stderr}`;
        return { status: 'failed', command, output: tail(r.stdout), errorLog: tail(log.trim()) };
    }
}
