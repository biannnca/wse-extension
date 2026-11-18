/**
 * WSE self-test (Node only — SillyTavern never loads this file).
 *
 * Two things are stubbed:
 *   1. `globalThis.SillyTavern.getContext()` — fake event source, chat metadata,
 *      save helper and `setExtensionPrompt`;
 *   2. the `/script.js` module (`../../../../script.js`) — mapped by a Node
 *      resolve hook to `test/script-stub.js`, which provides `is_send_press` and
 *      `generateRaw`.
 *
 * Coverage: Phase 1 (event hooks, metadata read/write, idempotency), Phase 2
 * (prompt injection, `processDelta` merging/tolerance/pollution guard) and the
 * final refinement (no `is_send_press` guard, AI call through `generateRaw`,
 * single-flight coalescing, AI failure containment).
 *
 * Run: node selftest.mjs   (cwd: this folder)
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { __stub, __setIsSendPress } from './test/script-stub.js';

// ---------------------------------------------------------------------------
// Map the browser-only `/script.js` specifier to the local stub
// ---------------------------------------------------------------------------
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === '../../../../script.js') {
            return {
                url: new URL('./test/script-stub.js', import.meta.url).href,
                shortCircuit: true,
            };
        }
        return nextResolve(specifier, context);
    },
});

// ---------------------------------------------------------------------------
// Fake SillyTavern context
// ---------------------------------------------------------------------------
const eventTypes = {
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SENT: 'message_sent',
};

const listeners = new Map();

const eventSource = {
    on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return eventSource;
    },
    async emit(event, ...args) {
        for (const handler of listeners.get(event) ?? []) {
            await handler(...args);
        }
    },
};

const chatMetadata = {};
/** Captured setExtensionPrompt() calls, newest last. */
const promptCalls = [];

function setExtensionPrompt(key, value, position, depth) {
    promptCalls.push({ key, value, position, depth });
}

let saveMetadataDebouncedCalls = 0;

/** Extension settings object (Enable/Disable checkbox storage). */
const extensionSettings = {};
let saveSettingsCalls = 0;

const context = {
    chatId: 'selftest-chat',
    chatMetadata,
    eventSource,
    eventTypes,
    extensionSettings,
    setExtensionPrompt,
    saveMetadataDebounced() {
        saveMetadataDebouncedCalls += 1;
    },
    saveSettingsDebounced() {
        saveSettingsCalls += 1;
    },
    async saveMetadata() {
        saveMetadataDebouncedCalls += 1;
    },
};

globalThis.SillyTavern = {
    libs: {},
    getContext: () => context,
};

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------
const captured = [];
const originalLog = console.log;
const originalWarn = console.warn;
console.log = (...args) => {
    captured.push(args.map(String).join(' '));
    originalLog(...args);
};
console.warn = (...args) => {
    captured.push('WARN ' + args.map(String).join(' '));
    originalWarn(...args);
};

const results = [];
function check(name, fn) {
    try {
        fn();
        results.push({ name, ok: true });
    } catch (error) {
        results.push({ name, ok: false, error: error.message });
    }
}

const lastPrompt = () => promptCalls[promptCalls.length - 1];
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Import the real extension (registration runs at module load)
// ---------------------------------------------------------------------------
const mod = await import('./index.js');

// --- Phase 1: registration -------------------------------------------------
check('index.js exposes registerExtension()', () => {
    assert.equal(typeof mod.registerExtension, 'function');
});

check('CHAT_CHANGED is hooked', () => {
    assert.ok((listeners.get(eventTypes.CHAT_CHANGED) ?? []).length >= 1);
});

check('MESSAGE_SENT is hooked', () => {
    assert.ok((listeners.get(eventTypes.MESSAGE_SENT) ?? []).length >= 1);
});

check('logs "WSE: Hooked event chat_id_changed"', () => {
    assert.ok(captured.some(line => line.includes('WSE: Hooked event chat_id_changed')));
});

check('logs "WSE: Hooked event message_sent"', () => {
    assert.ok(captured.some(line => line.includes('WSE: Hooked event message_sent')));
});

check('initial wse_data written on registration', () => {
    const data = chatMetadata.wse_data;
    assert.ok(data && typeof data === 'object', 'wse_data missing');
    assert.equal(data.version, 1);
    assert.equal(data.chatId, 'selftest-chat');
    assert.equal(typeof data.createdAt, 'string');
    assert.equal(data.messageCount, 0);
});

// --- Phase 2: prompt injection on registration -----------------------------
check('prompt injected on registration', () => {
    assert.ok(promptCalls.length >= 1, 'setExtensionPrompt was never called');
    const call = lastPrompt();
    assert.equal(call.key, 'wse-system-context');
    assert.equal(call.position, 0);
    assert.equal(call.depth, 0);
    assert.ok(call.value.startsWith('Lin Qian current state:'), call.value);
    assert.ok(call.value.includes('user messages observed: 0'), call.value);
});

const engine = mod.getEngine();
const engineModule = await import('./simulation-engine.js');

/** Default (valid) AI answer, captured before any test mutates the stub. */
const DEFAULT_AI_TEXT = __stub.text;

// --- Refinement: no is_send_press guard -----------------------------------
__setIsSendPress(true);
const callsBeforeFirstSim = __stub.calls.length;
await eventSource.emit(eventTypes.MESSAGE_SENT, 0);
await tick(5);

check('MESSAGE_SENT triggers the simulation even when is_send_press is true', () => {
    assert.equal(chatMetadata.wse_data.messageCount, 1);
    assert.equal(__stub.calls.length, callsBeforeFirstSim + 1);
});

check('the old skip log is gone', () => {
    assert.equal(
        captured.some(line => line.includes('Skipping simulation due to active generation')),
        false,
    );
});

check('is_send_press is logged for diagnostics only', () => {
    assert.ok(captured.some(line => line.includes('is_send_press=true')));
});

// --- Production mode: AI call goes through generateRaw --------------------
check('triggerSimulation calls generateRaw()', () => {
    assert.equal(__stub.calls.length, callsBeforeFirstSim + 1);
    const params = __stub.calls[0];
    assert.equal(typeof params.prompt, 'string');
    assert.ok(params.prompt.includes('# Character card'), params.prompt.slice(0, 120));
    assert.ok(params.prompt.includes('Current state (wse_data JSON)'), 'prompt must embed the state JSON');
    assert.equal(typeof params.systemPrompt, 'string');
    assert.ok(params.systemPrompt.includes('World Simulation Engine'), params.systemPrompt.slice(0, 120));
    assert.ok(params.systemPrompt.includes('newState'), 'system prompt must declare the output schema');
    assert.equal(params.responseLength, 1024);
});

check('valid JSON is parsed and merged into wse_data', () => {
    const event = engine.lastEvent;
    assert.equal(event.type, 'WSE_SIMULATION');
    assert.equal(event.reason, 'message_sent');
    assert.equal(event.mock, false);
    assert.equal(event.ai.ok, true);
    assert.equal(event.parseError, null);
    assert.equal(event.parsed.events.length, 1);
    assert.equal(event.parsed.clues.length, 1);
    assert.equal(chatMetadata.wse_data.characters['林茜'].affection, 5);
    assert.equal(chatMetadata.wse_data.characters['林茜'].corruption, 2);
    assert.equal(chatMetadata.wse_data.characters['林茜'].trust, 1);
    assert.equal(chatMetadata.wse_data.events.length, 1);
    assert.equal(chatMetadata.wse_data.events[0].summary, 'stub simulation event');
    assert.equal(chatMetadata.wse_data.discoverableClues.length, 1);
    assert.equal(chatMetadata.wse_data.discoverableClues[0].id, 'stub-clue');
    assert.equal(event.applied.characters, 1);
});

check('prompt builder embeds the character card description', () => {
    const card = { spec: 'chara_card_v3', data: { name: '林茜', description: '林茜，30岁，已婚女性，是{{user}}的妻子。' } };
    const built = engineModule.buildSimulationPrompt({ chatId: 'c1', messageCount: 4 }, card);
    assert.ok(built.hasCardDescription);
    assert.ok(built.prompt.includes('已婚女性'), built.prompt);
    assert.ok(built.prompt.includes('"messageCount": 4'), built.prompt);
    assert.ok(built.systemPrompt.includes('You are the World Simulation Engine'));
});

check('prompt builder degrades without a card', () => {
    const built = engineModule.buildSimulationPrompt({ chatId: 'c1', messageCount: 0 }, null);
    assert.equal(built.hasCardDescription, false);
    assert.ok(built.prompt.includes('(character card description unavailable)'));
});

check('parseSimulationResponse accepts fenced JSON', () => {
    const parsed = engineModule.parseSimulationResponse('```json\n{"events":[],"newState":{},"clues":[]}\n```');
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data.events, []);
});

check('parseSimulationResponse rejects prose and empty answers', () => {
    assert.equal(engineModule.parseSimulationResponse('sorry, no json here').ok, false);
    assert.match(engineModule.parseSimulationResponse('sorry, no json here').error, /no JSON object/);
    assert.equal(engineModule.parseSimulationResponse('').ok, false);
    assert.equal(engineModule.parseSimulationResponse(null).ok, false);
});

check('parseSimulationResponse rejects malformed JSON', () => {
    const parsed = engineModule.parseSimulationResponse('{"events": [}');
    assert.equal(parsed.ok, false);
    assert.equal(typeof parsed.error, 'string');
});

check('prompt re-injected after the state update', () => {
    const call = lastPrompt();
    assert.equal(call.key, 'wse-system-context');
    assert.ok(call.value.includes('user messages observed: 1'), call.value);
});

// --- Idle message (is_send_press false) still simulates --------------------
__setIsSendPress(false);
await eventSource.emit(eventTypes.MESSAGE_SENT, 1);
await tick(5);

check('idle MESSAGE_SENT increments messageCount', () => {
    assert.equal(chatMetadata.wse_data.messageCount, 2);
});

check('second simulation event has messageCount 2', () => {
    assert.equal(engine.lastEvent.messageCount, 2);
});

// --- Robustness: AI failure must not throw or block state update ----------
__stub.mode = 'error';
const failedEvent = await engine.triggerSimulation('message_sent');

check('AI failure is contained in the event', () => {
    assert.equal(failedEvent.ai.ok, false);
    assert.equal(failedEvent.ai.error, __stub.errorMessage);
    assert.equal(chatMetadata.wse_data.messageCount, 3);
    assert.ok(captured.some(line => line.includes('generateRaw() failed during simulation')));
});
__stub.mode = 'ok';

// --- Robustness: invalid JSON leaves the simulation state untouched -------
__stub.text = 'I am afraid I cannot answer that in JSON.';
const eventsBeforeInvalid = chatMetadata.wse_data.events.length;
const cluesBeforeInvalid = chatMetadata.wse_data.discoverableClues.length;
const countBeforeInvalid = chatMetadata.wse_data.messageCount;
const invalidEvent = await engine.triggerSimulation('message_sent');

check('invalid JSON does not change simulation state', () => {
    assert.equal(invalidEvent.ai.ok, true);
    assert.equal(typeof invalidEvent.parseError, 'string');
    assert.equal(invalidEvent.parsed, null);
    assert.equal(chatMetadata.wse_data.events.length, eventsBeforeInvalid);
    assert.equal(chatMetadata.wse_data.discoverableClues.length, cluesBeforeInvalid);
    assert.equal(chatMetadata.wse_data.messageCount, countBeforeInvalid + 1, 'bookkeeping counter still advances');
    assert.ok(captured.some(line => line.includes('invalid simulation JSON')));
});
__stub.text = DEFAULT_AI_TEXT;

// --- Robustness: single-flight coalescing ---------------------------------
__stub.mode = 'slow';
const callsBeforeSlow = __stub.calls.length;
const firstSim = engine.triggerSimulation('message_sent');
await tick(0);
const countDuringSlow = chatMetadata.wse_data.messageCount;

const coalesced = await engine.triggerSimulation('message_sent');

check('overlapping simulation is coalesced, not stacked', () => {
    assert.equal(coalesced.skipped, true);
    assert.ok(coalesced.note.includes('recursion guard'), coalesced.note);
    assert.equal(__stub.calls.length, callsBeforeSlow + 1, 'only one AI call should be in flight');
    assert.equal(chatMetadata.wse_data.messageCount, countDuringSlow, 'skipped run must not bump the counter');
});

__stub.pending.forEach(resolve => resolve(DEFAULT_AI_TEXT));
const slowEvent = await firstSim;
check('in-flight simulation completes normally', () => {
    assert.equal(slowEvent.ai.ok, true);
    assert.equal(slowEvent.skipped, undefined);
    assert.equal(engine.isSimulating, false, 'guard must be released');
});
__stub.mode = 'ok';

// --- Unknown reason --------------------------------------------------------
const beforeUnknown = chatMetadata.wse_data.messageCount;
const callsBeforeUnknown = __stub.calls.length;
const unknownEvent = await engine.triggerSimulation('manual_debug');
check('unknown reason does not change state or call the AI', () => {
    assert.equal(chatMetadata.wse_data.messageCount, beforeUnknown);
    assert.equal(__stub.calls.length, callsBeforeUnknown, 'no AI call for unsupported reasons');
    assert.equal(unknownEvent.parsed, null);
    assert.equal(unknownEvent.note, 'no state transition for this reason');
    assert.equal(unknownEvent.ai.skipped, true);
});

// --- Phase 2: processDelta -------------------------------------------------
const savedAfterDelta = engine.processDelta({ messageCount: 5, flags: { weather: 'rain' } });

check('processDelta merges and saves the delta', () => {
    assert.equal(savedAfterDelta.messageCount, 5);
    assert.deepEqual(savedAfterDelta.flags, { weather: 'rain' });
    assert.equal(chatMetadata.wse_data.messageCount, 5);
});

check('processDelta re-injects the prompt', () => {
    const call = lastPrompt();
    assert.ok(call.value.includes('user messages observed: 5'), call.value);
    assert.ok(call.value.includes('"weather":"rain"'), call.value);
});

check('processDelta accepts a JSON string', () => {
    assert.equal(engine.processDelta('{"messageCount":7}').messageCount, 7);
});

check('processDelta deep-merges nested flags', () => {
    engine.processDelta({ flags: { mood: 'tense' } });
    assert.deepEqual(chatMetadata.wse_data.flags, { weather: 'rain', mood: 'tense' });
});

check('processDelta rejects invalid JSON', () => {
    assert.throws(() => engine.processDelta('{not json'), /invalid JSON/);
});

check('processDelta rejects non-objects', () => {
    assert.throws(() => engine.processDelta(null), /plain object/);
    assert.throws(() => engine.processDelta([1, 2, 3]), /plain object/);
});

check('processDelta blocks prototype pollution', () => {
    engine.processDelta(JSON.parse('{"__proto__":{"polluted":true}}'));
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
    assert.equal(chatMetadata.wse_data.polluted, undefined);
});

check('processDelta reports keys outside the wse_data schema', () => {
    engine.processDelta({ notAField: 'x' });
    assert.equal('notAField' in chatMetadata.wse_data, false);
    assert.ok(captured.some(line => line.includes('ignored keys not present in the wse_data schema')));
});

// --- Phase 3: settings panel (DOM-free behaviour) -------------------------
check('mountSettingsUi() is exported', () => {
    assert.equal(typeof mod.mountSettingsUi, 'function');
});

const mounted = await mod.mountSettingsUi();
check('mountSettingsUi() is a safe no-op without DOM', () => {
    assert.equal(mounted, false);
    assert.ok(captured.some(line => line.includes('UI mount skipped (no DOM)')));
});

check('refreshSettingsUi() returns null without DOM', () => {
    assert.equal(mod.refreshSettingsUi(), null);
});

check('buildStatusViewModel maps state to status fields', () => {
    const view = mod.buildStatusViewModel({
        chatId: 'chat-42',
        messageCount: 9,
        updatedAt: '2026-11-18T00:00:00.000Z',
        flags: { affection: 42, corruption: 7, trust: 3 },
    });
    assert.equal(view.chatId, 'chat-42');
    assert.equal(view.messageCount, 9);
    assert.equal(view.affection, 42);
    assert.equal(view.corruption, 7);
    assert.equal(view.trust, 3);
    assert.equal(view.enabled, true);
    assert.equal(view.flags, '{"affection":42,"corruption":7,"trust":3}');
});

check('buildStatusViewModel defaults missing fields', () => {
    const view = mod.buildStatusViewModel({});
    assert.equal(view.chatId, 'none');
    assert.equal(view.messageCount, 0);
    assert.equal(view.affection, 0);
    assert.equal(view.corruption, 0);
    assert.equal(view.trust, 0);
    assert.equal(view.updatedAt, 'never');
    assert.equal(view.flags, '{}');
});

check('WSE defaults to enabled', () => {
    assert.equal(mod.isWseEnabled(), true);
});

const saveSettingsBeforeDisable = saveSettingsCalls;
mod.setWseEnabled(false);

check('disable persists to extensionSettings.wse.enabled', () => {
    assert.equal(extensionSettings.wse.enabled, false);
    assert.equal(mod.isWseEnabled(), false);
    assert.ok(saveSettingsCalls > saveSettingsBeforeDisable);
});

check('disable clears the injected prompt', () => {
    assert.equal(lastPrompt().key, 'wse-system-context');
    assert.equal(lastPrompt().value, '');
});

const countBeforeDisabled = chatMetadata.wse_data.messageCount;
const aiCallsBeforeDisabled = __stub.calls.length;
await eventSource.emit(eventTypes.MESSAGE_SENT, 9);
await tick(5);

check('disabled MESSAGE_SENT does not simulate', () => {
    assert.equal(chatMetadata.wse_data.messageCount, countBeforeDisabled);
    assert.equal(__stub.calls.length, aiCallsBeforeDisabled);
    assert.ok(captured.some(line => line.includes('WSE disabled — skipping simulation')));
});

const manualWhileDisabled = await mod.runManualSimulation();
check('manual simulation is ignored while disabled', () => {
    assert.equal(manualWhileDisabled, null);
});

mod.setWseEnabled(true);
check('enable persists and re-injects the prompt', () => {
    assert.equal(extensionSettings.wse.enabled, true);
    assert.equal(mod.isWseEnabled(), true);
    assert.ok(lastPrompt().value.includes('Lin Qian current state:'), lastPrompt().value);
});

const countBeforeManual = chatMetadata.wse_data.messageCount;
const manualEvent = await mod.runManualSimulation();
check('manual simulation runs the engine step', () => {
    assert.equal(manualEvent.reason, 'manual');
    assert.equal(manualEvent.mock, false);
    assert.equal(manualEvent.messageCount, countBeforeManual + 1);
    assert.equal(chatMetadata.wse_data.messageCount, countBeforeManual + 1);
    assert.equal(manualEvent.ai.ok, true);
    assert.equal(manualEvent.parseError, null);
    assert.equal(manualEvent.parsed.events.length, 1);
});

const callsBeforeManual = __stub.calls.length;
check('manual simulation used generateRaw()', () => {
    assert.equal(__stub.calls.length, callsBeforeManual);
    assert.ok(__stub.calls[callsBeforeManual - 1].prompt.includes('# Latest turn'));
});

const resetResult = mod.resetSimulationState();
check('reset clears the simulation state', () => {
    assert.equal(resetResult.messageCount, 0);
    assert.equal(resetResult.lastMessageId, null);
    assert.equal(chatMetadata.wse_data.messageCount, 0);
    assert.equal(typeof resetResult.createdAt, 'string');
});

check('reset re-injects the prompt', () => {
    assert.ok(lastPrompt().value.includes('user messages observed: 0'), lastPrompt().value);
});

// --- CHAT_CHANGED always re-injects ---------------------------------------
const injectionsBeforeChatChanged = promptCalls.length;
await eventSource.emit(eventTypes.CHAT_CHANGED, 'second-chat');
check('CHAT_CHANGED re-injects the prompt', () => {
    assert.ok(promptCalls.length > injectionsBeforeChatChanged);
    assert.equal(lastPrompt().key, 'wse-system-context');
});

// --- Payload tolerance ----------------------------------------------------
const manager = mod.getStatusManager();

chatMetadata.wse_data = { messageCount: 7, flags: null, unknownField: 'x' };
const legacyState = manager.load();
check('legacy payload is normalised, not rejected', () => {
    assert.equal(legacyState.messageCount, 7);
    assert.deepEqual(legacyState.flags, {});
    assert.equal(legacyState.version, 1);
});

chatMetadata.wse_data = 'not-an-object';
check('load() tolerates a non-object payload', () => {
    assert.equal(manager.load().messageCount, 0);
});

// Restore a clean payload for the final report.
manager.save({ messageCount: 3, flags: {} });

// --- Idempotent registration ---------------------------------------------
const hookCountBefore = (listeners.get(eventTypes.MESSAGE_SENT) ?? []).length;
check('registerExtension() is idempotent', () => {
    const before = captured.length;
    const second = mod.registerExtension();
    assert.equal(second, false);
    assert.equal((listeners.get(eventTypes.MESSAGE_SENT) ?? []).length, hookCountBefore);
    assert.ok(captured.slice(before).some(line => line.includes('WARN')));
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log = originalLog;
console.warn = originalWarn;

const failed = results.filter(r => !r.ok);
console.log('\n================ WSE selftest ================');
for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      → ${r.error}`}`);
}
console.log('---------------------------------------------');
console.log(`final chat_metadata.wse_data: ${JSON.stringify(chatMetadata.wse_data)}`);
console.log(`last injected prompt: ${JSON.stringify(lastPrompt())}`);
console.log(`generateRaw() calls: ${__stub.calls.length}`);
console.log(`setExtensionPrompt() calls: ${promptCalls.length}`);
console.log(`saveMetadataDebounced() calls: ${saveMetadataDebouncedCalls}`);
console.log(`${results.length - failed.length}/${results.length} checks passed`);

if (failed.length > 0) {
    process.exitCode = 1;
}
