/**
 * Pure builder for the walk-monitor webview HTML. Kept separate (and vscode-free) so it can be
 * asserted in unit tests. The webview renders {@link WalkMonitorViewState} pushed from the extension
 * and posts control/jump messages back.
 */

export interface WalkMonitorHtmlOptions {
    cspSource: string;
    nonce: string;
}

export const renderWalkMonitorHtml = (options: WalkMonitorHtmlOptions): string => {
    const { cspSource, nonce } = options;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        padding: 0;
        margin: 0;
    }
    .wrap { padding: 12px 12px 20px; }
    h2 {
        font-size: 11px; text-transform: uppercase; letter-spacing: .07em; font-weight: 600;
        opacity: .6; margin: 18px 2px 8px;
    }

    #idle {
        opacity: .7; font-style: italic; line-height: 1.5; margin: 6px 2px;
    }

    /* ---- Now Playing card ---- */
    #live { display: none; }
    #live.show { display: block; }
    .card {
        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
        border-radius: 8px;
        padding: 12px 12px 10px;
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    }
    .card-top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .pulse {
        width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
        background: var(--vscode-charts-yellow, #e5a50a);
        box-shadow: 0 0 0 0 var(--vscode-charts-yellow, #e5a50a);
        animation: pw-pulse 1.6s ease-out infinite;
    }
    .card.paused .pulse, .card.stopping .pulse { animation: none; opacity: .5; }
    @keyframes pw-pulse {
        0% { box-shadow: 0 0 0 0 rgba(229,165,10,.5); }
        70% { box-shadow: 0 0 0 7px rgba(229,165,10,0); }
        100% { box-shadow: 0 0 0 0 rgba(229,165,10,0); }
    }
    #state {
        margin-left: auto; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
        padding: 2px 7px; border-radius: 9px;
        background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    #nowStep { font-weight: 600; font-size: 13px; line-height: 1.35; }
    #nowWhy { opacity: .82; font-size: 12px; line-height: 1.45; margin-top: 4px; }
    .progress-row { display: flex; align-items: center; gap: 8px; margin: 10px 0 2px; }
    #counter { font-size: 11px; opacity: .7; white-space: nowrap; }
    .bar { flex: 1 1 auto; height: 4px; border-radius: 3px;
        background: var(--vscode-progressBar-background, rgba(128,128,128,.25)); overflow: hidden; }
    .bar > span { display: block; height: 100%; width: 0%;
        background: var(--vscode-charts-yellow, #e5a50a); transition: width .25s ease; }

    .controls { display: flex; gap: 6px; margin: 12px 0 2px; }
    .controls button {
        flex: 1 1 auto; min-width: 34px; cursor: pointer;
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
        border: none; border-radius: 5px; padding: 6px 0; font-size: 14px; line-height: 1;
    }
    .controls button:hover { background: var(--vscode-button-hoverBackground); }
    .controls button:disabled { opacity: .4; cursor: default; }
    #btn-playpause { flex: 1.4 1 auto; }

    /* ---- Transcript ---- */
    ol#transcript { list-style: none; margin: 0; padding: 0; }
    #transcript li {
        padding: 5px 8px; margin: 2px 0; border-radius: 5px; cursor: pointer;
        border-left: 2px solid transparent;
    }
    #transcript li.summary { cursor: default; }
    #transcript li.segment { margin-left: 14px; padding-left: 10px;
        border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
    #transcript li:not(.summary):hover { background: var(--vscode-list-hoverBackground); }
    #transcript li.current {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        border-left-color: var(--vscode-charts-yellow, var(--vscode-focusBorder));
    }
    #transcript li.current.segment { border-left-width: 2px; }
    .t-head { display: flex; align-items: baseline; gap: 6px; }
    .t-title { font-weight: 600; font-size: 12px; }
    .t-lines { font-size: 10px; opacity: .6; margin-left: auto; white-space: nowrap;
        font-family: var(--vscode-editor-font-family, monospace); }
    .t-why { opacity: .82; font-size: 12px; line-height: 1.4; margin-top: 2px; }
    #transcript li.current .t-lines, #transcript li.current .t-why { opacity: .95; }
    .t-badge { font-size: 9px; text-transform: uppercase; letter-spacing: .05em; opacity: .6;
        border: 1px solid currentColor; border-radius: 6px; padding: 0 5px; }

    /* ---- Voices ---- */
    #voiceDetail { opacity: .8; font-size: 12px; margin: 2px 2px 6px; line-height: 1.4; }
    ul#voices { list-style: none; margin: 0; padding: 0; }
    #voices li { display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 6px 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.12)); }
    #voices li:last-child { border-bottom: none; }
    #voices li.active .v-name { font-weight: 600; }
    #voices .v-name { display: flex; align-items: center; gap: 6px; }
    #voices .v-actions { display: flex; gap: 6px; }
    #voices .v-actions button {
        cursor: pointer; font-size: 11px; padding: 3px 9px; border: none; border-radius: 4px;
        color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #voices .v-actions button.secondary {
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        background: var(--vscode-button-secondaryBackground, transparent);
    }
    #voices .v-actions button:hover { background: var(--vscode-button-hoverBackground); }
    #voices .v-actions button:disabled { opacity: .5; cursor: default; }

    /* ---- Daemon ---- */
    #daemonStatus { display: flex; align-items: center; gap: 7px; font-size: 12px; opacity: .9; }
    #daemonStatus .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
        background: var(--vscode-testing-iconFailed, #d33); }
    #daemonStatus.connected .dot { background: var(--vscode-testing-iconPassed, #3a3); }
</style>
</head>
<body>
    <div class="wrap">
        <div id="idle">No active walk. Launch one with the Patchwalk MCP tool, or with &ldquo;Play Walk From Clipboard&rdquo;.</div>

        <div id="live">
            <div class="card" id="nowCard">
                <div class="card-top">
                    <span class="pulse"></span>
                    <span style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;opacity:.6;font-weight:600;">Now playing</span>
                    <span id="state"></span>
                </div>
                <div id="nowStep"></div>
                <div id="nowWhy"></div>
                <div class="progress-row">
                    <span id="counter"></span>
                    <span class="bar"><span id="barFill"></span></span>
                </div>
                <div class="controls">
                    <button id="btn-previous" title="Previous">⏮</button>
                    <button id="btn-playpause" title="Pause / Resume">⏸</button>
                    <button id="btn-stop" title="Stop">⏹</button>
                    <button id="btn-next" title="Next">⏭</button>
                    <button id="btn-replay" title="Replay current segment">↻</button>
                </div>
            </div>
        </div>

        <h2 id="transcriptHeading" hidden>Walk transcript</h2>
        <ol id="transcript"></ol>

        <h2>Voices</h2>
        <div id="voiceDetail"></div>
        <ul id="voices"></ul>

        <h2>Daemon</h2>
        <div id="daemonStatus"><span id="daemonDot" class="dot"></span><span id="daemonDetail"></span></div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const el = (id) => document.getElementById(id);
        const post = (message) => vscode.postMessage(message);

        el('btn-previous').addEventListener('click', () => post({ type: 'control', action: 'previous' }));
        el('btn-next').addEventListener('click', () => post({ type: 'control', action: 'next' }));
        el('btn-stop').addEventListener('click', () => post({ type: 'control', action: 'stop' }));
        el('btn-replay').addEventListener('click', () => post({ type: 'control', action: 'replay' }));
        el('btn-playpause').addEventListener('click', () => {
            const paused = el('btn-playpause').dataset.paused === 'true';
            post({ type: 'control', action: paused ? 'resume' : 'pause' });
        });

        function lineChip(step) {
            if (typeof step.startLine !== 'number') { return ''; }
            return step.startLine === step.endLine
                ? ('L' + step.startLine)
                : ('L' + step.startLine + '–' + step.endLine);
        }

        function render(state) {
            const steps = state.steps || [];
            const hasWalk = steps.length > 0;
            el('idle').hidden = hasWalk;
            el('live').className = state.active ? 'show' : '';
            el('transcriptHeading').hidden = !hasWalk;

            el('state').textContent = state.playbackState;
            const card = el('nowCard');
            if (card) { card.className = 'card ' + state.playbackState; }
            const paused = state.playbackState === 'paused';
            el('btn-playpause').dataset.paused = String(paused);
            el('btn-playpause').textContent = paused ? '▶' : '⏸';
            el('btn-playpause').title = paused ? 'Resume' : 'Pause';

            const current = steps.find((s) => s.stepIndex === state.currentStepIndex);
            el('nowStep').textContent = current ? current.title : (state.summary || '');
            el('nowWhy').textContent = current ? current.narration : (state.summary || '');
            el('counter').textContent = state.stepCount
                ? 'Segment ' + (state.currentStepIndex + 1) + ' / ' + state.stepCount
                : '';
            const pct = state.stepCount > 0
                ? Math.round(((state.currentStepIndex + 1) / state.stepCount) * 100)
                : 0;
            el('barFill').style.width = Math.max(0, Math.min(100, pct)) + '%';

            const list = el('transcript');
            list.textContent = '';
            let currentNode = null;
            for (const step of steps) {
                const li = document.createElement('li');
                const kind = step.kind || (step.isSummary ? 'summary' : 'step');
                const classes = [kind];
                if (step.stepIndex === state.currentStepIndex) { classes.push('current'); }
                li.className = classes.join(' ');
                li.dataset.index = String(step.stepIndex);

                const head = document.createElement('div');
                head.className = 't-head';
                if (kind === 'segment') {
                    // A sub-segment leads with its spoken beat; its line range sits on the right.
                    const why = document.createElement('div');
                    why.className = 't-why';
                    why.style.marginTop = '0';
                    why.textContent = step.narration;
                    head.appendChild(why);
                } else {
                    const title = document.createElement('span');
                    title.className = 't-title';
                    title.textContent = step.title;
                    head.appendChild(title);
                    if (kind === 'summary') {
                        const badge = document.createElement('span');
                        badge.className = 't-badge';
                        badge.textContent = 'overview';
                        head.appendChild(badge);
                    }
                }
                const chip = lineChip(step);
                if (chip) {
                    const lines = document.createElement('span');
                    lines.className = 't-lines';
                    lines.textContent = chip;
                    head.appendChild(lines);
                }
                li.appendChild(head);

                if (kind === 'step') {
                    const why = document.createElement('div');
                    why.className = 't-why';
                    why.textContent = step.narration;
                    li.appendChild(why);
                }

                // Every row is a play target, including the opening Overview (restart from the top).
                li.addEventListener('click', () => post({ type: 'jump', stepIndex: step.stepIndex }));
                if (classes.indexOf('current') !== -1) { currentNode = li; }
                list.appendChild(li);
            }
            if (currentNode && currentNode.scrollIntoView) {
                currentNode.scrollIntoView({ block: 'nearest' });
            }
        }

        function renderVoices(voices) {
            el('voiceDetail').textContent = voices.detail || '';
            const list = el('voices');
            list.textContent = '';
            for (const voice of voices.options || []) {
                const li = document.createElement('li');
                li.className = voice.id === voices.activeId ? 'active' : '';
                const name = document.createElement('span');
                name.className = 'v-name';
                name.textContent = voice.label + (voice.id === voices.activeId ? '  ✓' : '');
                const actions = document.createElement('span');
                actions.className = 'v-actions';
                if (voice.kind === 'neural' && !voice.installed) {
                    const download = document.createElement('button');
                    download.textContent = voice.downloading ? 'Downloading…' : 'Download';
                    download.disabled = voice.downloading;
                    download.addEventListener('click', () => post({ type: 'downloadVoice', voiceId: voice.id }));
                    actions.appendChild(download);
                } else {
                    if (voice.id !== voices.activeId) {
                        const use = document.createElement('button');
                        use.textContent = 'Use';
                        use.addEventListener('click', () => post({ type: 'selectVoice', voiceId: voice.id }));
                        actions.appendChild(use);
                    }
                    if (voice.kind === 'neural' && voice.installed) {
                        const remove = document.createElement('button');
                        remove.className = 'secondary';
                        remove.textContent = 'Remove';
                        remove.addEventListener('click', () => post({ type: 'removeVoice', voiceId: voice.id }));
                        actions.appendChild(remove);
                    }
                }
                li.appendChild(name);
                li.appendChild(actions);
                list.appendChild(li);
            }
        }

        function renderDaemonStatus(status) {
            const container = el('daemonStatus');
            container.className = status.connected ? 'connected' : '';
            let detail = status.detail || '';
            if (status.activeWalkElsewhere) {
                detail += ' · a walk is playing in another window';
            }
            el('daemonDetail').textContent = detail;
        }

        window.addEventListener('message', (event) => {
            if (!event.data) {
                return;
            }
            if (event.data.type === 'state') {
                render(event.data.state);
            } else if (event.data.type === 'voices') {
                renderVoices(event.data.voices);
            } else if (event.data.type === 'daemonStatus') {
                renderDaemonStatus(event.data.status);
            }
        });

        post({ type: 'ready' });
    </script>
</body>
</html>`;
};
