import { strictEqual } from 'node:assert';

import { isReclaimablePatchwalkDaemon } from '../src/extension/daemonClient';

describe('safe port reclaim (P7)', () => {
    it('only reclaims a process that identifies as a Patchwalk daemon', () => {
        strictEqual(isReclaimablePatchwalkDaemon('patchwalk-daemon'), true);
        // Anything else on the port is a stranger's process — never terminated.
        strictEqual(isReclaimablePatchwalkDaemon('some-other-server'), false);
        strictEqual(isReclaimablePatchwalkDaemon(), false);
        strictEqual(isReclaimablePatchwalkDaemon(''), false);
    });
});
