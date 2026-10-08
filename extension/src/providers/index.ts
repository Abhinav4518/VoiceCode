import { GeminiProvider } from './gemini';
import { LocalLLMProvider } from './local';
import { LLMProvider } from './types';

export interface ProviderConfig {
    provider: 'auto' | 'gemini' | 'local';
    geminiApiKey: string;
    geminiModel: string;
    ollamaUrl: string;
    ollamaModel: string;
}

/** Tries providers in order; if one fails (quota, offline, bad key) the next one is used. */
export class FallbackProvider implements LLMProvider {
    private used = '';
    /** The provider that produced the most recent answer (so errors say WHICH model misbehaved). */
    public get name(): string { return this.used || this.providers.map(p => p.name).join('>'); }

    constructor(private readonly providers: LLMProvider[], private readonly onFallback: (from: string, err: string) => void = () => { }) { }

    public async generatePlan(prompt: string): Promise<unknown> {
        const errors: string[] = [];
        for (const p of this.providers) {
            try {
                const plan = await p.generatePlan(prompt);
                this.used = p.name;
                return plan;
            } catch (e: any) {
                const msg = `${p.name}: ${e?.message ?? e}`;
                errors.push(msg);
                this.onFallback(p.name, msg);
            }
        }
        throw new Error(`All LLM providers failed.\n${errors.join('\n')}`);
    }
}

export function createProvider(cfg: ProviderConfig, onFallback?: (from: string, err: string) => void): LLMProvider {
    const gemini = new GeminiProvider(cfg.geminiApiKey, cfg.geminiModel);
    const local = new LocalLLMProvider(cfg.ollamaUrl, cfg.ollamaModel);
    if (cfg.provider === 'gemini') return gemini;
    if (cfg.provider === 'local') return local;
    return new FallbackProvider([gemini, local], onFallback);
}