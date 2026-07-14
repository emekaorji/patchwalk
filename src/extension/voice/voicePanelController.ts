/* eslint-disable no-await-in-loop -- voices are inspected in order so the panel reports a stable, deterministic state. */
import * as vscode from 'vscode';

import type { WalkMonitorVoiceOption, WalkMonitorVoicesState } from '../sidebar/walkMonitorModel';
import type { VoicePanelController } from '../sidebar/walkMonitorView';
import type { AudioPlayer } from './killableAudioPlayer';
import { ChildProcessAudioPlayer } from './killableAudioPlayer';
import { findCatalogEntry, VOICE_CATALOG } from './voiceCatalog';
import type { VoiceDownloadManager } from './voiceDownloadManager';
import type { VoiceManager } from './voiceManager';
import { buildNeuralEngineForVoice } from './voiceSetup';

export interface VoicePanelControllerOptions {
    voiceManager: VoiceManager;
    downloadManager: VoiceDownloadManager;
    tmpDir: string;
    log: (message: string) => void;
}

/**
 * Backs the sidebar's Voices panel: list/download/remove/select against the download + voice
 * managers.
 */
export class PatchwalkVoicePanelController implements VoicePanelController, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly downloading = new Set<string>();
    private readonly player: AudioPlayer = new ChildProcessAudioPlayer();

    public constructor(private readonly options: VoicePanelControllerOptions) {}

    public onDidChange(listener: () => void): vscode.Disposable {
        return this.changeEmitter.event(listener);
    }

    public async getVoicesState(): Promise<WalkMonitorVoicesState> {
        const options: WalkMonitorVoiceOption[] = [
            {
                id: 'system',
                label: 'System voice',
                kind: 'system',
                installed: true,
                downloading: false,
                available: true,
            },
        ];
        for (const entry of VOICE_CATALOG) {
            options.push({
                id: entry.id,
                label: `${entry.label} · ${entry.sizeMB} MB · ${entry.license}`,
                kind: 'neural',
                installed: await this.options.downloadManager.isInstalled(entry.id),
                downloading: this.downloading.has(entry.id),
                available: entry.available,
                note: entry.available ? undefined : 'Experimental — not yet available',
            });
        }
        return {
            options,
            activeId: this.activeId(),
            detail: this.options.voiceManager.getStatus().detail,
        };
    }

    public async download(voiceId: string): Promise<void> {
        const entry = findCatalogEntry(voiceId);
        if (!entry) {
            return;
        }
        if (!entry.available) {
            // The UI disables this, but never let a stray message start a download that cannot work.
            this.options.log(
                `Patchwalk voice "${entry.label}" is experimental and not available to download yet.`,
            );
            return;
        }
        this.downloading.add(voiceId);
        this.changeEmitter.fire();
        try {
            await this.options.downloadManager.install(entry);
            const engine = buildNeuralEngineForVoice(
                entry,
                this.options.downloadManager.voiceDir(voiceId),
                this.player,
                this.options.tmpDir,
            );
            if (engine) {
                this.options.voiceManager.registerEngine(engine);
                this.options.log(`Patchwalk: installed voice "${voiceId}".`);
            } else {
                this.options.log(
                    `Patchwalk: voice "${voiceId}" downloaded, but the sherpa-onnx runtime is unavailable.`,
                );
            }
        } finally {
            this.downloading.delete(voiceId);
            this.changeEmitter.fire();
        }
    }

    public async remove(voiceId: string): Promise<void> {
        this.options.voiceManager.unregisterEngine(voiceId);
        await this.options.downloadManager.remove(voiceId);
        if (this.activeId() === voiceId) {
            await this.setActive('system');
        }
        this.changeEmitter.fire();
    }

    public async select(voiceId: string): Promise<void> {
        await this.setActive(voiceId);
        this.changeEmitter.fire();
    }

    public dispose(): void {
        this.changeEmitter.dispose();
    }

    private activeId(): string {
        return vscode.workspace.getConfiguration('patchwalk').get<string>('voice', 'system');
    }

    private async setActive(voiceId: string): Promise<void> {
        await vscode.workspace
            .getConfiguration('patchwalk')
            .update('voice', voiceId, vscode.ConfigurationTarget.Global);
    }
}
