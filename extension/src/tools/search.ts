import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as util from 'util';

const execFileAsync = util.promisify(execFile);

export const IGNORE_DIRS = new Set([
    'node_modules', '.git', 'out', 'dist', 'build', 'coverage', '.next', '.nuxt', '.voicecode',
    '__pycache__', '.venv', 'venv', '.idea', '.vscode-test',
]);
const MAX_FILE_BYTES = 256 * 1024;

export interface Match { file: string; line: number; text: string; }

/** Parses `rg --json` output. Uses JSON (not "file:line:text") so Windows drive letters like C:\ don't break parsing. */
export function parseRgJson(stdout: string): Match[] {
    const out: Match[] = [];
    for (const raw of stdout.split('\n')) {
        if (!raw.trim()) continue;
        try {
            const ev = JSON.parse(raw);
            if (ev.type !== 'match') continue;
            const file: string | undefined = ev.data?.path?.text;
            const text: string | undefined = ev.data?.lines?.text;
            if (!file || text === undefined) continue; // non-UTF8 lines come as {bytes}
            out.push({
                file: file.replace(/^\.[\\/]/, '').split(path.sep).join('/').replace(/\\/g, '/'),
                line: ev.data.line_number,
                text: text.trim().slice(0, 200),
            });
        } catch { /* ignore malformed line */ }
    }
    return out;
}

export class SearchTools {
    constructor(private readonly root: string, private readonly rgPath = 'rg') {}

    /** Case-insensitive literal search for ANY of the keywords. ripgrep if installed, otherwise a pure-Node scan. */
    public async searchCode(keywords: string[], maxResults = 80): Promise<Match[]> {
        const kws = [...new Set(keywords.map(k => k.trim()).filter(Boolean))];
        if (!kws.length) return [];
        try {
            return (await this.ripgrep(kws)).slice(0, maxResults);
        } catch (e: any) {
            if (e?.code === 1) return []; // rg: no matches
            return (await this.nodeSearch(kws, maxResults)); // rg missing or failed
        }
    }

    private async ripgrep(kws: string[]): Promise<Match[]> {
        const args = [
            '--json', '--ignore-case', '--fixed-strings', '--max-count', '3', '--max-filesize', '256K',
            ...[...IGNORE_DIRS].flatMap(d => ['--glob', `!${d}`]),
            ...kws.flatMap(k => ['-e', k]),
            '--', '.',
        ];
        const { stdout } = await execFileAsync(this.rgPath, args, { cwd: this.root, maxBuffer: 20 * 1024 * 1024 });
        return parseRgJson(stdout);
    }

    private async nodeSearch(kws: string[], maxResults: number): Promise<Match[]> {
        const lowered = kws.map(k => k.toLowerCase());
        const out: Match[] = [];
        for await (const rel of this.walk(5000)) {
            let text: string;
            try {
                const abs = path.join(this.root, rel);
                if ((await fs.stat(abs)).size > MAX_FILE_BYTES) continue;
                text = await fs.readFile(abs, 'utf-8');
            } catch { continue; }
            if (text.includes('\0')) continue; // binary
            let perFile = 0;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length && perFile < 3; i++) {
                const l = lines[i].toLowerCase();
                if (lowered.some(k => l.includes(k))) {
                    out.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
                    perFile++;
                    if (out.length >= maxResults) return out;
                }
            }
        }
        return out;
    }

    /** Yields workspace-relative posix paths, skipping ignored directories. */
    public async *walk(maxFiles = 2000): AsyncGenerator<string> {
        let count = 0;
        const stack: string[] = [''];
        while (stack.length) {
            const dir = stack.pop()!;
            let entries;
            try { entries = await fs.readdir(path.join(this.root, dir), { withFileTypes: true }); } catch { continue; }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const e of entries) {
                if (e.isDirectory()) {
                    if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(dir ? `${dir}/${e.name}` : e.name);
                } else if (e.isFile()) {
                    yield dir ? `${dir}/${e.name}` : e.name;
                    if (++count >= maxFiles) return;
                }
            }
        }
    }
}
