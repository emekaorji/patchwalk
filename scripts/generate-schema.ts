import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { patchwalkHandoffJsonSchema } from '../src/schema';

const outputPath = path.resolve(__dirname, '../schema/handoff-1.0.schema.json');

async function writeSchemaFile(): Promise<void> {
    const schemaContents = `${JSON.stringify(patchwalkHandoffJsonSchema, null, 2)}\n`;

    await mkdir(path.dirname(outputPath), { recursive: true });

    let existingContents: string | undefined;
    try {
        existingContents = await readFile(outputPath, 'utf8');
    } catch {
        existingContents = undefined;
    }

    if (existingContents === schemaContents) {
        return;
    }

    await writeFile(outputPath, schemaContents, 'utf8');
}

writeSchemaFile().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to generate Patchwalk schema: ${message}`);
    process.exitCode = 1;
});
