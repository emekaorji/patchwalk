import { deepStrictEqual, ok, strictEqual } from 'node:assert';

import { renderWalkMonitorHtml } from '../src/extension/sidebar/walkMonitorHtml';
import {
    applyWalkMonitorProgress,
    idleDaemonStatus,
    idleVoicesState,
    idleWalkMonitorState,
    isWalkMonitorWebviewMessage,
    walkMonitorStateFromWalk,
    walkMonitorStateOnEnd,
} from '../src/extension/sidebar/walkMonitorModel';

const TRANSCRIPT = [
    { stepIndex: 0, stepId: 'summary', title: 'Overview', narration: 'Why this change.' },
    { stepIndex: 1, stepId: 'step-1', title: 'Refresh handler', narration: 'Rotates tokens.' },
];

describe('walk monitor model', () => {
    it('produces an inactive idle state', () => {
        const state = idleWalkMonitorState();
        strictEqual(state.active, false);
        strictEqual(state.currentStepIndex, -1);
        deepStrictEqual(state.steps, []);
    });

    it('builds a walk state and flags the summary cue', () => {
        const state = walkMonitorStateFromWalk({
            handoffId: 'walk-1',
            summary: 'Fix a race.',
            transcript: TRANSCRIPT,
        });
        strictEqual(state.active, true);
        strictEqual(state.handoffId, 'walk-1');
        strictEqual(state.stepCount, 2);
        strictEqual(state.steps[0].isSummary, true);
        strictEqual(state.steps[1].isSummary, false);
        strictEqual(state.currentStepIndex, 0);
        strictEqual(state.playbackState, 'playing');
    });

    it('applies progress updates', () => {
        const state = walkMonitorStateFromWalk({
            handoffId: 'walk-1',
            summary: 'x',
            transcript: TRANSCRIPT,
        });
        const next = applyWalkMonitorProgress(state, { stepIndex: 1, playbackState: 'paused' });
        strictEqual(next.currentStepIndex, 1);
        strictEqual(next.playbackState, 'paused');
        // original is not mutated
        strictEqual(state.currentStepIndex, 0);
    });

    it('keeps the transcript but marks inactive when the walk ends (P4)', () => {
        const state = walkMonitorStateFromWalk({
            handoffId: 'walk-1',
            summary: 'x',
            transcript: TRANSCRIPT,
        });
        const ended = walkMonitorStateOnEnd(state);
        strictEqual(ended.active, false);
        strictEqual(ended.playbackState, 'idle');
        strictEqual(ended.currentStepIndex, -1);
        strictEqual(ended.steps.length, 2); // transcript persists
    });

    it('validates webview messages including voice actions', () => {
        strictEqual(isWalkMonitorWebviewMessage({ type: 'ready' }), true);
        strictEqual(isWalkMonitorWebviewMessage({ type: 'control', action: 'stop' }), true);
        strictEqual(isWalkMonitorWebviewMessage({ type: 'control', action: 'replay' }), true);
        strictEqual(isWalkMonitorWebviewMessage({ type: 'jump', stepIndex: 2 }), true);
        strictEqual(
            isWalkMonitorWebviewMessage({ type: 'downloadVoice', voiceId: 'kokoro-en' }),
            true,
        );
        strictEqual(isWalkMonitorWebviewMessage({ type: 'selectVoice', voiceId: 'system' }), true);
        strictEqual(
            isWalkMonitorWebviewMessage({ type: 'removeVoice', voiceId: 'kokoro-en' }),
            true,
        );
        strictEqual(isWalkMonitorWebviewMessage({ type: 'control', action: 'launch' }), false);
        strictEqual(isWalkMonitorWebviewMessage({ type: 'jump', stepIndex: 'x' }), false);
        strictEqual(isWalkMonitorWebviewMessage({ type: 'downloadVoice', voiceId: '' }), false);
        strictEqual(isWalkMonitorWebviewMessage({ type: 'selectVoice' }), false);
        strictEqual(isWalkMonitorWebviewMessage({ type: 'other' }), false);
        strictEqual(isWalkMonitorWebviewMessage(null), false);
    });

    it('has an idle voices state defaulting to the system voice', () => {
        const voices = idleVoicesState();
        deepStrictEqual(voices.options, []);
        strictEqual(voices.activeId, 'system');
    });

    it('has an idle daemon status that is disconnected', () => {
        const status = idleDaemonStatus();
        strictEqual(status.connected, false);
        strictEqual(status.activeWalkElsewhere, false);
    });
});

describe('walk monitor html', () => {
    it('embeds the CSP nonce and source and the transport controls', () => {
        const html = renderWalkMonitorHtml({
            cspSource: 'vscode-webview://abc',
            nonce: 'N0NCE123',
        });
        ok(html.includes('nonce-N0NCE123'), 'CSP should reference the nonce');
        ok(html.includes('vscode-webview://abc'), 'CSP should reference the webview source');
        ok(html.includes('<script nonce="N0NCE123">'), 'script must carry the nonce');
        for (const id of ['btn-previous', 'btn-playpause', 'btn-stop', 'btn-next', 'btn-replay']) {
            ok(html.includes(`id="${id}"`), `control ${id} should be present`);
        }
        ok(html.includes('id="transcript"'), 'transcript list should be present');
        ok(html.includes('acquireVsCodeApi'), 'webview should acquire the vscode api');
    });

    it('renders the Voices panel and wires voice actions', () => {
        const html = renderWalkMonitorHtml({
            cspSource: 'vscode-webview://abc',
            nonce: 'N0NCE123',
        });
        ok(html.includes('id="voices"'), 'voices list should be present');
        ok(html.includes('renderVoices'), 'voices renderer should be present');
        ok(html.includes("type: 'downloadVoice'"), 'download action should be wired');
        ok(html.includes("type: 'selectVoice'"), 'select action should be wired');
        ok(html.includes("type: 'removeVoice'"), 'remove action should be wired');
        ok(html.includes('id="daemonStatus"'), 'daemon status section should be present');
        ok(html.includes('renderDaemonStatus'), 'daemon status renderer should be present');
    });
});
