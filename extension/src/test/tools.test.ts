import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SearchTools } from '../tools/search';
import { TerminalTools } from '../tools/terminal';
import { ContextRetriever } from '../context/retriever';
import { StorageManager } from '../storage/sqlite';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tools-'));

test('search falls back to a Node scan when ripgrep is missing and skips node_modules', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/auth.js'), 'function Login() {}\n');
    fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'function login() {}\n');
    const hits = await new SearchTools(root, 'rg-does-not-exist').searchCode(['login']);
    assert.deepEqual(hits.map(h => h.file), ['src/auth.js']);
});

test('search treats regex characters literally (no shell injection)', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.txt'), 'call(a|b) "quoted"; $(whoami)\n');
    const hits = await new SearchTools(root, 'rg-does-not-exist').searchCode(['(a|b)', '"quoted"', '$(whoami)']);
    assert.equal(hits.length, 1);
});

test('placeholder npm test script is treated as "no tests", not a failure', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    const t = new TerminalTools(root);
    assert.equal(await t.detectTestCommand(), null);
    assert.equal((await t.runTests()).status, 'skipped');
});

test('failed tests capture BOTH stdout and stderr; timeouts are enforced', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
    fs.writeFileSync(path.join(root, 't.js'), "console.log('stdout-part');console.error('stderr-part');process.exit(2)");
    const r = await new TerminalTools(root).runTests();
    assert.equal(r.status, 'failed');
    assert.match(r.errorLog, /stdout-part/);
    assert.match(r.errorLog, /stderr-part/);

    const slow = await new TerminalTools(root, 500).runCommand('node -e "setTimeout(()=>{},10000)"');
    assert.equal(slow.timedOut, true);
});

test('retriever ranks files from the instruction and stack-trace paths, and never sends node_modules', async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/login.js'), 'login code');
    fs.writeFileSync(path.join(root, 'src/other.js'), 'unrelated');
    fs.writeFileSync(path.join(root, 'node_modules/x/login.js'), 'dep');
    const ctx = await new ContextRetriever(root, new SearchTools(root, 'nope'), { maxFiles: 1 }).build('fix the login bug');
    assert.match(ctx, /=== FILE: src\/login\.js ===/);
    assert.ok(!ctx.includes('node_modules'));
    const traced = await new ContextRetriever(root, new SearchTools(root, 'nope'), { maxFiles: 1 }).build('run tests', 'Error at src/other.js:3');
    assert.match(traced, /=== FILE: src\/other\.js ===/);
});

test('storage creates its folder, persists across reopen, and reports stats', async () => {
    const dir = path.join(tmp(), 'nested', 'store');            // does not exist yet: the original crashed here
    const s = await StorageManager.open(dir);
    const rec = { instruction: 'a', iterations: 1, success: true, testStatus: 'passed' as const, filesChanged: 1, durationMs: 2000, provider: 'fake' };
    s.log(rec);
    s.log({ ...rec, iterations: 3, success: true, durationMs: 4000 });
    s.log({ ...rec, iterations: 5, success: false });
    const st = (await StorageManager.open(dir)).stats();
    assert.equal(st.tasks, 3);
    assert.equal(st.repaired, 1);
    assert.ok(Math.abs(st.successRate - 2 / 3) < 1e-9);
});
