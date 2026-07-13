/**
 * The static catalog of downloadable neural voices. Pure and node-safe so the Voices panel and the
 * download manager can be tested without touching the network. Each entry lists the files to fetch
 * (with optional sha256) plus the sherpa-onnx model layout used to build the engine.
 *
 * NOTE: the concrete URLs/checksums for Kokoro-82M must be filled from the pinned sherpa-onnx
 * release before shipping (`[!] needs-manual`) — the shape here is what the download manager and UI
 * consume; the exact asset locations are a build-time detail.
 */

export interface VoiceCatalogFile {
    /** Destination filename inside the voice's install dir. */
    name: string;
    url: string;
    sha256?: string;
}

export interface VoiceCatalogEntry {
    id: string;
    label: string;
    kind: 'neural';
    family: 'kokoro';
    sizeMB: number;
    license: string;
    files: VoiceCatalogFile[];
    /** Sherpa Kokoro speaker id (0-based). */
    speakerId: number;
}

export const VOICE_CATALOG: readonly VoiceCatalogEntry[] = [
    {
        id: 'kokoro-en',
        label: 'Kokoro — English (neural)',
        kind: 'neural',
        family: 'kokoro',
        sizeMB: 90,
        license: 'Apache-2.0',
        speakerId: 0,
        files: [
            // TODO(needs-manual): pin exact asset URLs + sha256 from the sherpa-onnx Kokoro release.
            { name: 'model.onnx', url: 'https://example.invalid/kokoro-en/model.onnx' },
            { name: 'voices.bin', url: 'https://example.invalid/kokoro-en/voices.bin' },
            { name: 'tokens.txt', url: 'https://example.invalid/kokoro-en/tokens.txt' },
        ],
    },
];

export const findCatalogEntry = (voiceId: string): VoiceCatalogEntry | undefined =>
    VOICE_CATALOG.find((entry) => entry.id === voiceId);
