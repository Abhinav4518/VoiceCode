import { SYSTEM_PROMPT } from '../agent/prompts';
import { PLAN_JSON_SCHEMA } from './schema';
import { LLMProvider, parseJsonLoose } from './types';

/** Ollama-backed provider for zero-cost / offline use. */
export class LocalLLMProvider implements LLMProvider {
    public readonly name = 'ollama';

    constructor(private readonly baseUrl = 'http://localhost:11434', private readonly model = 'llama3') { }

    public async generatePlan(prompt: string): Promise<unknown> {
        // Newer Ollama versions accept a JSON schema in "format" and force the output to match it.
        // Older ones reject that with HTTP 400, so retry with plain JSON mode.
        let res = await this.chat(prompt, PLAN_JSON_SCHEMA);
        if (res.status === 400) res = await this.chat(prompt, 'json');
        if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = (await res.json()) as { message?: { content?: string } };
        return parseJsonLoose(data.message?.content ?? '');
    }

    private async chat(prompt: string, format: unknown): Promise<Response> {
        try {
            return await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    stream: false,
                    format,
                    options: { temperature: 0.1 },
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: prompt },
                    ],
                }),
                signal: AbortSignal.timeout(180_000),
            });
        } catch (e: any) {
            throw new Error(`Local model unreachable at ${this.baseUrl} (is Ollama running with "${this.model}" pulled?): ${e?.message ?? e}`);
        }
    }
}