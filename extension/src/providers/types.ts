/** Anything that can turn a prompt into a raw plan object. The agent never depends on a specific vendor. */
export interface LLMProvider {
    readonly name: string;
    /** Resolves with parsed (but unvalidated) JSON. Throws on network/quota/parse errors. */
    generatePlan(prompt: string): Promise<unknown>;
}

/** Extracts JSON from a model reply even if it wrapped it in ```json fences or added prose. */
export function parseJsonLoose(text: string): unknown {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(trimmed); } catch { /* try to find an object inside */ }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
    }
    throw new Error('Model did not return valid JSON.');
}
