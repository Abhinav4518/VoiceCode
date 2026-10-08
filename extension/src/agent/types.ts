export type ToolName = 'create_file' | 'edit_file' | 'run_command';

/** One step of a plan. Flat on purpose: it is easier for LLMs to fill and for us to validate. */
export interface PlanAction {
    tool: ToolName;
    path?: string;      // workspace-relative
    content?: string;   // create_file
    oldText?: string;   // edit_file: exact text to replace (must occur exactly once)
    newText?: string;   // edit_file: replacement
    command?: string;   // run_command
}

export interface Plan {
    summary: string;
    actions: PlanAction[];
}

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TaskEvent {
    type: 'status' | 'transcript' | 'plan' | 'action' | 'test' | 'repair' | 'result' | 'error';
    message: string;
    detail?: string;
}

export type EventSink = (e: TaskEvent) => void;

/** Structurally compatible with vscode.CancellationToken, without importing vscode. */
export interface CancelToken {
    readonly isCancellationRequested: boolean;
}

const MAX_ACTIONS = 25;
const TOOLS: ToolName[] = ['create_file', 'edit_file', 'run_command'];

const TOOL_ALIASES: Record<string, ToolName> = {
    create_file: 'create_file', create: 'create_file', write_file: 'create_file', new_file: 'create_file', createfile: 'create_file',
    edit_file: 'edit_file', edit: 'edit_file', modify_file: 'edit_file', replace: 'edit_file', editfile: 'edit_file',
    run_command: 'run_command', run: 'run_command', shell: 'run_command', exec: 'run_command', runcommand: 'run_command',
};

/** Field names that smaller/local models commonly use instead of ours. */
const FIELD_ALIASES: Record<string, string[]> = {
    path: ['path', 'file', 'filename', 'file_path', 'filePath', 'filepath'],
    content: ['content', 'contents', 'code', 'text', 'file_content', 'fileContent', 'body', 'data'],
    oldText: ['oldText', 'old_text', 'old', 'search', 'find', 'original'],
    newText: ['newText', 'new_text', 'new', 'replace', 'replacement', 'updated'],
    command: ['command', 'cmd', 'shell_command'],
};

/** A model that rambles inside a JSON string (e.g. "hello.js river/hello.js? No, just...") gets a clear, retryable error. */
const badPath = (p: string): boolean => p.length > 200 || /[\r\n?*<>|"]/.test(p);

const pick = (o: Record<string, unknown>, field: string): string | undefined => {
    for (const k of FIELD_ALIASES[field]) if (typeof o[k] === 'string') return o[k] as string;
    return undefined;
};

/** Validates untrusted LLM output. Throws a descriptive Error so the planner can retry. */
export function validatePlan(raw: unknown): Plan {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Plan must be a JSON object with "summary" and "actions".');
    }
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.actions)) {
        throw new Error('Plan has no "actions" array.');
    }
    if (r.actions.length > MAX_ACTIONS) {
        throw new Error(`Plan has ${r.actions.length} actions; the maximum is ${MAX_ACTIONS}. Split the task.`);
    }

    const actions = r.actions.map((a, i): PlanAction => {
        if (!a || typeof a !== 'object') throw new Error(`Action ${i + 1} is not an object.`);
        // Some models nest the fields under "args" (the shape the original project used); flatten it.
        const raw = a as Record<string, unknown>;
        const o: Record<string, unknown> = { ...raw, ...(raw.args && typeof raw.args === 'object' ? (raw.args as object) : {}) };
        const tool = TOOL_ALIASES[String(o.tool ?? '').toLowerCase()] as ToolName | undefined;
        if (!tool || !TOOLS.includes(tool)) throw new Error(`Action ${i + 1}: unknown tool "${String(o.tool)}".`);
        const seen = `(fields received: ${Object.keys(o).join(', ') || 'none'})`;

        const action: PlanAction = { tool };
        if (tool === 'create_file') {
            action.path = pick(o, 'path');
            action.content = pick(o, 'content');
            if (!action.path) throw new Error(`Action ${i + 1} (create_file): "path" is required ${seen}.`);
            if (badPath(action.path)) throw new Error(`Action ${i + 1} (create_file): "path" must be a plain file path like "src/hello.js", got: ${action.path.slice(0, 80)}`);
            if (action.content === undefined) throw new Error(`Action ${i + 1} (create_file): "content" is required ${seen}.`);
        } else if (tool === 'edit_file') {
            action.path = pick(o, 'path');
            action.oldText = pick(o, 'oldText');
            action.newText = pick(o, 'newText');
            if (!action.path) throw new Error(`Action ${i + 1} (edit_file): "path" is required ${seen}.`);
            if (badPath(action.path)) throw new Error(`Action ${i + 1} (edit_file): "path" must be a plain file path like "src/hello.js", got: ${action.path.slice(0, 80)}`);
            if (!action.oldText) throw new Error(`Action ${i + 1} (edit_file): "oldText" must be a non-empty string copied from the file ${seen}.`);
            if (action.newText === undefined) throw new Error(`Action ${i + 1} (edit_file): "newText" is required ${seen}.`);
        } else {
            action.command = pick(o, 'command')?.trim();
            if (!action.command) throw new Error(`Action ${i + 1} (run_command): "command" is required ${seen}.`);
        }
        return action;
    });

    return { summary: typeof r.summary === 'string' ? r.summary : '', actions };
}