import { GoogleGenAI } from '@google/genai';
import { SYSTEM_PROMPT } from '../agent/prompts';
import { PLAN_JSON_SCHEMA } from './schema';
import { LLMProvider, parseJsonLoose } from './types';

const RETRY_DELAYS_MS = [2000, 4000, 8000];
const isTransient = (e: any) => /\b(429|500|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(String(e?.message ?? e));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class GeminiProvider implements LLMProvider {
    public readonly name = 'gemini';
    private ai?: GoogleGenAI;

    constructor(private readonly apiKey: string, private readonly model: string) {
        if (apiKey) this.ai = new GoogleGenAI({ apiKey });
    }

    public async generatePlan(prompt: string): Promise<unknown> {
        if (!this.ai) throw new Error('Gemini API key is not set (run "VoiceCode: Set Gemini API Key").');
        for (let attempt = 0; ; attempt++) {
            try {
                const res = await this.ai.models.generateContent({
                    model: this.model,
                    contents: prompt,
                    config: {
                        systemInstruction: SYSTEM_PROMPT,
                        responseMimeType: 'application/json',
                        responseJsonSchema: PLAN_JSON_SCHEMA,
                        temperature: 0.2,
                    },
                });
                return parseJsonLoose(res.text ?? '');
            } catch (e) {
                // Temporary overload / rate limit: wait and retry before giving up on Gemini.
                if (attempt >= RETRY_DELAYS_MS.length || !isTransient(e)) throw e;
                await sleep(RETRY_DELAYS_MS[attempt]);
            }
        }
    }
}