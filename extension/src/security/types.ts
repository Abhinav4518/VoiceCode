export enum RiskLevel { Low = 'Low', Medium = 'Medium', High = 'High', Blocked = 'Blocked' }

/** Decides whether the agent may perform a change. Implemented with VS Code UI in permissions.ts. */
export interface Approver {
    approveChange(relPath: string, before: string, after: string, isNew: boolean): Promise<boolean>;
    approveCommand(command: string, risk: RiskLevel): Promise<boolean>;
    /** Called at the start of every task (resets "apply all" state). */
    resetTask(): void;
}
