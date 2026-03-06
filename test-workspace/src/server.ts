import { createServer } from 'node:http';

import { appConfig } from './config/env.js';
import { createApp } from './http/createApp.js';

export const startServer = async (): Promise<void> => {
    const app = createApp();
    const server = createServer((request, response) => {
        void app(request, response);
    });

    await new Promise<void>((resolve) => {
        server.listen(appConfig.port, () => {
            resolve();
        });
    });

    console.log(
        `Demo API listening on http://127.0.0.1:${appConfig.port} (${appConfig.environment})`,
    );
};
