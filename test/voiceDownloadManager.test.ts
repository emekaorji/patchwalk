import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VoiceCatalogEntry } from '../src/extension/voice/voiceCatalog';
import type { FetchBytes } from '../src/extension/voice/voiceDownloadManager';
import { VoiceDownloadManager } from '../src/extension/voice/voiceDownloadManager';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const bytesFor = (name: string): Uint8Array => new TextEncoder().encode(`content-of-${name}`);

const makeEntry = (files: VoiceCatalogEntry['files']): VoiceCatalogEntry => ({
    id: 'kokoro-en',
    label: 'Kokoro',
    kind: 'neural',
    available: true,
    family: 'kokoro',
    sizeMB: 90,
    license: 'Apache-2.0',
    speakerId: 0,
    files,
});

describe('voice download manager', () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'pw-voices-'));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const fakeFetch: FetchBytes = async (url, onProgress) => {
        const name = url.split('/').pop() ?? 'file';
        const bytes = bytesFor(name);
        onProgress?.(bytes.byteLength, bytes.byteLength);
        return bytes;
    };

    it('installs files, verifies checksums, and writes a manifest', async () => {
        const manager = new VoiceDownloadManager({
            rootDir: root,
            fetchBytes: fakeFetch,
            now: () => new Date('2026-07-11T00:00:00Z'),
        });
        const entry = makeEntry([
            {
                name: 'model.onnx',
                url: 'https://x/model.onnx',
                sha256: sha256(bytesFor('model.onnx')),
            },
            { name: 'tokens.txt', url: 'https://x/tokens.txt' },
        ]);

        const progress: string[] = [];
        const manifest = await manager.install(entry, (fileName) => progress.push(fileName));

        strictEqual(await manager.isInstalled('kokoro-en'), true);
        deepStrictEqual(manifest.files, ['model.onnx', 'tokens.txt']);
        strictEqual(manifest.installedAt, '2026-07-11T00:00:00.000Z');
        ok(progress.includes('model.onnx') && progress.includes('tokens.txt'));

        const written = await readFile(join(manager.voiceDir('kokoro-en'), 'model.onnx'), 'utf8');
        strictEqual(written, 'content-of-model.onnx');
        deepStrictEqual(await manager.listInstalled(['kokoro-en', 'other']), ['kokoro-en']);
        deepStrictEqual((await manager.readManifest('kokoro-en'))?.id, 'kokoro-en');
    });

    it('rejects and cleans up on a checksum mismatch', async () => {
        const manager = new VoiceDownloadManager({ rootDir: root, fetchBytes: fakeFetch });
        const entry = makeEntry([
            { name: 'model.onnx', url: 'https://x/model.onnx', sha256: 'deadbeef' },
        ]);
        await rejects(manager.install(entry), /Checksum mismatch/);
        strictEqual(await manager.isInstalled('kokoro-en'), false);
    });

    it('removes an installed voice', async () => {
        const manager = new VoiceDownloadManager({ rootDir: root, fetchBytes: fakeFetch });
        await manager.install(makeEntry([{ name: 'tokens.txt', url: 'https://x/tokens.txt' }]));
        strictEqual(await manager.isInstalled('kokoro-en'), true);
        await manager.remove('kokoro-en');
        strictEqual(await manager.isInstalled('kokoro-en'), false);
    });
});
