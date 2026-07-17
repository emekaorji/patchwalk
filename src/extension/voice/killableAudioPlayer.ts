/* eslint-disable no-await-in-loop -- players are tried in preference order; the next candidate is only reached when the previous one is genuinely unavailable. */
import { spawn } from 'node:child_process';
import process from 'node:process';

/** Plays an audio file and can be interrupted mid-play — this is how stop/pause reach real audio. */
export interface AudioPlayer {
    play(filePath: string, signal: AbortSignal): Promise<void>;
}

interface PlayerCommand {
    command: string;
    args: string[];
}

const createAbortError = (): Error => {
    const error = new Error('Audio playback was aborted.');
    error.name = 'AbortError';
    return error;
};

/**
 * Candidate player commands per platform, in preference order (Linux has several possible players).
 * Pure → unit-testable.
 */
export const resolvePlayerCommands = (
    platform: NodeJS.Platform,
    filePath: string,
): PlayerCommand[] => {
    if (platform === 'darwin') {
        return [{ command: 'afplay', args: [filePath] }];
    }
    if (platform === 'win32') {
        return [
            {
                command: 'powershell',
                args: [
                    '-NoProfile',
                    '-Command',
                    `(New-Object Media.SoundPlayer '${filePath.replaceAll("'", "''")}').PlaySync();`,
                ],
            },
        ];
    }
    return [
        { command: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath] },
        { command: 'aplay', args: ['-q', filePath] },
        { command: 'paplay', args: [filePath] },
    ];
};

/** Run one player command; SIGTERM-kill it the instant `signal` aborts. Node-safe → testable. */
export const runKillableProcess = (
    command: string,
    args: string[],
    signal: AbortSignal,
): Promise<void> => {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(createAbortError());
            return;
        }

        const child = spawn(command, args, { stdio: 'ignore' });
        let aborted = false;

        const handleAbort = (): void => {
            aborted = true;
            child.kill('SIGTERM');
        };
        signal.addEventListener('abort', handleAbort, { once: true });

        child.on('error', (error) => {
            signal.removeEventListener('abort', handleAbort);
            reject(error);
        });

        child.on('close', (code) => {
            signal.removeEventListener('abort', handleAbort);
            if (aborted || signal.aborted) {
                reject(createAbortError());
                return;
            }
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} exited with code ${code}`));
        });
    });
};

export class ChildProcessAudioPlayer implements AudioPlayer {
    public async play(filePath: string, signal: AbortSignal): Promise<void> {
        const candidates = resolvePlayerCommands(process.platform, filePath);
        let lastError: unknown;
        for (const candidate of candidates) {
            try {
                await runKillableProcess(candidate.command, candidate.args, signal);
                return;
            } catch (error) {
                // An abort must propagate; a missing player (ENOENT) falls through to the next one.
                if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
                    throw error;
                }
                lastError = error;
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error('No usable audio player was found on this system.');
    }
}
