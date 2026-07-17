/**
 * Pure builder for the Patchwalk overview editor's webview HTML. Kept vscode-free so it can be
 * asserted in unit tests. The panel opens when a walk launches and renders the agenda + stats of
 * everything about to be explained — the fix for the "the overview segment feels dead" problem:
 * even before any code file opens, this surface shows what the walk will cover and lights up the
 * segment being narrated. It receives an `overview` snapshot and live `progress` messages, and
 * posts `jump`.
 */

export interface OverviewHtmlOptions {
    cspSource: string;
    nonce: string;
}

export const renderOverviewHtml = (options: OverviewHtmlOptions): string => {
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
        background: var(--vscode-editor-background);
        margin: 0;
    }
    .page { max-width: 720px; margin: 0 auto; padding: 28px 24px 60px; }

    .hero {
        border-radius: 12px; padding: 20px 22px;
        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        position: relative; overflow: hidden;
    }
    .hero.speaking { animation: pw-glow 2.2s ease-in-out infinite; }
    @keyframes pw-glow {
        0%, 100% { box-shadow: 0 0 0 0 rgba(229,165,10,0); }
        50% { box-shadow: 0 0 22px 2px rgba(229,165,10,.45); }
    }
    .kicker { display: flex; align-items: center; gap: 8px; font-size: 11px;
        text-transform: uppercase; letter-spacing: .09em; opacity: .65; font-weight: 600; }
    .kicker .pulse { width: 9px; height: 9px; border-radius: 50%;
        background: var(--vscode-charts-yellow, #e5a50a); }
    h1 { font-size: 22px; line-height: 1.25; margin: 10px 0 6px; font-weight: 650; }
    .summary { font-size: 14px; line-height: 1.55; opacity: .9; margin: 0; }

    .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0 6px; }
    .stat {
        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
        border-radius: 8px; padding: 8px 14px; min-width: 84px;
    }
    .stat .n { font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .stat .k { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; opacity: .6; }

    .progress { margin: 20px 0 4px; }
    .progress .row { display: flex; align-items: center; gap: 10px; font-size: 12px; opacity: .8; }
    .bar { flex: 1 1 auto; height: 5px; border-radius: 4px; margin-top: 6px;
        background: var(--vscode-progressBar-background, rgba(128,128,128,.25)); overflow: hidden; }
    .bar > span { display: block; height: 100%; width: 0%;
        background: var(--vscode-charts-yellow, #e5a50a); transition: width .3s ease; }

    h2.agenda-h { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
        opacity: .6; font-weight: 600; margin: 30px 2px 12px; }

    .step { border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.25));
        margin: 0 0 6px; padding: 2px 0 2px 0; }
    .beat {
        display: flex; gap: 10px; padding: 8px 12px; border-radius: 8px; cursor: pointer;
        align-items: baseline; margin-left: -2px; border-left: 2px solid transparent;
    }
    .beat:hover { background: var(--vscode-list-hoverBackground); }
    .beat.current {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        border-left-color: var(--vscode-charts-yellow, var(--vscode-focusBorder));
    }
    .beat.done .marker { color: var(--vscode-charts-green, #3fb950); }
    .beat.summary { cursor: default; }
    .marker { flex: 0 0 auto; width: 18px; text-align: center; font-size: 12px; opacity: .8; }
    .beat.current .marker { color: var(--vscode-charts-yellow, #e5a50a); }
    .beat-body { flex: 1 1 auto; min-width: 0; }
    .beat-title { font-weight: 600; font-size: 13px; }
    .beat.sub .beat-title { font-weight: 500; opacity: .92; }
    .beat-why { font-size: 12px; line-height: 1.45; opacity: .8; margin-top: 2px; }
    .beat-meta { font-size: 10px; opacity: .55; margin-left: auto; white-space: nowrap;
        font-family: var(--vscode-editor-font-family, monospace); }
    .sub { margin-left: 16px; }

    .foot { margin-top: 26px; font-size: 11px; opacity: .5; text-align: center; }
</style>
</head>
<body>
    <div class="page">
        <div class="hero" id="hero">
            <div class="kicker"><span class="pulse"></span><span id="kicker">Patchwalk walk</span></div>
            <h1 id="title">Preparing walk…</h1>
            <p class="summary" id="summary"></p>
            <div class="stats" id="stats"></div>
            <div class="progress">
                <div class="row"><span id="progressLabel">Getting ready…</span></div>
                <div class="bar"><span id="barFill"></span></div>
            </div>
        </div>

        <h2 class="agenda-h">What this walk covers</h2>
        <div id="agenda"></div>

        <div class="foot">Patchwalk narrates each segment aloud while its lines are highlighted in the code.</div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const el = (id) => document.getElementById(id);
        const post = (message) => vscode.postMessage(message);

        let overview = null;
        let currentIndex = -1;
        let playbackState = 'playing';

        function fmtDuration(seconds) {
            if (!seconds || seconds < 1) { return '—'; }
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            if (m <= 0) { return s + 's'; }
            return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
        }

        function lineChip(a, b) {
            if (typeof a !== 'number') { return ''; }
            return a === b ? ('L' + a) : ('L' + a + '–' + b);
        }

        function statBlock(n, k) {
            const wrap = document.createElement('div');
            wrap.className = 'stat';
            const num = document.createElement('div');
            num.className = 'n'; num.textContent = String(n);
            const key = document.createElement('div');
            key.className = 'k'; key.textContent = k;
            wrap.appendChild(num); wrap.appendChild(key);
            return wrap;
        }

        function renderStats() {
            const stats = el('stats');
            stats.textContent = '';
            if (!overview) { return; }
            stats.appendChild(statBlock(overview.fileCount, overview.fileCount === 1 ? 'file' : 'files'));
            stats.appendChild(statBlock(overview.stepCount, overview.stepCount === 1 ? 'step' : 'steps'));
            stats.appendChild(statBlock(overview.segmentCount, 'sub-segments'));
            stats.appendChild(statBlock(fmtDuration(overview.estimatedSeconds), 'est. read'));
        }

        function beat(opts) {
            const row = document.createElement('div');
            const classes = ['beat'];
            if (opts.sub) { classes.push('sub'); }
            if (opts.kind === 'summary') { classes.push('summary'); }
            if (opts.index === currentIndex) { classes.push('current'); }
            else if (currentIndex > opts.index) { classes.push('done'); }
            row.className = classes.join(' ');

            const marker = document.createElement('span');
            marker.className = 'marker';
            if (opts.index === currentIndex) { marker.textContent = playbackState === 'paused' ? '❙❙' : '▶'; }
            else if (currentIndex > opts.index) { marker.textContent = '✓'; }
            else { marker.textContent = '○'; }
            row.appendChild(marker);

            const body = document.createElement('div');
            body.className = 'beat-body';
            const title = document.createElement('div');
            title.className = 'beat-title';
            title.textContent = opts.title;
            body.appendChild(title);
            if (opts.why) {
                const why = document.createElement('div');
                why.className = 'beat-why';
                why.textContent = opts.why;
                body.appendChild(why);
            }
            row.appendChild(body);

            const chip = lineChip(opts.startLine, opts.endLine);
            if (chip) {
                const meta = document.createElement('span');
                meta.className = 'beat-meta';
                meta.textContent = chip;
                row.appendChild(meta);
            }

            if (opts.kind !== 'summary' && typeof opts.index === 'number') {
                row.addEventListener('click', () => post({ type: 'jump', stepIndex: opts.index }));
            }
            return row;
        }

        function renderAgenda() {
            const agenda = el('agenda');
            agenda.textContent = '';
            if (!overview) { return; }
            // The opening overview beat (index 0) grounds the "what am I about to hear".
            agenda.appendChild(beat({
                index: 0, kind: 'summary', title: 'Overview', why: overview.summary,
            }));
            for (const step of overview.steps) {
                const group = document.createElement('div');
                group.className = 'step';
                group.appendChild(beat({
                    index: step.stepIndex, kind: 'step', title: step.title, why: step.narration,
                    startLine: step.startLine, endLine: step.endLine,
                }));
                for (const seg of step.segments) {
                    group.appendChild(beat({
                        index: seg.stepIndex, kind: 'segment', sub: true, title: seg.narration,
                        startLine: seg.startLine, endLine: seg.endLine,
                    }));
                }
                agenda.appendChild(group);
            }
        }

        function renderProgress() {
            const total = overview ? overview.cueCount : 0;
            const pct = total > 0 ? Math.round(((currentIndex + 1) / total) * 100) : 0;
            el('barFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
            el('progressLabel').textContent = total > 0
                ? ('Segment ' + (currentIndex + 1) + ' of ' + total + ' · ' + playbackState)
                : 'Getting ready…';
            const hero = el('hero');
            hero.className = 'hero' + (playbackState === 'playing' ? ' speaking' : '');
        }

        function renderOverview() {
            if (!overview) { return; }
            el('kicker').textContent = 'Patchwalk · ' + (overview.producer ? overview.producer.agent : 'walk');
            el('title').textContent = overview.summary.length > 90
                ? (overview.summary.slice(0, 88) + '…')
                : overview.summary;
            el('summary').textContent =
                'This walk will explain the change out loud, step by step, highlighting the code as it goes.';
            renderStats();
            renderAgenda();
            renderProgress();
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg) { return; }
            if (msg.type === 'overview') {
                overview = msg.data;
                renderOverview();
            } else if (msg.type === 'progress') {
                currentIndex = msg.stepIndex;
                playbackState = msg.playbackState || playbackState;
                renderAgenda();
                renderProgress();
            }
        });

        post({ type: 'ready' });
    </script>
</body>
</html>`;
};
