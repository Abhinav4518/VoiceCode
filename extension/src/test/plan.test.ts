import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../agent/types';
import { parseJsonLoose } from '../providers/types';
import { parseRgJson } from '../tools/search';
import { extractKeywords, extractPaths } from '../context/retriever';
import { parseDshowAudioDevices } from '../speech/whisper-service';

test('validatePlan accepts a good plan and ignores null fields', () => {
    const p = validatePlan({ summary: 's', actions: [
        { tool: 'create_file', path: 'a.js', content: '', oldText: null },
        { tool: 'edit_file', path: 'a.js', oldText: 'x', newText: '' },
        { tool: 'run_command', command: ' npm i x ' },
    ] });
    assert.equal(p.actions.length, 3);
    assert.equal(p.actions[2].command, 'npm i x');
});

test('validatePlan rejects garbage (the old code treated {} / {error} as "success")', () => {
    assert.throws(() => validatePlan({}), /actions/);
    assert.throws(() => validatePlan({ error: 'Local provider failed' }), /actions/);
    assert.throws(() => validatePlan(null));
    assert.throws(() => validatePlan({ actions: [{ tool: 'rm_rf' }] }), /unknown tool/);
    assert.throws(() => validatePlan({ actions: [{ tool: 'edit_file', path: 'a', oldText: '', newText: 'x' }] }), /oldText/);
    assert.throws(() => validatePlan({ actions: Array(30).fill({ tool: 'run_command', command: 'ls' }) }), /maximum/);
});

test('parseJsonLoose strips fences and surrounding prose', () => {
    assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonLoose('Sure! Here it is: {"a":1} hope that helps'), { a: 1 });
    assert.throws(() => parseJsonLoose('nope'));
});

test('parseRgJson handles Windows paths and non-UTF8 lines', () => {
    const out = parseRgJson([
        JSON.stringify({ type: 'begin', data: {} }),
        JSON.stringify({ type: 'match', data: { path: { text: '.\\src\\auth.js' }, line_number: 7, lines: { text: '  login(user)\n' } } }),
        JSON.stringify({ type: 'match', data: { path: { text: 'bin.dat' }, line_number: 1, lines: { bytes: 'AAAA' } } }),
        'not json',
    ].join('\n'));
    assert.deepEqual(out, [{ file: 'src/auth.js', line: 7, text: 'login(user)' }]);
});

test('keyword extraction removes stopwords and punctuation; regex chars are harmless', () => {
    assert.deepEqual(extractKeywords('Please add JWT authentication to my Express backend.'), ['jwt', 'authentication', 'express', 'backend']);
    assert.ok(!extractKeywords('fix (login|auth) bug*').some(k => /[()|*]/.test(k)));
});

test('extractPaths finds files in stack traces', () => {
    assert.deepEqual(extractPaths('at Object.<anonymous> (C:\\proj\\src\\auth.js:20:5)\n  src/login.ts:9'),
        ['C:/proj/src/auth.js', 'src/login.ts']);
});

test('dshow device parsing (new and old ffmpeg formats)', () => {
    const newer = '[dshow @ 0] "Integrated Camera" (video)\n[dshow @ 0] "Microphone (Realtek Audio)" (audio)\n[dshow @ 0]   Alternative name "@device_cm_x"';
    assert.deepEqual(parseDshowAudioDevices(newer), ['Microphone (Realtek Audio)']);
    const older = '[dshow @ 0] DirectShow video devices\n[dshow @ 0]  "Cam"\n[dshow @ 0] DirectShow audio devices\n[dshow @ 0]  "Mic Array"\n[dshow @ 0]     Alternative name "@device"';
    assert.deepEqual(parseDshowAudioDevices(older), ['Mic Array']);
});
