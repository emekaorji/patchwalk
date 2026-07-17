import { strictEqual } from 'node:assert';

import { encodeWav } from '../src/extension/voice/wav';

describe('wav encoder', () => {
    it('writes a valid 16-bit PCM WAV header and body', () => {
        const samples = new Float32Array([0, 1, -1, 0.5]);
        const buffer = encodeWav(samples, 24_000);

        strictEqual(buffer.length, 44 + samples.length * 2);
        strictEqual(buffer.toString('ascii', 0, 4), 'RIFF');
        strictEqual(buffer.toString('ascii', 8, 12), 'WAVE');
        strictEqual(buffer.toString('ascii', 12, 16), 'fmt ');
        strictEqual(buffer.toString('ascii', 36, 40), 'data');
        strictEqual(buffer.readUInt16LE(20), 1); // PCM
        strictEqual(buffer.readUInt16LE(22), 1); // mono
        strictEqual(buffer.readUInt32LE(24), 24_000); // sample rate
        strictEqual(buffer.readUInt16LE(34), 16); // bits per sample
        strictEqual(buffer.readUInt32LE(40), samples.length * 2); // data size

        // Full-scale samples clamp to the 16-bit extremes.
        strictEqual(buffer.readInt16LE(44), 0);
        strictEqual(buffer.readInt16LE(46), 32_767);
        strictEqual(buffer.readInt16LE(48), -32_768);
    });
});
