import type { WriteStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type PatchwalkLogLevel = 'INFO' | 'WARN' | 'ERROR';

const formatLogDetails = (details?: unknown): string => {
    if (details === undefined) {
        return '';
    }

    if (details instanceof Error) {
        return `\n${details.stack ?? details.message}`;
    }

    if (typeof details === 'string') {
        return ` ${details}`;
    }

    try {
        return ` ${JSON.stringify(details)}`;
    } catch {
        return ` ${String(details)}`;
    }
};

/**
 * File-backed daemon logger used for detached runs where stdout/stderr are not attached.
 */

let stream: WriteStream;

async function init() {
    const configuredPath = path.join(os.homedir(), '.patchwalk', 'log.txt');
    await fs.mkdir(path.dirname(configuredPath), { recursive: true });

    stream = createWriteStream(configuredPath, {
        flags: 'a',
    });
    stream.on('error', (error) => {
        console.error('Patchwalk daemon logger stream error:', error);
    });
}

function write(level: PatchwalkLogLevel, message: string, details?: unknown): void {
    if (stream.destroyed) {
        return;
    }

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}${formatLogDetails(details)}\n`;
    stream.write(line);
}

function info(message: string, details?: unknown): void {
    write('INFO', message, details);
}

function warn(message: string, details?: unknown): void {
    write('WARN', message, details);
}

function error(message: string, details?: unknown): void {
    write('ERROR', message, details);
}

async function close(): Promise<void> {
    await new Promise<void>((resolve) => {
        stream.end(() => {
            resolve();
        });
    });
}

init();

export { close, error, info, warn };
