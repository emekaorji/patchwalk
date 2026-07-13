/* eslint-disable no-await-in-loop -- engines are registered in order; each registration depends on the filesystem state left by the last. */
import { mkdir } from 'node:fs/promises';

import type { AudioPlayer } from './killableAudioPlayer';
import { ChildProcessAudioPlayer } from './killableAudioPlayer';
import { LocalNeuralEngine } from './localNeuralEngine';
import { loadSherpaKokoroSynth } from './neuralSynth';
import type { VoiceCatalogEntry } from './voiceCatalog';
import { VOICE_CATALOG } from './voiceCatalog';
import type { FetchBytes, VoiceDownloadManager } from './voiceDownloadManager';
import type { VoiceManager } from './voiceManager';

/** Build a neural engine for an installed voice, or null if the sherpa-onnx runtime is unavailable. */
export const buildNeuralEngineForVoice = (
    entry: VoiceCatalogEntry,
    modelDir: string,
    player: AudioPlayer,
    tmpDir: string,
): LocalNeuralEngine | null => {
    const synth = loadSherpaKokoroSynth({ modelDir, speakerId: entry.speakerId });
    if (!synth) {
        return null;
    }
    return new LocalNeuralEngine({ id: entry.id, label: entry.label, synth, player, tmpDir });
};

/** Streaming HTTP fetch (with progress) for real voice downloads. Node 18+ `fetch`. */
export const httpFetchBytes: FetchBytes = async (url, onProgress) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
    }
    const total = Number(response.headers.get('content-length') ?? '') || undefined;
    const reader = response.body?.getReader();
    if (!reader) {
        const buffer = new Uint8Array(await response.arrayBuffer());
        onProgress?.(buffer.byteLength, total);
        return buffer;
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        received += value.byteLength;
        onProgress?.(received, total);
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
};

export interface RegisterVoicesOptions {
    downloadManager: VoiceDownloadManager;
    voiceManager: VoiceManager;
    tmpDir: string;
    log: (message: string) => void;
}

/**
 * Build and register a {@link LocalNeuralEngine} for each installed neural voice whose native
 * runtime actually loads. If sherpa-onnx isn't installed the voice is skipped (the VoiceManager
 * keeps the system voice), never breaking activation.
 */
export const registerInstalledNeuralVoices = async (
    options: RegisterVoicesOptions,
): Promise<void> => {
    await mkdir(options.tmpDir, { recursive: true });
    const player = new ChildProcessAudioPlayer();

    for (const entry of VOICE_CATALOG) {
        if (!(await options.downloadManager.isInstalled(entry.id))) {
            continue;
        }
        const engine = buildNeuralEngineForVoice(
            entry,
            options.downloadManager.voiceDir(entry.id),
            player,
            options.tmpDir,
        );
        if (!engine) {
            options.log(
                `Patchwalk: voice "${entry.id}" is installed but the sherpa-onnx runtime is unavailable; using the system voice.`,
            );
            continue;
        }
        options.voiceManager.registerEngine(engine);
        options.log(`Patchwalk: registered neural voice "${entry.id}".`);
    }
};
