/* eslint-disable no-await-in-loop -- assets are fetched one at a time on purpose, to keep a voice download from saturating the network. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { VoiceCatalogEntry } from './voiceCatalog';

/** Fetch a URL's bytes. Injected so downloads are testable without the network. */
export type FetchBytes = (
    url: string,
    onProgress?: (receivedBytes: number, totalBytes?: number) => void,
) => Promise<Uint8Array>;

export interface InstalledVoiceManifest {
    id: string;
    installedAt: string;
    files: string[];
}

const MANIFEST_NAME = '.installed.json';

export interface VoiceDownloadManagerOptions {
    /** Root directory for installed voices (e.g. `<globalStorage>/voices`). */
    rootDir: string;
    fetchBytes: FetchBytes;
    /** Injected clock so results are deterministic in tests. */
    now?: () => Date;
}

/**
 * Downloads and manages locally-installed neural voices. `install` fetches each file, verifies its
 * sha256, writes it under `<rootDir>/<id>/`, and records a manifest; `isInstalled`/`listInstalled`/
 * `remove`/`voiceDir` round it out. All IO except the fetch is real fs (node-safe); the fetch is
 * injected so the whole flow is unit-testable with a fake and NO real 80MB download.
 */
export class VoiceDownloadManager {
    public constructor(private readonly options: VoiceDownloadManagerOptions) {}

    public voiceDir(voiceId: string): string {
        return join(this.options.rootDir, voiceId);
    }

    public async isInstalled(voiceId: string): Promise<boolean> {
        try {
            await stat(join(this.voiceDir(voiceId), MANIFEST_NAME));
            return true;
        } catch {
            return false;
        }
    }

    public async listInstalled(voiceIds: string[]): Promise<string[]> {
        const installed: string[] = [];
        for (const voiceId of voiceIds) {
            if (await this.isInstalled(voiceId)) {
                installed.push(voiceId);
            }
        }
        return installed;
    }

    public async install(
        entry: VoiceCatalogEntry,
        onProgress?: (fileName: string, receivedBytes: number, totalBytes?: number) => void,
    ): Promise<InstalledVoiceManifest> {
        const dir = this.voiceDir(entry.id);
        await mkdir(dir, { recursive: true });

        const writtenFiles: string[] = [];
        for (const file of entry.files) {
            const bytes = await this.options.fetchBytes(file.url, (received, total) =>
                onProgress?.(file.name, received, total),
            );
            if (file.sha256) {
                const digest = createHash('sha256').update(bytes).digest('hex');
                if (digest !== file.sha256) {
                    // Do not leave a half-installed voice behind.
                    await rm(dir, { recursive: true, force: true });
                    throw new Error(
                        `Checksum mismatch for ${entry.id}/${file.name}: expected ${file.sha256}, got ${digest}.`,
                    );
                }
            }
            await writeFile(join(dir, file.name), bytes);
            writtenFiles.push(file.name);
        }

        const manifest: InstalledVoiceManifest = {
            id: entry.id,
            installedAt: (this.options.now?.() ?? new Date()).toISOString(),
            files: writtenFiles,
        };
        await writeFile(join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
        return manifest;
    }

    public async readManifest(voiceId: string): Promise<InstalledVoiceManifest | undefined> {
        try {
            const text = await readFile(join(this.voiceDir(voiceId), MANIFEST_NAME), 'utf8');
            return JSON.parse(text) as InstalledVoiceManifest;
        } catch {
            return undefined;
        }
    }

    public async remove(voiceId: string): Promise<void> {
        await rm(this.voiceDir(voiceId), { recursive: true, force: true });
    }
}
