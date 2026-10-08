import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SpeechConfig {
    whisperCommand: string; whisperModel: string; ffmpegPath: string; audioDevice: string; maxSeconds: number;
}

/** Bias Whisper toward programming vocabulary. */
const INITIAL_PROMPT = 'Programming commands: React, Express, Node.js, TypeScript, JWT, npm, API, endpoint, component, login, authentication, middleware, refactor, unit test.';

/** Parses `ffmpeg -list_devices true -f dshow -i dummy` output (both the old sectioned and the new inline format). */
export function parseDshowAudioDevices(stderr: string): string[] {
    const names: string[] = [];
    let inAudioSection = false;
    for (const line of stderr.split(/\r?\n/)) {
        const inline = line.match(/"([^"]+)"\s+\(audio\)/);
        if (inline) { names.push(inline[1]); continue; }
        if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; continue; }
        if (/DirectShow video devices/i.test(line)) { inAudioSection = false; continue; }
        const quoted = line.match(/"([^"]+)"/);
        if (inAudioSection && quoted && !/Alternative name/i.test(line)) names.push(quoted[1]);
    }
    return [...new Set(names)];
}

export class WhisperService {
    private rec: ChildProcess | null = null;

    constructor(private readonly getConfig: () => SpeechConfig) {}

    public isRecording(): boolean { return this.rec !== null; }

    /** Ends the recording early; the audio captured so far is still transcribed. */
    public stopRecording(): void {
        try { this.rec?.stdin?.write('q'); } catch { /* already exited */ }
    }

    /** Records from the microphone, then transcribes locally with Whisper. Throws with actionable messages. */
    public async transcribeVoiceCommand(): Promise<string> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voicecode-'));
        const wav = path.join(dir, 'command.wav');
        try {
            await this.record(wav);
            const text = await this.transcribe(wav, dir);
            if (!text) throw new Error('No speech detected. Try again closer to the microphone.');
            return text;
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    private async inputArgs(cfg: SpeechConfig): Promise<string[]> {
        switch (process.platform) {
            case 'darwin':
                return ['-f', 'avfoundation', '-i', `:${cfg.audioDevice || '0'}`];
            case 'win32': {
                let device = cfg.audioDevice;
                if (!device) {
                    const found = await this.listDshowDevices(cfg.ffmpegPath);
                    if (!found.length) throw new Error('No microphone found. Set "voicecode.audioInputDevice" to your device name.');
                    device = found[0];
                }
                return ['-f', 'dshow', '-i', `audio=${device}`];
            }
            default:
                return ['-f', 'pulse', '-i', cfg.audioDevice || 'default'];
        }
    }

    private listDshowDevices(ffmpeg: string): Promise<string[]> {
        return new Promise(resolve => {
            // ffmpeg always exits non-zero for this command; the device list is on stderr.
            execFile(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true }, (_e, _o, stderr) =>
                resolve(parseDshowAudioDevices(String(stderr ?? ''))));
        });
    }

    private async record(wav: string): Promise<void> {
        const cfg = this.getConfig();
        const input = await this.inputArgs(cfg);
        const args = ['-y', '-loglevel', 'error', ...input, '-t', String(cfg.maxSeconds), '-ac', '1', '-ar', '16000', wav];

        await new Promise<void>((resolve, reject) => {
            const proc = spawn(cfg.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
            this.rec = proc;
            let err = '';
            proc.stderr?.on('data', d => (err += d.toString()));
            proc.on('error', (e: NodeJS.ErrnoException) => {
                this.rec = null;
                reject(new Error(e.code === 'ENOENT'
                    ? `ffmpeg not found ("${cfg.ffmpegPath}"). Install ffmpeg and add it to PATH, or set "voicecode.ffmpegPath".`
                    : `Could not start ffmpeg: ${e.message}`));
            });
            proc.on('close', () => {
                this.rec = null;
                // Stopping early with 'q' can yield a non-zero exit code, so judge by the file instead.
                if (fs.existsSync(wav) && fs.statSync(wav).size > 4000) resolve();
                else reject(new Error(`Recording failed. ${err.trim() || 'No audio captured.'}`));
            });
        });
    }

    private transcribe(wav: string, dir: string): Promise<string> {
        const cfg = this.getConfig();
        const [cmd, ...prefix] = cfg.whisperCommand.trim().split(/\s+/);
        const args = [...prefix, wav, '--model', cfg.whisperModel, '--language', 'en', '--fp16', 'False',
            '--initial_prompt', INITIAL_PROMPT, '--output_format', 'txt', '--output_dir', dir];

        return new Promise((resolve, reject) => {
            execFile(cmd, args, { timeout: 300_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) => {
                if (err) {
                    const e = err as NodeJS.ErrnoException;
                    return reject(new Error(e.code === 'ENOENT'
                        ? `Whisper not found ("${cfg.whisperCommand}"). Install it with "pip install -U openai-whisper" or set "voicecode.whisperCommand".`
                        : `Whisper failed: ${String(stderr || e.message).slice(-400)}`));
                }
                // Whisper writes <audio-name>.txt into --output_dir; stdout only has timestamped segments.
                const txt = path.join(dir, path.basename(wav, path.extname(wav)) + '.txt');
                try { resolve(fs.readFileSync(txt, 'utf-8').trim()); }
                catch { reject(new Error('Whisper finished but produced no transcript file.')); }
            });
        });
    }
}
