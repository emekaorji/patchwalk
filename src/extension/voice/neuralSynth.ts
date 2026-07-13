/**
 * Neural speech synthesis, decoupled from the specific runtime. `LocalNeuralEngine` depends only on
 * this interface, so it is fully unit-testable with a fake synth. The concrete sherpa-onnx-backed
 * synth is loaded lazily and guarded: if the native addon or model isn't installed, the loader
 * returns `null` and the VoiceManager falls back to the system voice.
 *
 * NOTE: the real sherpa integration below is `[!] needs-manual` — it requires the native
 * `sherpa-onnx-node` addon (kept out of the esbuild bundle via `external`) plus a downloaded model,
 * neither of which can be exercised in the headless test harness.
 */

export interface SynthResult {
    samples: Float32Array;
    sampleRate: number;
}

export interface NeuralSynth {
    synthesize(text: string): Promise<SynthResult>;
    dispose?(): void;
}

export interface SherpaKokoroModelConfig {
    /** Directory containing the model files (model.onnx, voices.bin, tokens.txt, espeak-ng-data/). */
    modelDir: string;
    modelFile?: string;
    voicesFile?: string;
    tokensFile?: string;
    dataDir?: string;
    /** Kokoro speaker id (0-based). */
    speakerId?: number;
    speed?: number;
    numThreads?: number;
}

interface SherpaOfflineTts {
    generate(input: { text: string; sid: number; speed: number }): {
        samples: Float32Array;
        sampleRate: number;
    };
}

interface SherpaModule {
    OfflineTts: new (config: unknown) => SherpaOfflineTts;
}

/** Statically-required so esbuild's `external` keeps it; returns undefined when not installed. */
const loadSherpaModule = (): SherpaModule | undefined => {
    try {
        // The native addon is an OPTIONAL dependency, required lazily so a machine without it still
        // runs (narration simply falls back to the system voice).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('sherpa-onnx-node') as SherpaModule;
    } catch {
        return undefined;
    }
};

/**
 * Build a sherpa-onnx Kokoro synth, or return null if the native addon isn't available. The exact
 * config shape mirrors the sherpa-onnx-node Kokoro example; verify against the pinned version when
 * wiring the real model (needs-manual).
 */
export const loadSherpaKokoroSynth = (config: SherpaKokoroModelConfig): NeuralSynth | null => {
    const sherpa = loadSherpaModule();
    if (!sherpa) {
        return null;
    }

    const join = (file: string): string => `${config.modelDir.replace(/\/$/, '')}/${file}`;
    const tts = new sherpa.OfflineTts({
        model: {
            kokoro: {
                model: join(config.modelFile ?? 'model.onnx'),
                voices: join(config.voicesFile ?? 'voices.bin'),
                tokens: join(config.tokensFile ?? 'tokens.txt'),
                dataDir: config.dataDir ?? join('espeak-ng-data'),
            },
            numThreads: config.numThreads ?? 2,
            provider: 'cpu',
            debug: false,
        },
        maxNumSentences: 1,
    });

    const speakerId = config.speakerId ?? 0;
    const speed = config.speed ?? 1;
    return {
        async synthesize(text: string): Promise<SynthResult> {
            const audio = tts.generate({ text, sid: speakerId, speed });
            return { samples: audio.samples, sampleRate: audio.sampleRate };
        },
    };
};
