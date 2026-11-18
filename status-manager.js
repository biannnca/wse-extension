/**
 * WSE - World Simulation Engine
 * Chat-scoped status storage.
 *
 * Everything WSE knows about a chat lives in one object under
 * `chat_metadata.wse_data`. That keeps the extension stateless between page
 * reloads (SillyTavern persists chat metadata with the chat file) and confined
 * to a single namespaced key that is safe to delete.
 *
 * The manager never imports core modules directly; it talks to the public
 * `SillyTavern.getContext()` surface:
 *   - `context.chatMetadata`         === core `chat_metadata`     (st-context.js:135)
 *   - `context.saveMetadataDebounced` === core save helper         (st-context.js:136)
 *   - `context.saveMetadata`          === immediate save           (st-context.js:156)
 *   - `context.chatId`                === current chat id          (st-context.js:125-127)
 */

/** Metadata key used in `chat_metadata`. */
export const WSE_METADATA_KEY = 'wse_data';

/** Schema version of the stored payload. */
export const WSE_STATE_VERSION = 1;

/** @param {unknown} value */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** JSON clone; WSE state is JSON-only by contract. */
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * @typedef {object} WSEState
 * @property {number} version Schema version.
 * @property {string | null} chatId Chat id this state belongs to.
 * @property {string | null} createdAt ISO timestamp of first initialisation.
 * @property {string | null} updatedAt ISO timestamp of the last save.
 * @property {number} messageCount Number of user messages observed.
 * @property {number | null} lastMessageId Last observed user-message index.
 * @property {Record<string, unknown>} flags Free-form extension flags.
 * @property {Record<string, Record<string, unknown>>} characters Per-character production stats
 *   written by the simulation engine (`{ "林茜": { affection, corruption, ... } }`).
 * @property {Array<unknown>} discoverableClues Clue objects revealed by simulations.
 * @property {Array<unknown>} events Event objects produced by simulations (most recent last).
 */

/**
 * Fresh state object.
 * @returns {WSEState}
 */
export function createDefaultState() {
    return {
        version: WSE_STATE_VERSION,
        chatId: null,
        createdAt: null,
        updatedAt: null,
        messageCount: 0,
        lastMessageId: null,
        flags: {},
        characters: {},
        discoverableClues: [],
        events: [],
    };
}

/**
 * Coerces whatever is stored in `wse_data` into a complete, safely-typed state.
 * Tolerates `null`, `undefined`, legacy/partial objects and wrong types.
 * @param {unknown} raw Value read from `chat_metadata.wse_data`.
 * @param {string | null} [chatId] Chat id to stamp when the payload has none.
 * @returns {WSEState}
 */
export function normaliseState(raw, chatId = null) {
    const defaults = createDefaultState();

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ...defaults, chatId: chatId ?? null };
    }

    const source = /** @type {Record<string, unknown>} */ (raw);

    return {
        version: Number.isFinite(source.version) ? Number(source.version) : defaults.version,
        chatId: typeof source.chatId === 'string' ? source.chatId : (chatId ?? null),
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : defaults.createdAt,
        updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : defaults.updatedAt,
        messageCount: Number.isFinite(source.messageCount) ? Number(source.messageCount) : defaults.messageCount,
        lastMessageId: Number.isFinite(source.lastMessageId) ? Number(source.lastMessageId) : defaults.lastMessageId,
        flags: source.flags && typeof source.flags === 'object' && !Array.isArray(source.flags)
            ? { .../** @type {Record<string, unknown>} */ (source.flags) }
            : defaults.flags,
        characters: isPlainObject(source.characters) ? cloneJson(source.characters) : defaults.characters,
        discoverableClues: Array.isArray(source.discoverableClues)
            ? cloneJson(source.discoverableClues)
            : defaults.discoverableClues,
        events: Array.isArray(source.events) ? cloneJson(source.events) : defaults.events,
    };
}

function log(...args) {
    console.log('WSE:', ...args);
}

/**
 * Reads and writes WSE state for the currently open chat.
 */
export class WSEStatusManager {
    /**
     * @param {{ debug?: boolean }} [options]
     */
    constructor({ debug = true } = {}) {
        /** @type {boolean} */
        this.debug = debug;
        /** @type {WSEState} Last known state. */
        this.state = createDefaultState();
        /** @type {boolean} Whether `load()` found a stored `wse_data`. */
        this.hasStoredState = false;
        /** @type {WSEState | null} Raw normalised payload from the last `load()`. */
        this.lastLoaded = null;
    }

    /** @private */
    getContext() {
        if (!globalThis.SillyTavern || typeof globalThis.SillyTavern.getContext !== 'function') {
            throw new Error('WSE: SillyTavern.getContext() is unavailable');
        }
        return globalThis.SillyTavern.getContext();
    }

    /**
     * Reads `chat_metadata.wse_data` for the current chat.
     * Never throws on a missing/partial payload: returns a default state instead.
     * @returns {WSEState} Normalised current state.
     */
    load() {
        const context = this.getContext();
        const chatMetadata = context.chatMetadata;

        if (!chatMetadata || typeof chatMetadata !== 'object') {
            throw new Error('WSE: chat metadata is unavailable (no chat open?)');
        }

        const raw = chatMetadata[WSE_METADATA_KEY];
        this.hasStoredState = Boolean(raw && typeof raw === 'object' && !Array.isArray(raw));
        this.lastLoaded = this.hasStoredState ? normaliseState(raw, context.chatId ?? null) : null;
        this.state = normaliseState(raw, context.chatId ?? null);

        if (this.debug) {
            log(`load() chat="${context.chatId ?? 'null'}" stored=${this.hasStoredState}`, JSON.stringify(this.state));
        }

        return this.state;
    }

    /**
     * Writes `chat_metadata.wse_data` and schedules a debounced metadata save.
     * The payload is merged over the last known state, so partial updates are fine.
     * @param {Partial<WSEState>} [data] Fields to merge into the stored state.
     * @returns {WSEState} The state that was written.
     */
    save(data = {}) {
        const context = this.getContext();
        const chatMetadata = context.chatMetadata;

        if (!chatMetadata || typeof chatMetadata !== 'object') {
            throw new Error('WSE: chat metadata is unavailable (no chat open?)');
        }

        const base = this.state ?? createDefaultState();
        const next = normaliseState({
            ...base,
            ...data,
            version: WSE_STATE_VERSION,
            chatId: typeof data.chatId === 'string' ? data.chatId : (base.chatId ?? context.chatId ?? null),
            createdAt: data.createdAt ?? base.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }, context.chatId ?? null);

        chatMetadata[WSE_METADATA_KEY] = next;
        this.state = next;
        this.hasStoredState = true;

        // Persist with the chat file. Debounced by design: fires once the user
        // stops mutating metadata, and is dropped if the chat/character changes
        // before the timer runs (extensions.js:89-113).
        context.saveMetadataDebounced();

        if (this.debug) {
            log(`save() chat="${context.chatId ?? 'null'}"`, JSON.stringify(next));
        }

        return next;
    }

    /**
     * Convenience for the scaffolding probe: bump the observed message counter.
     * @param {number | null} [messageId]
     * @returns {WSEState}
     */
    incrementMessageCount(messageId = null) {
        const current = this.load();
        return this.save({
            messageCount: (current.messageCount ?? 0) + 1,
            lastMessageId: typeof messageId === 'number' ? messageId : null,
        });
    }
}
