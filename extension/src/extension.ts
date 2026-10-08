import * as vscode from 'vscode';
import { VoiceCodeAgent } from './agent/agent';
import { TaskEvent } from './agent/types';
import { createProvider } from './providers';
import { WhisperService } from './speech/whisper-service';
import { StorageManager } from './storage/sqlite';
import { VSCodeApprover, DIFF_SCHEME } from './security/permissions';
import { AssistantPanel } from './ui/panel';

const SECRET_KEY = 'voicecode.geminiApiKey';

export function activate(context: vscode.ExtensionContext) {
    const out = vscode.window.createOutputChannel('VoiceCode');
    const approver = new VSCodeApprover();
    const cfg = () => vscode.workspace.getConfiguration('voicecode');

    const whisper = new WhisperService(() => ({
        whisperCommand: cfg().get('whisperCommand', 'whisper'),
        whisperModel: cfg().get('whisperModel', 'base.en'),
        ffmpegPath: cfg().get('ffmpegPath', 'ffmpeg'),
        audioDevice: cfg().get('audioInputDevice', ''),
        maxSeconds: cfg().get('maxRecordSeconds', 15),
    }));

    let busy = false;
    let listening = false;   // true from mic-on until transcription finishes
    let cancel: vscode.CancellationTokenSource | undefined;
    let lastAgent: VoiceCodeAgent | undefined;
    let storagePromise: Promise<StorageManager | undefined> | undefined;

    const getStorage = () => (storagePromise ??= (async () => {
        try {
            const dir = (context.storageUri ?? context.globalStorageUri).fsPath;
            return await StorageManager.open(dir);
        } catch (e) {
            out.appendLine(`[storage] disabled: ${e}`);
            return undefined;
        }
    })());

    const emit = (e: TaskEvent) => {
        out.appendLine(`[${e.type}] ${e.message}${e.detail ? '\n    ' + e.detail.replace(/\n/g, '\n    ') : ''}`);
        AssistantPanel.instance?.post({ type: 'event', event: e });
    };

    const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const openPanel = () => AssistantPanel.show({
        onRun: t => void runInstruction(t),
        onListen: () => void toggleListening(),
        onCancel: () => cancel?.cancel(),
        onRollback: () => void rollback(),
    });

    async function runInstruction(instruction: string): Promise<void> {
        const root = workspaceRoot();
        if (!root) { vscode.window.showErrorMessage('VoiceCode: open a folder or workspace first.'); return; }
        if (busy) { vscode.window.showWarningMessage('VoiceCode is already working on a task.'); return; }

        busy = true;
        openPanel().post({ type: 'busy', value: true });
        emit({ type: 'transcript', message: instruction });
        cancel = new vscode.CancellationTokenSource();

        try {
            const apiKey = (await context.secrets.get(SECRET_KEY)) || process.env.GEMINI_API_KEY || '';
            const provider = createProvider({
                provider: cfg().get('llmProvider', 'auto'),
                geminiApiKey: apiKey,
                geminiModel: cfg().get('geminiModel', 'gemini-3.6-flash'),
                ollamaUrl: cfg().get('ollamaUrl', 'http://localhost:11434'),
                ollamaModel: cfg().get('ollamaModel', 'llama3'),
            }, (from, err) => emit({ type: 'status', message: `Provider "${from}" failed, trying next...`, detail: err }));

            const agent = new VoiceCodeAgent(root, provider, approver, {
                maxIterations: cfg().get('maxRepairIterations', 5),
                testCommandOverride: cfg().get('testCommand', ''),
                isDirty: abs => vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.fsPath === abs),
                store: await getStorage(),
                emit,
            });
            lastAgent = agent;

            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'VoiceCode', cancellable: true },
                async (progress, token) => {
                    token.onCancellationRequested(() => cancel?.cancel());
                    progress.report({ message: 'working...' });
                    return agent.processInstruction(instruction, cancel!.token);
                }
            );
            (result.success ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(`VoiceCode: ${result.message.split('\n')[0]}`);
        } catch (e: any) {
            emit({ type: 'error', message: String(e?.message ?? e) });
            vscode.window.showErrorMessage(`VoiceCode: ${e?.message ?? e}`);
        } finally {
            busy = false;
            cancel?.dispose();
            cancel = undefined;
            AssistantPanel.instance?.post({ type: 'busy', value: false });
        }
    }

    async function toggleListening(): Promise<void> {
        if (whisper.isRecording()) { whisper.stopRecording(); return; }   // second press = stop
        if (busy || listening) { vscode.window.showWarningMessage('VoiceCode is busy.'); return; }
        listening = true;
        const panel = openPanel();
        panel.post({ type: 'recording', value: true });
        emit({ type: 'status', message: 'Listening...' });
        try {
            const text = await whisper.transcribeVoiceCommand();
            panel.post({ type: 'recording', value: false });
            listening = false;
            await runInstruction(text);
        } catch (e: any) {
            emit({ type: 'error', message: String(e?.message ?? e) });
            vscode.window.showErrorMessage(`VoiceCode: ${e?.message ?? e}`);
        } finally {
            listening = false;
            AssistantPanel.instance?.post({ type: 'recording', value: false });
        }
    }

    async function rollback(): Promise<void> {
        if (busy) { vscode.window.showWarningMessage('Wait for the current task to finish (or cancel it) first.'); return; }
        if (!lastAgent) { vscode.window.showInformationMessage('VoiceCode: nothing to roll back.'); return; }
        const restored = await lastAgent.rollbackLastTask();
        emit({ type: 'result', message: restored.length ? `Rolled back: ${restored.join(', ')}` : 'Nothing to roll back.' });
    }

    context.subscriptions.push(
        out,
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, approver.provider),
        vscode.commands.registerCommand('voicecode.start', () => { openPanel(); }),
        vscode.commands.registerCommand('voicecode.listen', () => toggleListening()),
        vscode.commands.registerCommand('voicecode.ask', async () => {
            const text = await vscode.window.showInputBox({ prompt: 'What should VoiceCode do?', ignoreFocusOut: true });
            if (text?.trim()) await runInstruction(text.trim());
        }),
        vscode.commands.registerCommand('voicecode.rollback', () => rollback()),
        vscode.commands.registerCommand('voicecode.setApiKey', async () => {
            const key = await vscode.window.showInputBox({ prompt: 'Gemini API key (stored in VS Code SecretStorage)', password: true, ignoreFocusOut: true });
            if (key) { await context.secrets.store(SECRET_KEY, key.trim()); vscode.window.showInformationMessage('VoiceCode: API key saved.'); }
        }),
        vscode.commands.registerCommand('voicecode.showStats', async () => {
            const s = await getStorage();
            if (!s) { vscode.window.showWarningMessage('VoiceCode: no history database available.'); return; }
            const st = s.stats();
            vscode.window.showInformationMessage(
                `VoiceCode: ${st.tasks} task(s), ${(st.successRate * 100).toFixed(0)}% success, ${st.repaired} fixed via repair, ` +
                `avg ${st.avgIterations.toFixed(1)} iteration(s), avg ${st.avgSeconds.toFixed(1)}s`);
        })
    );
}

export function deactivate() {}
