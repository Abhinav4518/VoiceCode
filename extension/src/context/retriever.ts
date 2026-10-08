import * as fs from 'fs/promises';
import * as path from 'path';
import { SearchTools } from '../tools/search';

const STOPWORDS = new Set((
    'the and for with that this from into onto your our all any add make create build write update change fix use using ' +
    'please can could would should need want file files code project app application function functions new some have has ' +
    'are was were will run tests test what when where which then also just like more less over under about after before ' +
    'set get put let its them they there here how why who whom does did done not but out off one two'
).split(/\s+/));

export function extractKeywords(text: string, max = 8): string[] {
    const words = text.toLowerCase().replace(/[^a-z0-9_\-\s./]/g, ' ').split(/\s+/)
        .map(w => w.replace(/^[-./]+|[-./]+$/g, ''))
        .filter(w => w.length > 2 && !STOPWORDS.has(w));
    return [...new Set(words)].slice(0, max);
}

/** Pulls file-like tokens out of instructions / stack traces, e.g. "src/auth.js:20" or "C:\proj\src\a.ts". */
export function extractPaths(text: string): string[] {
    const re = /([\w@.\-/\\:]+\.(?:tsx?|jsx?|mjs|cjs|json|py|java|go|rs|css|scss|html|md|yml|yaml))(?::\d+)?/gi;
    const found = new Set<string>();
    for (const m of text.matchAll(re)) found.add(m[1].replace(/\\/g, '/'));
    return [...found];
}

export interface RetrieverOptions {
    maxFiles: number; maxCharsPerFile: number; maxTotalChars: number; maxTreeEntries: number;
}

/**
 * Lexical context engine (V1). Lists the workspace, ranks files by path/keyword hits and stack-trace mentions,
 * and returns compact, RAW file contents (no line numbers, so the model can copy text exactly for edit_file).
 * Embedding-based retrieval can later be slotted in by changing only the ranking step.
 */
export class ContextRetriever {
    private readonly opts: RetrieverOptions;

    constructor(
        private readonly root: string,
        private readonly search: SearchTools = new SearchTools(root),
        opts: Partial<RetrieverOptions> = {}
    ) {
        this.opts = { maxFiles: 6, maxCharsPerFile: 8000, maxTotalChars: 40000, maxTreeEntries: 150, ...opts };
    }

    public async build(instruction: string, failureText = ''): Promise<string> {
        const allFiles: string[] = [];
        for await (const f of this.search.walk(2000)) allFiles.push(f);

        const scores = new Map<string, number>();
        const bump = (f: string, n: number) => scores.set(f, (scores.get(f) ?? 0) + n);

        const keywords = extractKeywords(instruction);
        for (const m of await this.search.searchCode(keywords)) bump(m.file, 1);
        for (const f of allFiles) {
            const lower = f.toLowerCase();
            for (const k of keywords) if (lower.includes(k)) bump(f, 3);
        }
        for (const p of extractPaths(`${instruction}\n${failureText}`)) {
            for (const f of allFiles) if (f === p || p.endsWith('/' + f) || f.endsWith('/' + p)) bump(f, 10);
        }

        const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
        const chosen = new Set<string>();
        if (allFiles.includes('package.json')) chosen.add('package.json');
        for (const f of ranked) { if (chosen.size >= this.opts.maxFiles) break; chosen.add(f); }

        const treeShown = allFiles.slice(0, this.opts.maxTreeEntries);
        let out = `## Workspace files (${treeShown.length} of ${allFiles.length} shown)\n` +
            (treeShown.length ? treeShown.map(f => `- ${f}`).join('\n') : '(empty workspace)') + '\n\n## File contents\n';

        let total = 0;
        for (const rel of chosen) {
            let text: string;
            try { text = await fs.readFile(path.join(this.root, rel), 'utf-8'); } catch { continue; }
            if (text.includes('\0')) continue;
            const limit = Math.min(this.opts.maxCharsPerFile, this.opts.maxTotalChars - total);
            if (limit <= 0) break;
            const body = text.length > limit ? text.slice(0, limit) + '\n[... file truncated ...]' : text;
            out += `=== FILE: ${rel} ===\n${body}\n=== END FILE ===\n\n`;
            total += body.length;
        }
        return out;
    }
}
