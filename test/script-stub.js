/**
 * Node-only stub of SillyTavern's `/script.js` module, used by selftest.mjs.
 *
 * `index.js` and `simulation-engine.js` import `../../../../script.js`, which in
 * the browser resolves to `/script.js`. Under Node that path has no meaning, so
 * selftest.mjs registers a resolve hook that maps the exact specifier to this
 * file. SillyTavern never loads this file.
 *
 * Exports mirror the real module's shape for the symbols WSE uses:
 *   - `is_send_press`  (live `export let`, public/script.js:603)
 *   - `generateRaw`    (public/script.js:4122)
 */

/** Mirrors `export let is_send_press = false;` in script.js:603. */
export let is_send_press = false;

/**
 * Test controls for `generateRaw`.
 * mode: 'ok' returns `text`; 'error' throws; 'slow' waits for `pending` resolvers.
 * `text` defaults to a valid production-mode simulation answer.
 */
export const __stub = {
    calls: [],
    mode: 'ok',
    text: JSON.stringify({
        events: [
            {
                participants: ['林茜', '{{user}}'],
                summary: 'stub simulation event',
                statDeltas: { affection: 2, corruption: 1 },
            },
        ],
        newState: {
            characters: {
                林茜: { affection: 5, corruption: 2, trust: 1 },
            },
        },
        clues: [{ id: 'stub-clue', text: 'stub clue text', discoveredAt: null }],
    }),
    errorMessage: 'stub generateRaw failure',
    pending: [],
    reset() {
        this.calls.length = 0;
        this.mode = 'ok';
        this.pending.length = 0;
    },
};

/**
 * Stub of `generateRaw({ prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema })`.
 * @param {object} params
 * @returns {Promise<string>}
 */
export async function generateRaw(params) {
    __stub.calls.push(params);

    if (__stub.mode === 'error') {
        throw new Error(__stub.errorMessage);
    }

    if (__stub.mode === 'slow') {
        return await new Promise(resolve => {
            __stub.pending.push(resolve);
        });
    }

    return __stub.text;
}

/** Lets the test flip the live `is_send_press` binding. */
export function __setIsSendPress(value) {
    is_send_press = Boolean(value);
}
