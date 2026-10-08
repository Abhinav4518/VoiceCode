import * as vscode from 'vscode';
import { Approver, RiskLevel } from './types';

export { RiskLevel } from './types';

const SCHEME = 'voicecode-diff';

/** Serves the "before" / "after" text for VS Code's built-in diff editor. */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    private docs = new Map<string, string>();
    provideTextDocumentContent(uri: vscode.Uri): string { return this.docs.get(uri.toString()) ?? ''; }
    set(uri: vscode.Uri, text: string) { this.docs.set(uri.toString(), text); }
    clear() { this.docs.clear(); }
}

export class VSCodeApprover implements Approver {
    private approveAllThisTask = false;
    private counter = 0;
    public readonly provider = new DiffContentProvider();

    resetTask(): void {
        this.approveAllThisTask = false;
        this.provider.clear();
    }

    async approveChange(relPath: string, before: string, after: string, isNew: boolean): Promise<boolean> {
        const auto = vscode.workspace.getConfiguration('voicecode').get<boolean>('autoApproveEdits', false);
        if (auto || this.approveAllThisTask) return true;

        const n = ++this.counter;
        const left = vscode.Uri.parse(`${SCHEME}:/before/${n}/${relPath}`);
        const right = vscode.Uri.parse(`${SCHEME}:/after/${n}/${relPath}`);
        this.provider.set(left, before);
        this.provider.set(right, after);
        await vscode.commands.executeCommand('vscode.diff', left, right, `VoiceCode: ${isNew ? 'new file' : 'change'} ${relPath}`, { preview: true });

        const choice = await vscode.window.showInformationMessage(
            `VoiceCode wants to ${isNew ? 'create' : 'modify'} ${relPath}. Review the diff, then choose.`,
            'Apply', 'Apply all this task', 'Reject'
        );
        if (choice === 'Apply all this task') this.approveAllThisTask = true;
        return choice === 'Apply' || choice === 'Apply all this task';
    }

    async approveCommand(command: string, risk: RiskLevel): Promise<boolean> {
        if (risk === RiskLevel.Low) return true;
        if (risk === RiskLevel.Blocked) return false;
        if (risk === RiskLevel.High) {
            const res = await vscode.window.showWarningMessage(
                `HIGH RISK command requested by the agent:\n\n${command}`, { modal: true }, 'Run anyway');
            return res === 'Run anyway';
        }
        const res = await vscode.window.showInformationMessage(`VoiceCode wants to run: ${command}`, 'Run', 'Reject');
        return res === 'Run';
    }
}

export const DIFF_SCHEME = SCHEME;
