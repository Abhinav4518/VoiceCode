# VoiceCode

Voice -> Whisper -> LLM agent -> file/terminal tools -> tests -> bounded self-repair.

## Run it
1. `npm install`
2. Install the speech tools: `pip install -U openai-whisper` and ffmpeg (on PATH).
3. Press F5 (Run Extension). In the new window open a project folder.
4. Command Palette: **VoiceCode: Set Gemini API Key**, then **VoiceCode: Start**.
5. Type a command in the panel, or press Ctrl+Alt+V (Cmd+Alt+V on macOS) to speak; press again to stop.

No API key? Set `voicecode.llmProvider` to `local` and run Ollama (`ollama pull llama3`).

## Tests
`npm test` runs 35 unit/integration tests (agent loop, edit safety, command validator, search, storage) without needing VS Code, Whisper or an API key.

## Safety model
- Edits are exact-text replacements, shown as a diff and approved before writing (or `voicecode.autoApproveEdits`).
- Paths are confined to the workspace; `.git` and `node_modules` are protected.
- Commands: safe verify commands run automatically, unknown ones ask, destructive ones need a modal confirm, catastrophic ones are blocked.
- Every task journals original file contents; failed or cancelled tasks are rolled back, and **Rollback** undoes a finished task.
