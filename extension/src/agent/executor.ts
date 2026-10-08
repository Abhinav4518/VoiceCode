import { FileTools } from '../tools/files';
import { TerminalTools, tail } from '../tools/terminal';
import { Approver, RiskLevel } from '../security/types';
import { CommandValidator } from '../security/command-validator';
import { CancelToken, EventSink, Plan, PlanAction } from './types';

export interface ExecutionReport {
    /** Human-readable problems that stop the plan (bad edit, failed command, blocked command...). Fed back to the planner. */
    failures: string[];
    /** True if the user declined a change or command. The task should stop, not retry. */
    rejected: boolean;
    cancelled: boolean;
    applied: number;
}

export class Executor {
    constructor(
        private readonly files: FileTools,
        private readonly terminal: TerminalTools,
        private readonly approver: Approver,
        private readonly emit: EventSink = () => { },
        private readonly validator = new CommandValidator()
    ) { }

    /** Runs actions in order and stops at the first failure, rejection or cancellation. */
    public async executePlan(plan: Plan, token?: CancelToken): Promise<ExecutionReport> {
        const report: ExecutionReport = { failures: [], rejected: false, cancelled: false, applied: 0 };

        for (const [i, action] of plan.actions.entries()) {
            if (token?.isCancellationRequested) { report.cancelled = true; break; }
            const label = `[${i + 1}/${plan.actions.length}] ${describe(action)}`;
            try {
                const outcome = await this.runAction(action, label);
                if (outcome === 'rejected') { report.rejected = true; break; }
                if (outcome !== 'ok') { report.failures.push(`${describe(action)}: ${outcome}`); break; }
                report.applied++;
            } catch (e: any) {
                report.failures.push(`${describe(action)}: ${e?.message ?? e}`);
                this.emit({ type: 'error', message: `${label} failed`, detail: String(e?.message ?? e) });
                break;
            }
        }
        return report;
    }

    /** Returns 'ok', 'rejected', or a failure message string. May throw for tool errors. */
    private async runAction(a: PlanAction, label: string): Promise<'ok' | 'rejected' | string> {
        switch (a.tool) {
            case 'create_file': {
                const p = await this.files.previewCreate(a.path!, a.content!);
                // Only skip the write if the file ALREADY existed with this exact content.
                // (An empty new file, e.g. a .gitkeep, still needs writing even though before === after === '').
                if (p.existed && p.before === p.after) { this.emit({ type: 'action', message: `${label} (no change)` }); return 'ok'; }
                if (!(await this.approver.approveChange(a.path!, p.before, p.after, !p.existed))) return 'rejected';
                await this.files.write(a.path!, p.after);
                this.emit({ type: 'action', message: `${label} ${p.existed ? '(overwritten)' : '(created)'}` });
                return 'ok';
            }
            case 'edit_file': {
                const p = await this.files.previewEdit(a.path!, a.oldText!, a.newText!);
                if (p.before === p.after) { this.emit({ type: 'action', message: `${label} (no change)` }); return 'ok'; }
                if (!(await this.approver.approveChange(a.path!, p.before, p.after, false))) return 'rejected';
                await this.files.write(a.path!, p.after);
                this.emit({ type: 'action', message: `${label} (edited)` });
                return 'ok';
            }
            case 'run_command': {
                const risk = this.validator.assessRisk(a.command!);
                if (risk === RiskLevel.Blocked) {
                    this.emit({ type: 'error', message: `${label} BLOCKED`, detail: 'This command is never allowed.' });
                    return 'command was blocked by the security policy. Choose a safer approach.';
                }
                if (!(await this.approver.approveCommand(a.command!, risk))) return 'rejected';
                this.emit({ type: 'action', message: `${label} (running)` });
                const r = await this.terminal.runCommand(a.command!);
                if (r.code !== 0) {
                    const out = tail(`${r.stdout}\n${r.stderr}`.trim(), 3000);
                    return `exited with code ${r.code}${r.timedOut ? ' (timed out)' : ''}:\n${out}`;
                }
                return 'ok';
            }
        }
    }
}

function describe(a: PlanAction): string {
    return a.tool === 'run_command' ? `run \`${a.command}\`` : `${a.tool} ${a.path}`;
}