import { deepStrictEqual, ok, strictEqual } from 'node:assert';

import type { TintConfigStore, TintCustomizations, TintMemento } from '../src/extension/windowTint';
import {
    computeTintCustomizations,
    mergeTint,
    PatchwalkWindowTint,
} from '../src/extension/windowTint';

/**
 * The window tint's snapshot/merge/restore + crash-recovery is pure over an injected config store
 * and memento, so it is verified headlessly here (no real workspace settings are touched).
 */

class FakeStore implements TintConfigStore {
    public value: TintCustomizations | undefined;
    public updates: Array<TintCustomizations | undefined> = [];
    public constructor(initial?: TintCustomizations) {
        this.value = initial;
    }

    public inspectWorkspaceValue(): TintCustomizations | undefined {
        return this.value;
    }

    public async update(value: TintCustomizations | undefined): Promise<void> {
        this.value = value;
        this.updates.push(value);
    }
}

class FakeMemento implements TintMemento {
    private readonly map = new Map<string, unknown>();
    public get<T>(key: string): T | undefined {
        return this.map.get(key) as T | undefined;
    }

    public async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.map.delete(key);
        } else {
            this.map.set(key, value);
        }
    }
}

describe('patchwalk window tint', () => {
    it('applies the brand tint over an absent value and restores to absent', async () => {
        const store = new FakeStore(undefined);
        const memento = new FakeMemento();
        const tint = new PatchwalkWindowTint(store, memento);

        await tint.apply();
        strictEqual(tint.isActive(), true);
        // Our keys are present after apply.
        ok(store.value && 'titleBar.activeBackground' in store.value);

        await tint.revert();
        strictEqual(tint.isActive(), false);
        // Restored to absent (undefined), not an empty object.
        strictEqual(store.value, undefined);
    });

    it('merges over existing customizations and restores them exactly', async () => {
        const existing = { 'editor.background': '#123456', 'titleBar.activeBackground': '#000000' };
        const store = new FakeStore({ ...existing });
        const tint = new PatchwalkWindowTint(store, new FakeMemento());

        await tint.apply();
        // The user's unrelated key survives; our tint overrode the shared key.
        strictEqual(store.value?.['editor.background'], '#123456');
        strictEqual(
            store.value?.['titleBar.activeBackground'],
            computeTintCustomizations()['titleBar.activeBackground'],
        );

        await tint.revert();
        // Restored byte-for-byte to what the user had before.
        deepStrictEqual(store.value, existing);
    });

    it('is idempotent: a second apply does not overwrite the snapshot', async () => {
        const existing = { 'editor.background': '#abcdef' };
        const store = new FakeStore({ ...existing });
        const tint = new PatchwalkWindowTint(store, new FakeMemento());

        await tint.apply();
        await tint.apply(); // no-op
        await tint.revert();
        deepStrictEqual(store.value, existing);
    });

    it('preserves an edit made to colorCustomizations during the walk', async () => {
        const store = new FakeStore(undefined);
        const tint = new PatchwalkWindowTint(store, new FakeMemento());

        await tint.apply();
        // The user (or another extension) adds an unrelated key while the walk plays.
        store.value = { ...store.value, 'editor.background': '#101010' };

        await tint.revert();
        // The concurrent edit survives; only our tint keys were removed.
        deepStrictEqual(store.value, { 'editor.background': '#101010' });
    });

    it('reclaims an orphaned tint even when the crash lost the bookkeeping flag', async () => {
        // workspaceState is written asynchronously, so a hard kill can lose the "tinting" flag while
        // the tint is already on disk. Without this, the tint is stranded in the user's repo forever.
        const store = new FakeStore(undefined);
        const applied = new PatchwalkWindowTint(store, new FakeMemento());
        await applied.apply();
        const tintedValue = store.value;

        // New session: the tint is on disk, but the memento came back EMPTY (flag never flushed).
        const freshMemento = new FakeMemento();
        const recovered = new PatchwalkWindowTint(store, freshMemento);
        strictEqual(recovered.isActive(), false, 'the flag is genuinely gone');
        ok(tintedValue && 'titleBar.activeBackground' in tintedValue);

        await recovered.recover();

        strictEqual(store.value, undefined, 'the orphaned tint must still be stripped');
    });

    it('leaves a tint that is NOT ours alone', async () => {
        const theirs = { 'titleBar.activeBackground': '#123456' };
        const store = new FakeStore({ ...theirs });
        const tint = new PatchwalkWindowTint(store, new FakeMemento());

        await tint.recover();

        deepStrictEqual(store.value, theirs, "someone else's customizations must survive");
    });

    it('recovers a leftover tint from a crashed session', async () => {
        const previous = { 'editor.background': '#eeeeee' };
        const memento = new FakeMemento();
        // Simulate: a prior process applied the tint and died before reverting.
        await memento.update('patchwalk.tint.active', true);
        await memento.update('patchwalk.tint.previousColorCustomizations', previous);
        // The store still holds the merged (dirty) value.
        const store = new FakeStore(mergeTint(previous, computeTintCustomizations()));
        const tint = new PatchwalkWindowTint(store, memento);

        await tint.recover();
        strictEqual(tint.isActive(), false);
        deepStrictEqual(store.value, previous);
    });
});
