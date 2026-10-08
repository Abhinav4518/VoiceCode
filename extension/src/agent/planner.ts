import { ContextRetriever } from '../context/retriever';
import { LLMProvider } from '../providers/types';
import { buildPrompt } from './prompts';
import { Plan, validatePlan } from './types';

export class Planner {
    constructor(private readonly provider: LLMProvider, private readonly retriever: ContextRetriever) { }

    public async createPlan(instruction: string): Promise<Plan> {
        const context = await this.retriever.build(instruction);
        return this.ask(buildPrompt(instruction, context));
    }

    /**
     * Re-plans after a failure. Context is rebuilt from the CURRENT files (which already contain earlier edits),
     * and the failure output is used to pull in the files mentioned in the stack trace.
     */
    public async repair(instruction: string, previous: Plan, failure: string): Promise<Plan> {
        const context = await this.retriever.build(instruction, failure);
        return this.ask(buildPrompt(instruction, context, { previousSummary: previous.summary, failure }));
    }

    /** Calls the model and validates the result; on a malformed plan, retries once telling the model what was wrong. */
    private async ask(prompt: string): Promise<Plan> {
        const first = await this.provider.generatePlan(prompt);
        try {
            return validatePlan(first);
        } catch (e: any) {
            const retry = await this.provider.generatePlan(
                `${prompt}\n\n# Your previous reply was rejected\n${e.message}\nReturn corrected JSON only.`
            );
            try {
                return validatePlan(retry);
            } catch (e2: any) {
                throw new Error(`${e2.message}\nModel (${this.provider.name}) returned: ${JSON.stringify(retry).slice(0, 400)}`);
            }
        }
    }
}
