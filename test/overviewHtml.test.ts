import { ok } from 'node:assert';

import { renderOverviewHtml } from '../src/extension/overview/overviewHtml';

describe('patchwalk overview editor html', () => {
    it('embeds the CSP nonce/source and the agenda + stats scaffolding', () => {
        const html = renderOverviewHtml({ cspSource: 'vscode-webview://xyz', nonce: 'OV3RV13W' });
        ok(html.includes('nonce-OV3RV13W'), 'CSP should reference the nonce');
        ok(html.includes('vscode-webview://xyz'), 'CSP should reference the webview source');
        ok(html.includes('<script nonce="OV3RV13W">'), 'script must carry the nonce');
        ok(html.includes('acquireVsCodeApi'), 'webview should acquire the vscode api');
        ok(html.includes('id="agenda"'), 'agenda container should be present');
        ok(html.includes('id="stats"'), 'stats header should be present');
        ok(html.includes('renderOverview'), 'overview renderer should be present');
        ok(html.includes('renderAgenda'), 'agenda renderer should be present');
    });

    it('wires the overview/progress inbound messages and the jump outbound message', () => {
        const html = renderOverviewHtml({ cspSource: 'vscode-webview://xyz', nonce: 'N' });
        ok(html.includes("msg.type === 'overview'"), 'handles the overview snapshot message');
        ok(html.includes("msg.type === 'progress'"), 'handles the live progress message');
        ok(html.includes("type: 'jump'"), 'agenda clicks post a jump message');
    });
});
