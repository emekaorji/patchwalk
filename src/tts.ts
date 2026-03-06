import { spawn } from 'node:child_process';
import process from 'node:process';

const runCommand = (command: string, args: string[]): Promise<void> => {
    return new Promise((resolve, reject) => {
        const childProcess = spawn(command, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
        });

        let stderr = '';
        childProcess.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });

        childProcess.on('error', (error) => {
            reject(error);
        });

        childProcess.on('close', (exitCode) => {
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
    return text.replaceAll(/\s+/g, ' ').trim();
};

export const speakWithSystemVoice = async (text: string): Promise<void> => {
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
        return;
    }

    if (process.platform === 'darwin') {
        await runCommand('say', [normalizedText]);
        return;
    }

    if (process.platform === 'win32') {
        const escapedText = normalizedText.replaceAll("'", "''");
        const script =
            'Add-Type -AssemblyName System.Speech; ' +
            '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
            `$speaker.Speak('${escapedText}');`;
        await runCommand('powershell', ['-NoProfile', '-Command', script]);
        return;
    }

    try {
        await runCommand('spd-say', [normalizedText]);
        return;
    } catch {
        await runCommand('espeak', [normalizedText]);
    }
};
