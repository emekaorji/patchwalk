import { buildDemoToken } from './auth/session.js';
import { startServer } from './server.js';

const demoToken = buildDemoToken({
    userId: 'user_2',
    email: 'milo@jungaria.dev',
    scopes: ['projects:read', 'projects:write'],
});

console.log('Demo bearer token for local requests:');
console.log(demoToken);

void startServer();
