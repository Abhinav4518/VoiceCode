/**
 * Standard JSON Schema for a plan, shared by Gemini (responseJsonSchema) and Ollama (format).
 * Each action type is its own variant with its own REQUIRED fields, so a decoder that honours the schema
 * cannot emit a create_file without "content" or an edit_file without "oldText".
 */
const str = { type: 'string' };
const path = { type: 'string', maxLength: 200 };

export const PLAN_JSON_SCHEMA = {
    type: 'object',
    properties: {
        summary: str,
        actions: {
            type: 'array',
            items: {
                anyOf: [
                    {
                        type: 'object',
                        properties: { tool: { type: 'string', enum: ['create_file'] }, path, content: str },
                        required: ['tool', 'path', 'content'],
                    },
                    {
                        type: 'object',
                        properties: { tool: { type: 'string', enum: ['edit_file'] }, path, oldText: str, newText: str },
                        required: ['tool', 'path', 'oldText', 'newText'],
                    },
                    {
                        type: 'object',
                        properties: { tool: { type: 'string', enum: ['run_command'] }, command: str },
                        required: ['tool', 'command'],
                    },
                ],
            },
        },
    },
    required: ['summary', 'actions'],
};