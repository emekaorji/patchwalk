import { deepStrictEqual, ok, rejects } from 'node:assert';
import process from 'node:process';

import {
    resolvePlayerCommands,
    runKillableProcess,
} from '../src/extension/voice/killableAudioPlayer';

describe('killable audio player', () => {
    it('resolves platform player commands', () => {
        deepStrictEqual(resolvePlayerCommands('darwin', '/tmp/a.wav'), [
            { command: 'afplay', args: ['/tmp/a.wav'] },
        ]);
        const linux = resolvePlayerCommands('linux', '/tmp/a.wav').map((c) => c.command);
        deepStrictEqual(linux, ['ffplay', 'aplay', 'paplay']);
        deepStrictEqual(resolvePlayerCommands('win32', '/tmp/a.wav')[0].command, 'powershell');
    });

    it('kills the player process promptly when aborted (wires stop to real audio)', async () => {
        const controller = new AbortController();
        const startedAt = Date.now();
        // A long-lived stand-in for an audio player.
        const promise = runKillableProcess(
            process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'],
            controller.signal,
        );
        setTimeout(() => controller.abort(), 40);

        await rejects(
            promise,
            (error: unknown) => error instanceof Error && error.name === 'AbortError',
        );
        ok(Date.now() - startedAt < 3000, 'abort should terminate the player quickly');
    });

    it('rejects immediately when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await rejects(
            runKillableProcess(process.execPath, ['-e', ''], controller.signal),
            (error: unknown) => error instanceof Error && error.name === 'AbortError',
        );
    });
});
