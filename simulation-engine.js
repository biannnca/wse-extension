/**
 * WSE - World Simulation Engine :: simulation engine (Production Mode)
 *
 * What changed from demo mode
 * ---------------------------
 * - `triggerSimulation(reason)` no longer fakes progress with a message counter
 *   alone: it performs a real LLM call through `generateRaw()` (re-entrancy
 *   safe — it never touches `is_send_press`, never shows/hides `#mes_stop` and
 *   never emits `GENERATION_STARTED`/`GENERATION_ENDED`, public/script.js:4000-4114).
 * - The prompt is compiled from the live `wse_data` JSON plus the bundled
 *   character card description (`lin-qian-card.json`, extracted from
 *   `investigation/target_card.json`).
 * - The model must answer with a single JSON object:
 *     { "events": [...], "newState": { "characters": {...} }, "clues": [...] }
 *   Valid JSON is merged into `wse_data` via `processDelta()`; invalid JSON is
 *   logged and leaves the state untouched.
 * - `isSimulating` is a hard recursion/re-entrancy guard.
 *
 * Robustness contract
 * -------------------
 * - single-flight: while `isSimulating` is true the engine returns immediately;
 * - AI failures and JSON failures are reported in the returned event, never
 *   thrown into the chat pipeline;
 * - prototype-pollution guard on every merge;
 * - `onChange(state)` fires after every successful state write.
 */

import { generateRaw } from '../../../../script.js';
import { WSEStatusManager, createDefaultState } from './status-manager.js';

const LOG_PREFIX = 'WSE:';

/** Schema version of the simulation event. */
export const WSE_EVENT_VERSION = 2;

/** Response budget for the AI simulation call. */
export const AI_RESPONSE_LENGTH = 1024;

/** Bundled character card shipped next to this module. */
const CARD_URL = new URL('./lin-qian-card.json', import.meta.url).href;

/** Maximum characters of card text injected into the prompt. */
const CARD_DESCRIPTION_LIMIT = 4000;

/** Retained history caps, so `wse_data` cannot grow without bound. */
const MAX_EVENTS = 100;
const MAX_CLUES = 200;

/** Reasons that perform a real simulation step. */
const SIMULATION_REASONS = new Set(['message_sent', 'manual']);

/** Keys that must never be merged into state (prototype pollution guard). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** @type {object | null} Cached character card. */
let cachedCard = null;
/** @type {Promise<object | null> | null} In-flight card load. */
let cardLoadPromise = null;

/** @param {unknown} value */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Structured clone via JSON; WSE state is JSON-only by contract. */
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * Recursively merges `delta` into `base` without mutating either argument.
 * Plain objects merge deeply; arrays and primitives replace.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} delta
 * @returns {Record<string, unknown>}
 */
export function deepMerge(base, delta) {
    const result = isPlainObject(base) ? { ...base } : {};

    if (!isPlainObject(delta)) {
        return result;
    }

    for (const [key, value] of Object.entries(delta)) {
        if (FORBIDDEN_KEYS.has(key)) {
            continue;
        }

        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = deepMerge(result[key], value);
        } else if (isPlainObject(value) || Array.isArray(value)) {
            result[key] = cloneJson(value);
        } else {
            result[key] = value;
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Character card
// ---------------------------------------------------------------------------

/**
 * Loads (and caches) the bundled character card.
 * Returns `null` when the card cannot be fetched (e.g. under Node in the
 * self-test); the prompt then states that the description is unavailable.
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object | null>}
 */
export async function loadCharacterCard({ force = false } = {}) {
    if (cachedCard && !force) {
        return cachedCard;
    }
    if (cardLoadPromise && !force) {
        return cardLoadPromise;
    }

    cardLoadPromise = (async () => {
        try {
            if (typeof fetch !== 'function') {
                throw new Error('fetch() unavailable');
            }
            const response = await fetch(CARD_URL);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const card = await response.json();
            cachedCard = card;
            console.log(`${LOG_PREFIX} [engine] character card loaded: ${card?.data?.name ?? '(unnamed)'}`);
            return card;
        } catch (error) {
            console.warn(`${LOG_PREFIX} [engine] character card unavailable: ${error?.message ?? error}`);
            return null;
        } finally {
            cardLoadPromise = null;
        }
    })();

    return cardLoadPromise;
}

/**
 * Injects a character card directly (tests / manual overrides).
 * @param {object | null} card
 */
export function setCharacterCard(card) {
    cachedCard = card ?? null;
}

/** Clears the cached card so the next simulation re-fetches it. */
export function resetCharacterCardCache() {
    cachedCard = null;
    cardLoadPromise = null;
}

/**
 * Flattens the textual parts of a V1/V2/V3 character card.
 * @param {object | null} card
 * @returns {string}
 */
export function extractCharacterDescription(card) {
    const data = isPlainObject(card?.data) ? card.data : card;
    if (!isPlainObject(data)) {
        return '';
    }

    const parts = [];
    const push = (label, value) => {
        if (typeof value === 'string' && value.trim()) {
            parts.push(`${label}:\n${value.trim()}`);
        }
    };

    push('Name', data.name);
    push('Description', data.description);
    push('Personality', data.personality);
    push('Scenario', data.scenario);

    const text = parts.join('\n\n');
    if (!text) {
        return '';
    }

    return text.length > CARD_DESCRIPTION_LIMIT
        ? `${text.slice(0, CARD_DESCRIPTION_LIMIT)}\n…[truncated]`
        : text;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/** System prompt for the simulation call. */
export function buildSystemPrompt() {
    return [
        'You are the World Simulation Engine (WSE) for a SillyTavern roleplay chat featuring Lin Qian (林茜).',
        'You advance a hidden world simulation in small, consistent, plausible steps that follow the character card and the current state.',
        'Rules:',
        '- Never write story prose, dialogue, or actions for the user; never speak as a character.',
        '- Only report changes that are plausible consequences of the latest user message.',
        '- Keep numeric stat changes small (typically -10..+10).',
        '- Reply with a single JSON object and nothing else. No markdown, no commentary.',
        'Output schema (all fields required; use empty arrays/objects when nothing changes):',
        '{',
        '  "events": [ { "participants": ["..."], "summary": "one sentence", "statDeltas": { "affection": 0, "corruption": 0 } } ],',
        '  "newState": { "characters": { "林茜": { "affection": 0, "corruption": 0, "trust": 0 } } },',
        '  "clues": [ { "id": "kebab-case-id", "text": "what the player can discover", "discoveredAt": "ISO-8601 or null" } ]',
        '}',
    ].join('\n');
}

/**
 * Compiles the simulation prompt from the live state + character card.
 * Deterministic and side-effect free, so it can be asserted in tests.
 * @param {import('./status-manager.js').WSEState} state
 * @param {object | null} [card]
 * @returns {{ systemPrompt: string, prompt: string, hasCardDescription: boolean, characterName: string }}
 */
export function buildSimulationPrompt(state, card = null) {
    const data = isPlainObject(card?.data) ? card.data : card;
    const characterName = typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : '林茜 (Lin Qian)';
    const description = extractCharacterDescription(card);
    const stateJson = JSON.stringify(state ?? {}, null, 2);

    const prompt = [
        '# Character card',
        description || '(character card description unavailable)',
        '',
        '# Current state (wse_data JSON)',
        '```json',
        stateJson,
        '```',
        '',
        '# Latest turn',
        'The user just sent a message in this chat.',
        '',
        '# Task',
        'Update the hidden world simulation: report triggered events, the new per-character state, and any clues the player can now discover.',
        'Answer with one JSON object exactly matching the schema in the system prompt, nothing else.',
    ].join('\n');

    return {
        systemPrompt: buildSystemPrompt(),
        prompt,
        hasCardDescription: Boolean(description),
        characterName,
    };
}

// ---------------------------------------------------------------------------
// Response parsing / merging
// ---------------------------------------------------------------------------

/**
 * Extracts the first JSON object from an LLM answer (tolerates code fences and
 * surrounding prose).
 * @param {unknown} text
 * @returns {{ ok: true, data: Record<string, unknown> } | { ok: false, error: string }}
 */
export function parseSimulationResponse(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'empty response' };
    }

    let candidate = text.trim();
    const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        candidate = fence[1].trim();
    }

    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) {
        return { ok: false, error: 'no JSON object found in response' };
    }

    try {
        const data = JSON.parse(candidate.slice(start, end + 1));
        if (!isPlainObject(data)) {
            return { ok: false, error: 'parsed JSON is not an object' };
        }
        return { ok: true, data };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

/**
 * Validates/coerces the parsed response against the expected schema.
 * @param {Record<string, unknown>} data
 * @returns {{ events: object[], clues: object[], newState: object, characters: object }}
 */
export function normaliseSimulationResult(data) {
    const events = Array.isArray(data?.events) ? data.events.filter(isPlainObject) : [];
    const clues = Array.isArray(data?.clues)
        ? data.clues.filter(clue => isPlainObject(clue) || typeof clue === 'string')
        : [];
    const newState = isPlainObject(data?.newState) ? data.newState : {};
    const characters = isPlainObject(newState.characters) ? newState.characters : {};

    return { events, clues, newState, characters };
}

/**
 * Builds the `wse_data` delta from a validated simulation result.
 * @param {import('./status-manager.js').WSEState} current
 * @param {ReturnType<typeof normaliseSimulationResult>} result
 * @returns {Record<string, unknown>}
 */
export function buildStateDelta(current, result) {
    const delta = {};

    if (isPlainObject(result.characters) && Object.keys(result.characters).length > 0) {
        delta.characters = deepMerge(current.characters ?? {}, result.characters);
    }

    if (result.events.length > 0) {
        delta.events = [...(Array.isArray(current.events) ? current.events : []), ...result.events].slice(-MAX_EVENTS);
    }

    if (result.clues.length > 0) {
        delta.discoverableClues = [
            ...(Array.isArray(current.discoverableClues) ? current.discoverableClues : []),
            ...result.clues,
        ].slice(-MAX_CLUES);
    }

    return delta;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * The world simulation engine.
 */
export class WSEEngine {
    /**
     * @param {object} [options]
     * @param {WSEStatusManager | null} [options.statusManager] Reuse the manager owned by index.js.
     * @param {((state: import('./status-manager.js').WSEState) => void) | null} [options.onChange] Called after every state write.
     * @param {boolean} [options.debug] Verbose console logging.
     * @param {boolean} [options.ai] When false, skips the LLM call (tests only).
     */
    constructor({ statusManager = null, onChange = null, debug = true, ai = true } = {}) {
        this.statusManager = statusManager ?? new WSEStatusManager({ debug });
        this.onChange = onChange;
        this.debug = debug;
        this.ai = ai;
        /** Recursion / re-entrancy guard. */
        this.isSimulating = false;
        /** @type {object | null} Last event produced. */
        this.lastEvent = null;
    }

    /** @private */
    log(...args) {
        if (this.debug) {
            console.log(LOG_PREFIX, '[engine]', ...args);
        }
    }

    /** @private */
    notifyChange(state) {
        if (typeof this.onChange !== 'function') {
            return;
        }
        try {
            this.onChange(state);
        } catch (error) {
            console.error(`${LOG_PREFIX} [engine] onChange handler failed`, error);
        }
    }

    /**
     * Performs the real LLM simulation call through `generateRaw`.
     * Never throws. The card is loaded lazily and cached.
     * @param {import('./status-manager.js').WSEState} state
     * @returns {Promise<{ ok: boolean, text?: string, error?: string, promptChars?: number, hasCardDescription?: boolean, skipped?: boolean }>}
     */
    async runAiSimulation(state) {
        if (!this.ai) {
            this.log('AI simulation disabled (engine.ai === false)');
            return { ok: false, skipped: true, error: 'ai disabled' };
        }

        const card = await loadCharacterCard();
        const { prompt, systemPrompt, hasCardDescription, characterName } = buildSimulationPrompt(state, card);

        this.log(`calling generateRaw() for the simulation step (card="${characterName}", cardDescription=${hasCardDescription})`);

        try {
            const text = await generateRaw({
                prompt,
                systemPrompt,
                responseLength: AI_RESPONSE_LENGTH,
            });

            const normalised = typeof text === 'string' ? text.trim() : String(text ?? '');
            this.log('generateRaw() returned', JSON.stringify(normalised.slice(0, 200)));

            return {
                ok: true,
                text: normalised,
                promptChars: prompt.length,
                hasCardDescription,
            };
        } catch (error) {
            const message = error?.message ?? String(error);
            console.warn(`${LOG_PREFIX} [engine] generateRaw() failed during simulation: ${message}`);
            return { ok: false, error: message };
        }
    }

    /**
     * Runs one real simulation step.
     *
     * `message_sent` and `manual` (settings-panel button) run the LLM call,
     * parse the JSON answer and merge `newState.characters` / `events` / `clues`
     * into `wse_data` through `processDelta()`. Other reasons are logged no-ops.
     *
     * @param {'message_sent' | 'manual' | string} reason
     * @returns {Promise<object>} Simulation event (JSON-serialisable).
     */
    async triggerSimulation(reason) {
        if (this.isSimulating) {
            this.log(`triggerSimulation("${reason}") ignored: isSimulating is true (recursion guard)`);
            return {
                type: 'WSE_SIMULATION',
                version: WSE_EVENT_VERSION,
                reason,
                at: new Date().toISOString(),
                skipped: true,
                mock: false,
                note: 'recursion guard: a simulation is already running',
            };
        }

        this.isSimulating = true;

        try {
            const state = this.statusManager.load();
            this.log(`triggerSimulation("${reason}") chat="${state.chatId ?? 'null'}" messageCount=${state.messageCount}`);

            /** @type {object} */
            let event;

            if (!SIMULATION_REASONS.has(reason)) {
                event = {
                    type: 'WSE_SIMULATION',
                    version: WSE_EVENT_VERSION,
                    reason,
                    chatId: state.chatId,
                    at: new Date().toISOString(),
                    messageCount: state.messageCount,
                    ai: { ok: false, skipped: true, error: 'no simulation for this reason' },
                    parsed: null,
                    parseError: null,
                    applied: null,
                    mock: false,
                    note: 'no state transition for this reason',
                };
                this.log(`no-op reason "${reason}" (no AI call)`);
                this.lastEvent = event;
                return event;
            }

            // Bookkeeping: count observed user messages (shown in the settings panel).
            const next = this.statusManager.save({ messageCount: (state.messageCount ?? 0) + 1 });
            this.log(`messageCount ${state.messageCount ?? 0} -> ${next.messageCount}`);

            const ai = await this.runAiSimulation(next);

            let parsed = null;
            let parseError = null;
            let applied = next;

            if (ai.ok) {
                const parsedResponse = parseSimulationResponse(ai.text);
                if (parsedResponse.ok) {
                    const result = normaliseSimulationResult(parsedResponse.data);
                    parsed = {
                        events: result.events,
                        characters: result.characters,
                        clues: result.clues,
                        newState: result.newState,
                    };
                    this.log(
                        `parsed simulation result: events=${result.events.length} characters=${Object.keys(result.characters).length} clues=${result.clues.length}`,
                    );

                    const delta = buildStateDelta(next, result);
                    if (Object.keys(delta).length > 0) {
                        applied = this.processDelta(delta);
                    } else {
                        this.log('simulation produced no state changes');
                        this.notifyChange(next);
                    }
                } else {
                    parseError = parsedResponse.error;
                    console.warn(`${LOG_PREFIX} [engine] invalid simulation JSON — state unchanged: ${parseError}`);
                    this.notifyChange(next);
                }
            } else {
                this.notifyChange(next);
            }

            event = {
                type: 'WSE_SIMULATION',
                version: WSE_EVENT_VERSION,
                reason,
                chatId: applied.chatId ?? next.chatId,
                at: new Date().toISOString(),
                messageCount: applied.messageCount ?? next.messageCount,
                ai: { ok: ai.ok, error: ai.error ?? null, chars: ai.text ? ai.text.length : 0, hasCardDescription: ai.hasCardDescription ?? false },
                parsed,
                parseError,
                applied: {
                    characters: Object.keys(applied.characters ?? {}).length,
                    events: (applied.events ?? []).length,
                    discoverableClues: (applied.discoverableClues ?? []).length,
                },
                mock: false,
            };

            this.lastEvent = event;
            this.log('simulation event', JSON.stringify(event));
            return event;
        } finally {
            this.isSimulating = false;
        }
    }

    /**
     * Resets `wse_data` for the current chat back to a fresh state.
     * Backs the "Reset Simulation State" settings-panel button.
     * @returns {import('./status-manager.js').WSEState} The new state.
     */
    resetState() {
        const current = this.statusManager.load();
        const fresh = {
            ...createDefaultState(),
            chatId: current.chatId ?? null,
            createdAt: new Date().toISOString(),
        };

        const saved = this.statusManager.save(fresh);
        this.log('resetState()', JSON.stringify(saved));
        this.notifyChange(saved);
        return saved;
    }

    /**
     * Applies an external JSON delta to `wse_data` and persists it.
     *
     * Accepts a plain object or a JSON string. Merging is deep for objects and
     * replaces arrays/primitives. Keys outside the `wse_data` schema are dropped
     * by the status manager's normaliser and reported as a warning.
     *
     * @param {object | string} jsonDelta
     * @returns {import('./status-manager.js').WSEState}
     */
    processDelta(jsonDelta) {
        const delta = WSEEngine.parseDelta(jsonDelta);
        const current = this.statusManager.load();
        const merged = deepMerge(current, delta);
        const saved = this.statusManager.save(merged);

        const dropped = Object.keys(merged).filter(key => !(key in saved));
        if (dropped.length > 0) {
            console.warn(`${LOG_PREFIX} [engine] processDelta: ignored keys not present in the wse_data schema: ${dropped.join(', ')}`);
        }

        this.log('processDelta applied', JSON.stringify(saved));
        this.notifyChange(saved);
        return saved;
    }

    /**
     * Normalises the delta input to a plain object.
     * @param {object | string} jsonDelta
     * @returns {Record<string, unknown>}
     */
    static parseDelta(jsonDelta) {
        if (typeof jsonDelta === 'string') {
            let parsed;
            try {
                parsed = JSON.parse(jsonDelta);
            } catch (error) {
                throw new Error(`${LOG_PREFIX} processDelta received invalid JSON: ${error.message}`);
            }
            return WSEEngine.parseDelta(parsed);
        }

        if (!isPlainObject(jsonDelta)) {
            throw new Error(`${LOG_PREFIX} processDelta expects a plain object or a JSON string`);
        }

        return jsonDelta;
    }
}
