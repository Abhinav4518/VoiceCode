import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VoiceCodeAgent } from '../agent/agent';
import { LLMProvider } from '../providers/types';
import { Approver, RiskLevel } from '../security/types';
import { TaskEvent } from '../agent/types';

class FakeProvider implements LLMProvider {
    name = 'fake';
    prompts: string[] = [];
    constructor(private queue: unknown[] | ((n: number) => unknown)) {}
    async generatePlan(prompt: string): Promise<unknown> {
        this.prompts.push(prompt);
        const n = this.prompts.length - 1;
        if (typeof this.queue === 'function') return this.queue(n);
        const item = this.queue[Math.min(n, this.queue.length - 1)];
        if (item instanceof Error) throw item;
        return item;
    }
}

const approveAll: Approver = { approveChange: async () => true, approveCommand: async () => true, resetTask() {} };
const rejectAll: Approver = { approveChange: async () => false, approveCommand: async () => false, resetTask() {} };

function workspace(withTests = true): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-agent-'));
    fs.writeFileSync(path.join(root, 'calc.js'), 'exports.add = (a, b) => a - b;\n');
    if (withTests) {
        fs.writeFileSync(path.join(root, 'check.js'),
            "const {add}=require('./calc');if(add(2,3)!==5){console.error('FAIL: add(2,3) expected 5 got '+add(2,3));process.exit(1)}\n");
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node check.js' } }));
    }
    return root;
}
const edit = (oldText: string, newText: string) => ({ summary: `${oldText} -> ${newText}`, actions: [{ tool: 'edit_file', path: 'calc.js', oldText, newText }] });
const read = (root: string) => fs.readFileSync(path.join(root, 'calc.js'), 'utf-8');

test('REGRESSION: repair loop executes the NEW plan, not the old one', async () => {
    const root = workspace();
    const provider = new FakeProvider([edit('a - b', 'a * b'), edit('a * b', 'a + b')]);
    const events: TaskEvent[] = [];
    const agent = new VoiceCodeAgent(root, provider, approveAll, { emit: e => events.push(e) });

    const r = await agent.processInstruction('fix the add function in calc.js');

    assert.equal(r.success, true, r.message);
    assert.equal(r.iterations, 2);
    assert.equal(r.testStatus, 'passed');
    assert.match(read(root), /a \+ b/);
    assert.equal(provider.prompts.length, 2);
    assert.match(provider.prompts[1], /FAIL: add\(2,3\) expected 5 got 6/);   // failure output reached the model
    assert.match(provider.prompts[1], /a \* b/);                              // and it saw the CURRENT file
    assert.ok(events.some(e => e.type === 'repair'));
});

test('gives up after the iteration cap and rolls the workspace back', async () => {
    const root = workspace();
    const provider = new FakeProvider(n => edit(n === 0 ? 'a - b' : 'a * b', 'a * b'));  // never fixes it
    const agent = new VoiceCodeAgent(root, provider, approveAll, { maxIterations: 3 });

    const r = await agent.processInstruction('fix add');

    assert.equal(r.success, false);
    assert.equal(r.iterations, 3);
    assert.match(r.message, /Rolled back 1 file/);
    assert.equal(read(root), 'exports.add = (a, b) => a - b;\n');
    assert.equal(r.changedFiles.length, 1);
});

test('a rejected change stops the task and leaves files untouched', async () => {
    const root = workspace();
    const agent = new VoiceCodeAgent(root, new FakeProvider([edit('a - b', 'a + b')]), rejectAll);
    const r = await agent.processInstruction('fix add');
    assert.equal(r.success, false);
    assert.match(r.message, /declined/);
    assert.equal(read(root), 'exports.add = (a, b) => a - b;\n');
});

test('malformed model output is retried once, then surfaces an error (never a fake "success")', async () => {
    const root = workspace();
    const provider = new FakeProvider([{ error: 'Local provider failed' }, { still: 'bad' }]);
    const r = await new VoiceCodeAgent(root, provider, approveAll).processInstruction('fix add');
    assert.equal(r.success, false);
    assert.equal(provider.prompts.length, 2);
    assert.match(provider.prompts[1], /previous reply was rejected/);
});

test('provider failure aborts cleanly', async () => {
    const root = workspace();
    const r = await new VoiceCodeAgent(root, new FakeProvider([new Error('quota exceeded')]), approveAll).processInstruction('x');
    assert.equal(r.success, false);
    assert.match(r.message, /quota exceeded/);
});

test('no test command: changes are applied but reported as unverified, not rolled back', async () => {
    const root = workspace(false);
    const r = await new VoiceCodeAgent(root, new FakeProvider([edit('a - b', 'a + b')]), approveAll).processInstruction('fix add');
    assert.equal(r.success, true);
    assert.equal(r.testStatus, 'skipped');
    assert.match(r.message, /unverified|no tests/i);
    assert.match(read(root), /a \+ b/);
});

test('blocked commands never run and are reported to the model', async () => {
    const root = workspace();
    const marker = path.join(root, 'marker.txt');
    fs.writeFileSync(marker, 'keep');
    const provider = new FakeProvider(n => n === 0
        ? { summary: 'clean', actions: [{ tool: 'run_command', command: 'rm -rf *' }] }
        : { summary: 'fix', actions: [{ tool: 'edit_file', path: 'calc.js', oldText: 'a - b', newText: 'a + b' }] });
    const r = await new VoiceCodeAgent(root, provider, approveAll).processInstruction('tidy and fix');
    assert.ok(fs.existsSync(marker));
    assert.match(provider.prompts[1], /blocked/i);
    assert.equal(r.success, true);
});

test('manual rollback after a successful task restores originals', async () => {
    const root = workspace();
    const agent = new VoiceCodeAgent(root, new FakeProvider([edit('a - b', 'a + b')]), approveAll);
    assert.equal((await agent.processInstruction('fix add')).success, true);
    await agent.rollbackLastTask();
    assert.equal(read(root), 'exports.add = (a, b) => a - b;\n');
});

test('cancellation stops before executing and rolls back', async () => {
    const root = workspace();
    const agent = new VoiceCodeAgent(root, new FakeProvider([edit('a - b', 'a + b')]), approveAll);
    const r = await agent.processInstruction('fix add', { isCancellationRequested: true });
    assert.equal(r.success, false);
    assert.match(r.message, /Cancelled/);
    assert.equal(read(root), 'exports.add = (a, b) => a - b;\n');
});
