import { Buffer } from 'node:buffer';

/**
 * Encode mono float PCM samples (as returned by neural TTS) into a 16-bit PCM WAV buffer so they
 * can be handed to a killable child-process audio player. Pure and node-safe → unit-testable.
 */
export const encodeWav = (samples: Float32Array, sampleRate: number): Buffer => {
    const numChannels = 1;
    const bytesPerSample = 2; // 16-bit
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * bytesPerSample;

    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
    buffer.writeUInt16LE(1, 20); // audio format = PCM
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);

    let offset = 44;
    for (const sample of samples) {
        const clamped = Math.max(-1, Math.min(1, sample));
        const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        buffer.writeInt16LE(Math.round(value), offset);
        offset += 2;
    }

    return buffer;
};
