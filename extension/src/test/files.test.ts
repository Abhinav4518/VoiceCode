import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileTools } from '../tools/files';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vc-files-'));

test('edit_file replaces an exact, unique snippet', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.js'), 'const a = 1;\nconst b = 2;\n');
    const f = new FileTools(root);
    const p = await f.previewEdit('a.js', 'const b = 2;', 'const b = 3;');
    assert.equal(p.after, 'const a = 1;\nconst b = 3;\n');
});

test('edit_file rejects missing and ambiguous matches', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.js'), 'x = 1;\nx = 1;\n');
    const f = new FileTools(root);
    await assert.rejects(f.previewEdit('a.js', 'y = 1;', 'z'), /not found/);
    await assert.rejects(f.previewEdit('a.js', 'x = 1;', 'z'), /more than once/);
});

test('edit_file handles CRLF files when the model sends LF', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.js'), 'one\r\ntwo\r\nthree\r\n');
    const f = new FileTools(root);
    const p = await f.previewEdit('a.js', 'one\ntwo', 'uno\ndos');
    assert.equal(p.after, 'uno\r\ndos\r\nthree\r\n');
});

test('replacement text containing "$&" is inserted literally', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.js'), 'price = 1;');
    const p = await new FileTools(root).previewEdit('a.js', 'price = 1;', "price = '$&';");
    assert.equal(p.after, "price = '$&';");
});

test('paths outside the workspace or in .git / node_modules are refused', () => {
    const root = tmp();
    const f = new FileTools(root);
    for (const bad of ['../evil.txt', '/etc/passwd', 'a/../../x', '.git/config', 'node_modules/x/index.js', '']) {
        assert.throws(() => f.resolve(bad), Error, bad);
    }
    assert.doesNotThrow(() => f.resolve('src/ok.ts'));
});

test('rollback restores edited files and deletes created ones', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.js'), 'original');
    const f = new FileTools(root);
    await f.write('a.js', 'changed');
    await f.write('a.js', 'changed again');           // second write must not overwrite the saved original
    await f.write('new/dir/b.js', 'brand new');
    assert.deepEqual(f.changedFiles().sort(), ['a.js', 'new/dir/b.js']);
    await f.rollback();
    assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf-8'), 'original');
    assert.equal(fs.existsSync(path.join(root, 'new/dir/b.js')), false);
});

test('dirty editor buffers are not overwritten', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.js'), 'x');
    const f = new FileTools(root, () => true);
    await assert.rejects(f.previewEdit('a.js', 'x', 'y'), /unsaved/);
});
