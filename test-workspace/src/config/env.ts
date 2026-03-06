export type AppEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
    environment: AppEnvironment;
    port: number;
    requestTimeoutMs: number;
    enableVerboseAuditLogs: boolean;
}

const DEFAULT_PORT = 4020;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

const isEnvironment = (value: string): value is AppEnvironment => {
    return value === 'development' || value === 'test' || value === 'production';
};

const readNumber = (
    rawValue: string | undefined,
    fallbackValue: number,
    fieldName: string,
): number => {
    if (!rawValue) {
        return fallbackValue;
    }

    const parsedValue = Number(rawValue);
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        throw new Error(`Environment variable ${fieldName} must be a positive number.`);
    }

    return parsedValue;
};

export const loadAppConfig = (
    env: NodeJS.ProcessEnv = process.env,
): AppConfig => {
    const environment = env.NODE_ENV ?? 'development';
    if (!isEnvironment(environment)) {
        throw new Error(`Unsupported NODE_ENV value: ${environment}`);
    }

    return {
        environment,
        port: readNumber(env.PORT, DEFAULT_PORT, 'PORT'),
        requestTimeoutMs: readNumber(
            env.REQUEST_TIMEOUT_MS,
            DEFAULT_REQUEST_TIMEOUT_MS,
            'REQUEST_TIMEOUT_MS',
        ),
        enableVerboseAuditLogs: env.ENABLE_VERBOSE_AUDIT_LOGS === 'true',
    };
};

export const appConfig = loadAppConfig();
