/**
 * The "which window is playing" chrome tint (Problem 4d). There is no window-frame glow API and no
 * transient/in-memory config target, so the honest strong signal is the Peacock mechanism: write a
 * merged set of `workbench.colorCustomizations` at the Workspace target while a walk plays, then
 * restore the exact prior value on stop. It is opt-in (off by default) because in a single-folder
 * workspace the Workspace write touches `.vscode/settings.json`.
 *
 * This module is deliberately vscode-free: the caller injects a config store + a persistent
 * memento, so the snapshot/merge/restore + crash-recovery logic can be unit-tested headlessly.
 */

export type TintCustomizations = Record<string, string>;

/** Reads/writes the workspace-scoped `workbench.colorCustomizations` object. */
export interface TintConfigStore {
    /** The current Workspace-target value of `workbench.colorCustomizations`, if any. */
    inspectWorkspaceValue(): TintCustomizations | undefined;
    /** Write (or, with `undefined`, clear) the Workspace-target value. */
    update(value: TintCustomizations | undefined): Promise<void>;
}

/** A durable key/value store that survives process death (VS Code's `Memento`). */
export interface TintMemento {
    get<T>(key: string): T | undefined;
    update(key: string, value?: unknown): Promise<void>;
}

const ACTIVE_FLAG_KEY = 'patchwalk.tint.active';
const PREVIOUS_VALUE_KEY = 'patchwalk.tint.previousColorCustomizations';

/**
 * The Patchwalk brand tint. A warm amber chrome, distinct at a glance among many windows, with a
 * dark foreground computed for readability. `window.active/inactiveBorder` are safe everywhere — a
 * real edge border on macOS/Linux with the custom title bar, silently ignored elsewhere.
 */
export const computeTintCustomizations = (): TintCustomizations => {
    const accent = '#e5a50a';
    const accentDeep = '#c98a00';
    const onAccent = '#1f1600';
    return {
        'titleBar.activeBackground': accent,
        'titleBar.activeForeground': onAccent,
        'titleBar.inactiveBackground': accentDeep,
        'titleBar.inactiveForeground': onAccent,
        'titleBar.border': accentDeep,
        'activityBar.background': accent,
        'activityBar.foreground': onAccent,
        'activityBar.inactiveForeground': '#5c4b00',
        'activityBar.activeBorder': onAccent,
        'activityBarBadge.background': onAccent,
        'activityBarBadge.foreground': accent,
        'statusBar.background': accent,
        'statusBar.foreground': onAccent,
        'window.activeBorder': accent,
        'window.inactiveBorder': accentDeep,
    };
};

/** Merge our tint keys over any existing customizations without clobbering the user's own. */
export const mergeTint = (
    existing: TintCustomizations | undefined,
    tint: TintCustomizations,
): TintCustomizations => {
    return { ...existing, ...tint };
};

/**
 * Is this customizations object carrying OUR tint? Used to reclaim a tint whose bookkeeping flag
 * was lost to a hard kill — the values are ours, so it is always safe to strip them.
 */
export const containsPatchwalkTint = (live: TintCustomizations | undefined): boolean => {
    if (!live) {
        return false;
    }
    const tint = computeTintCustomizations();
    const keys = Object.keys(tint);
    return keys.length > 0 && keys.every((key) => live[key] === tint[key]);
};

/**
 * Reverse the tint: from the CURRENT live customizations, restore each tint key to its pre-walk
 * value (or remove it if we added it), while leaving every other key — including edits the user or
 * another extension made DURING the walk — untouched. Returns `undefined` when nothing remains, so
 * the caller clears the workspace override entirely.
 */
export const unmergeTint = (
    live: TintCustomizations | undefined,
    previous?: TintCustomizations,
): TintCustomizations | undefined => {
    const result: TintCustomizations = { ...live };
    for (const key of Object.keys(computeTintCustomizations())) {
        if (previous && key in previous) {
            result[key] = previous[key];
        } else {
            delete result[key];
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
};

export class PatchwalkWindowTint {
    public constructor(
        private readonly store: TintConfigStore,
        private readonly memento: TintMemento,
        private readonly log: (message: string) => void = () => {},
    ) {}

    public isActive(): boolean {
        return this.memento.get<boolean>(ACTIVE_FLAG_KEY) === true;
    }

    /** Snapshot the current customizations, then merge the brand tint in. */
    public async apply(): Promise<void> {
        if (this.isActive()) {
            return;
        }
        const previous = this.store.inspectWorkspaceValue();
        // Persist the snapshot + flag BEFORE mutating, so a crash mid-walk can always self-heal.
        await this.memento.update(PREVIOUS_VALUE_KEY, previous ?? null);
        await this.memento.update(ACTIVE_FLAG_KEY, true);
        try {
            await this.store.update(mergeTint(previous, computeTintCustomizations()));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Patchwalk could not tint this window: ${message}`);
            await this.memento.update(ACTIVE_FLAG_KEY, false);
            await this.memento.update(PREVIOUS_VALUE_KEY);
        }
    }

    /** Restore the exact customizations captured by {@link apply}. */
    public async revert(): Promise<void> {
        if (!this.isActive()) {
            return;
        }
        await this.restorePrevious();
    }

    /** On activation: if a prior process died mid-walk with the tint applied, restore it now. */
    public async recover(): Promise<void> {
        if (this.isActive()) {
            this.log('Patchwalk restored a leftover window tint from a previous session.');
            await this.restorePrevious();
            return;
        }

        // The "tinting" flag lives in workspaceState, which VS Code writes ASYNCHRONOUSLY. A hard
        // kill (crash, force-quit) can lose the flag even though the tint already reached
        // .vscode/settings.json — which would strand it in the user's repo forever. So also
        // recognise our OWN tint by its values and strip it, flag or no flag.
        const live = this.store.inspectWorkspaceValue();
        if (!live || !containsPatchwalkTint(live)) {
            return;
        }
        this.log('Patchwalk removed an orphaned window tint left by a previous session.');
        try {
            await this.store.update(unmergeTint(live));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Patchwalk could not remove the orphaned window tint: ${message}`);
        }
    }

    private async restorePrevious(): Promise<void> {
        const previous =
            this.memento.get<TintCustomizations | null>(PREVIOUS_VALUE_KEY) ?? undefined;
        try {
            // Remove only our tint keys from the LIVE value so concurrent edits are preserved.
            await this.store.update(unmergeTint(this.store.inspectWorkspaceValue(), previous));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`Patchwalk could not restore the window tint: ${message}`);
        } finally {
            await this.memento.update(ACTIVE_FLAG_KEY, false);
            await this.memento.update(PREVIOUS_VALUE_KEY);
        }
    }
}
