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
    /**
     * Can this voice actually be installed in a SHIPPED build?
     *
     * Neural voices need two things we do not ship yet: pinned model assets, and the sherpa-onnx
     * NATIVE addon (which esbuild cannot bundle). Until both land, the voice is advertised as
     * experimental and the download is disabled — an honest "not yet" beats a button that fails.
     */
    available: boolean;
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
        // Not installable yet: the asset URLs below are placeholders, and the sherpa-onnx native
        // runtime is not shipped. The Voices panel therefore shows this as experimental and refuses
        // to download it. Flip to `true` once BOTH are real.
        available: false,
        files: [
            // TODO: pin exact asset URLs + sha256 from the sherpa-onnx Kokoro release.
            { name: 'model.onnx', url: 'https://example.invalid/kokoro-en/model.onnx' },
            { name: 'voices.bin', url: 'https://example.invalid/kokoro-en/voices.bin' },
            { name: 'tokens.txt', url: 'https://example.invalid/kokoro-en/tokens.txt' },
        ],
    },
];

export const findCatalogEntry = (voiceId: string): VoiceCatalogEntry | undefined =>
    VOICE_CATALOG.find((entry) => entry.id === voiceId);
