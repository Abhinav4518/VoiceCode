import { RiskLevel } from './types';

/** Never run, even with confirmation. */
const BLOCKED: RegExp[] = [
    /\brm\s+(-\S+\s+)*(\/|~|\$HOME|\*)(\s|$)/i,
    /\bmkfs\b/i,
    /\bdd\s+.*\bof=\/dev\//i,
    /:\(\)\s*\{.*\};\s*:/,
    /\bformat\s+[a-z]:/i,
    /\b(shutdown|reboot|halt|poweroff)\b/i,
    />\s*\/dev\/(sd|nvme|hd)/i,
];

/** Allowed only after an explicit, modal confirmation. */
const HIGH: RegExp[] = [
    /\brm\b/i, /\brmdir\b/i, /\brd\s+\/s/i, /\bdel\b/i, /\brimraf\b/i, /\bRemove-Item\b/i,
    /\bsudo\b/i, /\bsu\s+-/i, /\bchown\b/i, /\bchmod\s+(-R\s+)?[0-7]*777\b/i,
    /\bdrop\s+(table|database|schema)\b/i, /\btruncate\s+table\b/i, /\bdelete\s+from\b/i,
    /\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\b/i, /\bgit\s+checkout\s+--\s/i, /\bgit\s+branch\s+-D\b/i,
    /\bgit\s+push\b.*(--force|-f\b)/i,
    /\b(curl|wget)\b.*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i,
    /\b(iex|Invoke-Expression)\b/i,
    /\bkill(all)?\b/i, /\btaskkill\b/i,
];

/** Read-only or verification commands that are safe to run without asking. */
const SAFE: RegExp[] = [
    /^(npm|yarn|pnpm)\s+(test|t|run\s+(test|build|lint|typecheck|check|tsc)(:\S+)?)(\s|$)/i,
    /^npx\s+(--no-install\s+)?(tsc|jest|vitest|mocha|eslint)(\s|$)/i,
    /^tsc(\s|$)/i,
    /^(python3?|py)\s+-m\s+(pytest|unittest)(\s|$)/i,
    /^pytest(\s|$)/i,
    /^node\s+(-v|--version)$/i,
    /^git\s+(status|diff|log|show|branch)(\s|$)/i,
    /^(ls|dir|pwd)(\s|$)/i,
];

const SEGMENT_SPLIT = /&&|\|\||;|\||\r?\n/;

export class CommandValidator {
    /**
     * Assesses a full shell line. Chained commands (&&, ;, |) are assessed per segment
     * and the worst risk wins, so "npm test && rm -rf x" cannot hide behind the safe prefix.
     */
    public assessRisk(cmd: string): RiskLevel {
        const line = cmd.trim();
        if (!line) return RiskLevel.Medium;

        if (BLOCKED.some(r => r.test(line))) return RiskLevel.Blocked;
        if (HIGH.some(r => r.test(line))) return RiskLevel.High;

        const substitution = /`|\$\(|>|<\(/.test(line);   // redirects / command substitution
        const segments = line.split(SEGMENT_SPLIT).map(s => s.trim()).filter(Boolean);
        const allSafe = segments.length > 0 && segments.every(s => SAFE.some(r => r.test(s)));

        return allSafe && !substitution ? RiskLevel.Low : RiskLevel.Medium;
    }
}
