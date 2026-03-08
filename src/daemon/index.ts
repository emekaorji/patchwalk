import process from 'node:process';

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
    // Create the singleton daemon for this process and then keep Node alive on the HTTP listener.
    const server = new PatchwalkMcpServer({
        port: readDaemonPort(),
    });

    const stopServer = async () => {
        // Shutdown logic is shared by both signal handlers so the close path stays consistent.
        await server.stop();
    };

    // The daemon keeps shutdown logic simple: stop accepting work and let Node exit.
    process.once('SIGINT', () => {
        stopServer().catch((error: unknown) => {
            console.error(error);
        });
    });
    process.once('SIGTERM', () => {
        stopServer().catch((error: unknown) => {
            console.error(error);
        });
    });

    await server.start();
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
