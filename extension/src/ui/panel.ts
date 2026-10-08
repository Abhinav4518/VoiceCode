import * as vscode from 'vscode';
import { TaskEvent } from '../agent/types';

export interface PanelHandlers {
    onRun(text: string): void;
    onListen(): void;
    onCancel(): void;
    onRollback(): void;
}

export type PanelMessage =
    | { type: 'event'; event: TaskEvent }
    | { type: 'busy'; value: boolean }
    | { type: 'recording'; value: boolean };

/** The assistant panel: command box, mic button, live log of plan / actions / tests / repairs. */
export class AssistantPanel {
    private static current: AssistantPanel | undefined;

    public static show(handlers: PanelHandlers): AssistantPanel {
        if (AssistantPanel.current) {
            AssistantPanel.current.panel.reveal(vscode.ViewColumn.Two);
            return AssistantPanel.current;
        }
        AssistantPanel.current = new AssistantPanel(handlers);
        return AssistantPanel.current;
    }

    public static get instance(): AssistantPanel | undefined { return AssistantPanel.current; }

    private readonly panel: vscode.WebviewPanel;

    private constructor(handlers: PanelHandlers) {
        this.panel = vscode.window.createWebviewPanel('voicecodeAssistant', 'VoiceCode Assistant', vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true });
        this.panel.webview.html = html();
        this.panel.webview.onDidReceiveMessage((m: { type: string; text?: string }) => {
            if (m.type === 'run' && m.text?.trim()) handlers.onRun(m.text.trim());
            else if (m.type === 'listen') handlers.onListen();
            else if (m.type === 'cancel') handlers.onCancel();
            else if (m.type === 'rollback') handlers.onRollback();
        });
        this.panel.onDidDispose(() => { AssistantPanel.current = undefined; });
    }

    public post(msg: PanelMessage): void {
        void this.panel.webview.postMessage(msg);
    }
}

function nonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function html(): string {
    const n = nonce();
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
  h2 { margin: 0 0 8px; }
  #log { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; height: 55vh; overflow-y: auto; margin-bottom: 10px; }
  .row { display: flex; gap: 6px; margin-bottom: 6px; }
  input { flex: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  button { padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: .5; cursor: default; }
  .line { margin: 4px 0; white-space: pre-wrap; word-break: break-word; }
  .detail { opacity: .7; font-size: .9em; margin-left: 18px; }
  .error { color: var(--vscode-errorForeground); } .result { font-weight: bold; }
  .transcript { color: var(--vscode-textLink-foreground); }
  #state { opacity: .8; margin-bottom: 6px; min-height: 1.2em; }
</style></head>
<body>
  <h2>VoiceCode Assistant</h2>
  <div id="state">Idle</div>
  <div id="log"></div>
  <div class="row">
    <input id="text" placeholder="Type an instruction, or press Listen and speak..." />
    <button id="send">Send</button>
    <button id="mic" class="secondary">Listen</button>
  </div>
  <div class="row">
    <button id="cancel" class="secondary" disabled>Cancel task</button>
    <button id="rollback" class="secondary">Rollback last task</button>
  </div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const icons = { status: '...', transcript: 'You said:', plan: 'Plan:', action: '>', test: 'Test:', repair: 'Repair:', result: 'Result:', error: 'Error:' };
  function add(ev) {
    const d = document.createElement('div');
    d.className = 'line ' + ev.type;
    d.textContent = (icons[ev.type] || '') + ' ' + ev.message;
    $('log').appendChild(d);
    if (ev.detail) { const x = document.createElement('div'); x.className = 'detail'; x.textContent = ev.detail; $('log').appendChild(x); }
    $('log').scrollTop = $('log').scrollHeight;
  }
  function send() { const t = $('text').value; if (!t.trim()) return; vscode.postMessage({ type: 'run', text: t }); $('text').value = ''; }
  $('send').onclick = send;
  $('text').onkeydown = e => { if (e.key === 'Enter') send(); };
  $('mic').onclick = () => vscode.postMessage({ type: 'listen' });
  $('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
  $('rollback').onclick = () => vscode.postMessage({ type: 'rollback' });
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'event') add(m.event);
    if (m.type === 'busy') { $('send').disabled = m.value; $('cancel').disabled = !m.value; $('state').textContent = m.value ? 'Working...' : 'Idle'; }
    if (m.type === 'recording') { $('mic').textContent = m.value ? 'Stop recording' : 'Listen'; if (m.value) $('state').textContent = 'Listening... press Stop when done'; }
  });
</script></body></html>`;
}
