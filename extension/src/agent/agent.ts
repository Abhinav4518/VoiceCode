import { Planner } from './planner';
import { Executor } from './executor';
import { CancelToken, EventSink, TestStatus } from './types';
import { FileTools } from '../tools/files';
import { TerminalTools } from '../tools/terminal';
import { GitTools } from '../tools/git';
import { ContextRetriever } from '../context/retriever';
import { LLMProvider } from '../providers/types';
import { Approver } from '../security/types';

export interface TaskRecord {
    instruction: string; iterations: number; success: boolean; testStatus: TestStatus | 'n/a';
    filesChanged: number; durationMs: number; provider: string;
}
export interface TaskStore { log(rec: TaskRecord): void; }

export interface AgentOptions {
    maxIterations?: number;
    testCommandOverride?: string;
    isDirty?: (abs: string) => boolean;
    store?: TaskStore;
    emit?: EventSink;
}

export interface AgentResult {
    success: boolean; iterations: number; message: string; changedFiles: string[]; testStatus: TestStatus | 'n/a';
}

/** understand -> plan -> act -> verify -> repair (bounded). */
export class VoiceCodeAgent {
    public readonly files: FileTools;
    private readonly terminal: TerminalTools;
    private readonly git: GitTools;
    private readonly planner: Planner;
    private readonly executor: Executor;
    private readonly maxIterations: number;
    private readonly emit: EventSink;

    constructor(
        root: string,
        private readonly provider: LLMProvider,
        private readonly approver: Approver,
        private readonly opts: AgentOptions = {}
    ) {
        this.emit = opts.emit ?? (() => {});
        this.maxIterations = Math.max(1, opts.maxIterations ?? 5);
        this.files = new FileTools(root, opts.isDirty);
        this.terminal = new TerminalTools(root, 120_000, opts.testCommandOverride ?? '');
        this.git = new GitTools(root);
        this.planner = new Planner(provider, new ContextRetriever(root));
        this.executor = new Executor(this.files, this.terminal, approver, this.emit);
    }

    public async processInstruction(instruction: string, token?: CancelToken): Promise<AgentResult> {
        const started = Date.now();
        this.files.clearJournal();
        this.approver.resetTask();

        let iterations = 0;
        let testStatus: TestStatus | 'n/a' = 'n/a';

        const finish = async (success: boolean, message: string, rollback: boolean): Promise<AgentResult> => {
            const changedFiles = this.files.changedFiles();   // capture before a rollback clears the journal
            if (rollback && changedFiles.length) {
                const restored = await this.files.rollback();
                message += ` Rolled back ${restored.length} file(s).`;
            }
            this.emit({ type: 'result', message });
            try {
                this.opts.store?.log({ instruction, iterations, success, testStatus, filesChanged: changedFiles.length, durationMs: Date.now() - started, provider: this.provider.name });
            } catch { /* telemetry must never break a task */ }
            return { success, iterations, message, changedFiles, testStatus };
        };

        try {
            this.emit({ type: 'status', message: 'Saving safety checkpoint...' });
            await this.git.checkpoint();

            this.emit({ type: 'status', message: 'Reading project and planning...' });
            let plan = await this.planner.createPlan(instruction);
            this.emit({ type: 'plan', message: plan.summary || '(no summary)', detail: `${plan.actions.length} action(s)` });

            while (iterations < this.maxIterations) {
                iterations++;
                if (token?.isCancellationRequested) return finish(false, 'Cancelled.', true);

                const exec = await this.executor.executePlan(plan, token);
                if (exec.cancelled) return finish(false, 'Cancelled.', true);
                if (exec.rejected) return finish(false, 'You declined a change; task stopped.', true);

                let failure = '';
                if (exec.failures.length) {
                    failure = `Plan execution failed:\n${exec.failures.join('\n')}`;
                    this.emit({ type: 'error', message: 'Action failed', detail: failure });
                } else {
                    this.emit({ type: 'status', message: 'Verifying (running tests)...' });
                    const tests = await this.terminal.runTests();
                    testStatus = tests.status;
                    if (tests.status === 'passed') {
                        this.emit({ type: 'test', message: `Tests passed (${tests.command})` });
                        const stat = await this.git.diffStat();
                        return finish(true, `Done in ${iterations} iteration(s). ${this.files.changedFiles().length} file(s) changed.${stat ? '\n' + stat : ''}`, false);
                    }
                    if (tests.status === 'skipped') {
                        this.emit({ type: 'test', message: 'No test command found; changes are unverified.' });
                        return finish(true, `Applied ${this.files.changedFiles().length} change(s), but no tests were found to verify them.`, false);
                    }
                    failure = tests.errorLog;
                    this.emit({ type: 'test', message: `Tests failed (${tests.command})`, detail: failure });
                }

                if (iterations >= this.maxIterations) break;
                this.emit({ type: 'repair', message: `Repair attempt ${iterations}/${this.maxIterations - 1}...` });
                plan = await this.planner.repair(instruction, plan, failure);   // use the NEW plan next loop
                this.emit({ type: 'plan', message: plan.summary || '(no summary)', detail: `${plan.actions.length} action(s)` });
                if (plan.actions.length === 0) {
                    return finish(false, `The model had no further fix to propose. Last failure:\n${failure.slice(0, 500)}`, true);
                }
            }
            return finish(false, `Still failing after ${this.maxIterations} iteration(s).`, true);
        } catch (e: any) {
            this.emit({ type: 'error', message: 'Task aborted', detail: String(e?.message ?? e) });
            return finish(false, `Error: ${e?.message ?? e}`, true);
        }
    }

    /** Manual rollback of the last task (used by the Rollback button/command). */
    public async rollbackLastTask(): Promise<string[]> {
        return this.files.rollback();
    }
}
