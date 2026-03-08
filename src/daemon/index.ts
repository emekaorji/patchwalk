import process from 'node:process';

import * as logger from './logger';
import { PatchwalkMcpServer } from './mcpServer';

/**
 * This file is the standalone daemon entrypoint that gets bundled next to the extension entrypoint.
 * The extension spawns this process when the local daemon is missing instead of hosting MCP inside
 * the window process.
 */
const readDaemonPort = (): number => {
    // The daemon is debuggable outside VS Code, so local CLI overrides need to win first.
    // CLI flags win so manual debugging can override persisted settings easily.
    const cliPortIndex = process.argv.indexOf('--port');
    if (cliPortIndex >= 0) {
        const cliPort = Number(process.argv[cliPortIndex + 1] ?? '');
        if (Number.isFinite(cliPort) && cliPort > 0) {
            return cliPort;
        }
    }

    const environmentPort = Number(process.env.PATCHWALK_DAEMON_PORT ?? '');
    if (Number.isFinite(environmentPort) && environmentPort > 0) {
        return environmentPort;
    }

    return 7357;
};

const main = async (): Promise<void> => {
    const daemonPort = readDaemonPort();
    logger.info('Patchwalk daemon bootstrap started.', {
        pid: process.pid,
        configuredPort: daemonPort,
    });

    // Create the singleton daemon for this process and then keep Node alive on the HTTP listener.
    const server = new PatchwalkMcpServer({
        port: daemonPort,
    });

    let stopPromise: Promise<void> | undefined;
    const stopServer = async (reason: string): Promise<void> => {
        if (stopPromise) {
            return stopPromise;
        }

        // Shutdown logic is shared by both signal handlers so the close path stays consistent.
        stopPromise = (async () => {
            logger.info('Patchwalk daemon shutdown requested.', { reason });
            await server.stop();
            logger.info('Patchwalk daemon stopped.');
            await logger.close();
        })();
        await stopPromise;
    };

    // The daemon keeps shutdown logic simple: stop accepting work and let Node exit.
    process.once('SIGINT', () => {
        stopServer('SIGINT').catch((error: unknown) => {
            logger.error('Patchwalk daemon failed to stop cleanly after SIGINT.', error);
            console.error(error);
        });
    });
    process.once('SIGTERM', () => {
        stopServer('SIGTERM').catch((error: unknown) => {
            logger.error('Patchwalk daemon failed to stop cleanly after SIGTERM.', error);
            console.error(error);
        });
    });

    await server.start();
    logger.info('Patchwalk daemon is accepting requests.', {
        endpointUrl: server.endpointUrl ?? null,
        listeningPort: server.listeningPort ?? daemonPort,
    });
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
