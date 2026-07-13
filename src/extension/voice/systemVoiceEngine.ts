import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AudioPlayer } from './killableAudioPlayer';
import { ChildProcessAudioPlayer } from './killableAudioPlayer';
import type { SpeechClip, TtsEngine } from './ttsEngine';

/**
 * The zero-config fallback voice: whatever the OS already provides (macOS `say`, Windows SAPI via
 * PowerShell, Linux `spd-say`/`espeak-ng`). Always registered; on a host with no speech binary it
 * fails per-utterance and the VoiceManager records that honestly (P6) rather than lying.
 */
const createAbortError = (): Error => {
    const error = new Error('Speech playback was aborted.');
    error.name = 'AbortError';
    return error;
};

const runCommand = (command: string, args: string[], signal?: AbortSignal): Promise<void> => {
    return new Promise((resolve, reject) => {
        const childProcess = spawn(command, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let aborted = false;
        let stderr = '';
        childProcess.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });

        const handleAbort = () => {
            aborted = true;
            childProcess.kill('SIGTERM');
        };

        if (signal) {
            if (signal.aborted) {
                handleAbort();
            } else {
                signal.addEventListener('abort', handleAbort, { once: true });
            }
        }

        childProcess.on('error', (error) => {
            if (signal) {
                signal.removeEventListener('abort', handleAbort);
            }
            reject(error);
        });

        childProcess.on('close', (exitCode) => {
            if (signal) {
                signal.removeEventListener('abort', handleAbort);
            }
            if (aborted || signal?.aborted) {
                reject(createAbortError());
                return;
            }
            if (exitCode === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `${command} exited with code ${exitCode}`));
        });
    });
};

const normalizeText = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

/**
 * Build the OS speech command. The VOICE MATTERS: on macOS the default system voice can take ~3.5s
 * to synthesize a line, while a compact voice (Fred, Daniel, Alex...) does the same line in under a
 * second. Exposed as a pure function so the argument building is unit-tested.
 */
export const resolveSpeechCommand = (
    platform: NodeJS.Platform,
    text: string,
    options: { voice?: string; outputFile?: string } = {},
): { command: string; args: string[] } => {
    const voice = options.voice?.trim();

    if (platform === 'darwin') {
        const args: string[] = [];
        if (voice) {
            args.push('-v', voice);
        }
        if (options.outputFile) {
            args.push('-o', options.outputFile);
        }
        args.push(text);
        return { command: 'say', args };
    }

    if (platform === 'win32') {
        const escapedText = text.replaceAll("'", "''");
        const parts = [
            'Add-Type -AssemblyName System.Speech;',
            '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
        ];
        if (voice) {
            parts.push(`$speaker.SelectVoice('${voice.replaceAll("'", "''")}');`);
        }
        if (options.outputFile) {
            parts.push(
                `$speaker.SetOutputToWaveFile('${options.outputFile.replaceAll("'", "''")}');`,
            );
        }
        parts.push(`$speaker.Speak('${escapedText}');`, '$speaker.Dispose();');
        return { command: 'powershell', args: ['-NoProfile', '-Command', parts.join(' ')] };
    }

    // Linux: espeak-ng can both speak and write a file; spd-say cannot write files.
    if (options.outputFile || voice) {
        const args: string[] = [];
        if (voice) {
            args.push('-v', voice);
        }
        if (options.outputFile) {
            args.push('-w', options.outputFile);
        }
        args.push(text);
        return { command: 'espeak-ng', args };
    }
    return { command: 'spd-say', args: ['--wait', text] };
};

export const speakWithSystemVoice = async (
    text: string,
    signal?: AbortSignal,
    voice?: string,
): Promise<void> => {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
        return;
    }

    const spoken = resolveSpeechCommand(process.platform, normalizedText, { voice });
    try {
        await runCommand(spoken.command, spoken.args, signal);
    } catch (error) {
        // On Linux the preferred binary may simply not exist; try the other one before giving up.
        if (process.platform === 'linux' && !signal?.aborted) {
            const fallback = spoken.command === 'spd-say' ? 'espeak-ng' : 'spd-say';
            await runCommand(
                fallback,
                fallback === 'spd-say' ? ['--wait', normalizedText] : [normalizedText],
                signal,
            );
            return;
        }
        throw error;
    }
};

/**
 * Synthesize to an audio file WITHOUT playing it. This is the whole point of the prefetch: the slow
 * part of a system voice (loading the voice, then synthesizing) can happen while the PREVIOUS cue
 * is still being heard, instead of as dead air before this one starts.
 */
const synthesizeToFile = async (
    text: string,
    filePath: string,
    voice?: string,
    signal?: AbortSignal,
): Promise<void> => {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
        throw new Error('Nothing to synthesize.');
    }
    const synth = resolveSpeechCommand(process.platform, normalizedText, {
        voice,
        outputFile: filePath,
    });
    // The signal MUST reach the child: a stopped walk that leaves `say -o` running keeps burning CPU
    // and contends with the audio of whatever plays next.
    await runCommand(synth.command, synth.args, signal);
};

export interface SystemVoiceEngineOptions {
    /** Where pre-synthesized clips are written. Defaults to the OS temp dir. */
    tmpDir?: string;
    /** The OS voice to use (e.g. "Daniel"). Empty → the OS default, which is often much slower. */
    getVoiceName?: () => string | undefined;
    player?: AudioPlayer;
}

export class SystemVoiceEngine implements TtsEngine {
    public readonly id = 'system';
    public readonly label = 'System voice';
    public readonly kind = 'system' as const;
    private readonly player: AudioPlayer;

    public constructor(private readonly options: SystemVoiceEngineOptions = {}) {
        this.player = options.player ?? new ChildProcessAudioPlayer();
    }

    public async speak(text: string, signal: AbortSignal): Promise<void> {
        await speakWithSystemVoice(text, signal, this.options.getVoiceName?.());
    }

    /** Pre-render the audio so playback starts immediately when this cue's turn comes. */
    public async synthesize(text: string, signal?: AbortSignal): Promise<SpeechClip> {
        const directory = this.options.tmpDir ?? tmpdir();
        await mkdir(directory, { recursive: true });
        // macOS `say` writes AIFF by default; SAPI and espeak-ng write WAV. All are playable.
        const extension = process.platform === 'darwin' ? 'aiff' : 'wav';
        const filePath = join(directory, `patchwalk-${randomUUID()}.${extension}`);

        try {
            await synthesizeToFile(text, filePath, this.options.getVoiceName?.(), signal);
        } catch (error) {
            // Never leave a half-written clip behind when synthesis is killed.
            await rm(filePath, { force: true }).catch(() => {});
            throw error;
        }

        let disposed = false;
        return {
            play: (signal: AbortSignal) => this.player.play(filePath, signal),
            dispose: async () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                // A leftover temp file is not worth failing a walk over.
                await rm(filePath, { force: true }).catch(() => {});
            },
        };
    }
}
