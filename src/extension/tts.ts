import { spawn } from 'node:child_process';
import process from 'node:process';

/**
 * TTS stays intentionally lightweight for now: use whatever the local OS already provides, and fall
 * back between common Linux speech tools.
 */
const createAbortError = (): Error => {
    const error = new Error('Speech playback was aborted.');
    error.name = 'AbortError';
    return error;
};

const runCommand = (command: string, args: string[], signal?: AbortSignal): Promise<void> => {
    return new Promise((resolve, reject) => {
        // Spawn per utterance keeps the implementation dependency-free and easy to reason about.
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

            const errorMessage = stderr.trim() || `${command} exited with code ${exitCode}`;
            reject(new Error(errorMessage));
        });
    });
};

const normalizeText = (text: string): string => {
    // TTS engines sound noticeably better when fed normalized whitespace.
    return text.replaceAll(/\s+/g, ' ').trim();
};

export const speakWithSystemVoice = async (text: string, signal?: AbortSignal): Promise<void> => {
    // Empty or whitespace-only narration should be a no-op, not a platform call.
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
        return;
    }

    if (process.platform === 'darwin') {
        await runCommand('say', [normalizedText], signal);
        return;
    }

    // Windows gets a minimal PowerShell speech bridge without extra dependencies.
    if (process.platform === 'win32') {
        const escapedText = normalizedText.replaceAll("'", "''");
        const script =
            'Add-Type -AssemblyName System.Speech; ' +
            '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
            `$speaker.Speak('${escapedText}');`;
        await runCommand('powershell', ['-NoProfile', '-Command', script], signal);
        return;
    }

    try {
        // Linux distributions vary, so try the more common daemon-backed option first.
        await runCommand('spd-say', [normalizedText], signal);
        return;
    } catch {
        await runCommand('espeak', [normalizedText], signal);
    }
};
