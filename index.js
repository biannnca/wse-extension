/**
 * WSE - World Simulation Engine
 * Extension entry point — Phase 3 (settings panel).
 *
 * Registration notes
 * ------------------
 * 1. SillyTavern 1.19.0 has **no** `settingsPanel` API and no
 *    `registerExtension()` global (verified: zero `settingsPanel` matches in
 *    `public/**`; the only `registerExtension*` symbol is
 *    `registerExtensionSlashCommands`). The standard extension pattern is:
 *      - load the module as `<script type="module" src="/scripts/extensions/third-party/<name>/index.js">`
 *        (public/scripts/extensions.js:813-841);
 *      - render an HTML fragment with `context.renderExtensionTemplateAsync('third-party/<name>', 'settings')`
 *        (public/scripts/extensions.js:137-139 — resolves to
 *        `scripts/extensions/third-party/<name>/settings.html`) and append it to
 *        `#extensions_settings2` (the same approach as the installed
 *        `st-model-injector` extension).
 *    `mountSettingsUi()` below implements exactly that.
 *
 * 2. Imports: from `/scripts/extensions/third-party/wse-extension/index.js`,
 *    four levels up is the public root, so `../../../../script.js` is
 *    `/script.js`. `is_send_press` is imported for diagnostics only.
 *
 * Behaviour
 * ---------
 * - `MESSAGE_SENT` → simulation (skipped when WSE is disabled in the panel).
 * - `CHAT_CHANGED` → reload state, re-inject the system prompt, refresh the panel.
 * - `onChange` (wired to the engine) refreshes both the injected prompt and the
 *   settings panel after every state write.
 * - Panel controls: Enable/Disable, Trigger Manual Simulation, Reset Simulation State.
 */

import { is_send_press } from '../../../../script.js';
import { WSEStatusManager, WSE_METADATA_KEY } from './status-manager.js';
import { WSEEngine } from './simulation-engine.js';

/** Extension id, also used as the `extension_settings` key. */
export const MODULE_NAME = 'wse';

/** Folder name ST serves the extension from (`/scripts/extensions/<id>/`). */
export const WSE_EXTENSION_ID = 'wse-extension';

/** Prefix for every log line, so WSE output is greppable in the console. */
const LOG_PREFIX = 'WSE:';

/** Key of the injected system prompt (`extension_prompts` namespace). */
export const WSE_PROMPT_KEY = 'wse-system-context';

/** `extension_prompt_types.IN_PROMPT` (public/script.js:484-489). */
export const WSE_PROMPT_POSITION = 0;

/** Depth is only meaningful for IN_CHAT; 0 is passed to match the spec. */
export const WSE_PROMPT_DEPTH = 0;

/** Container ST exposes for third-party extension settings (public/index.html:5791). */
export const WSE_SETTINGS_CONTAINER = '#extensions_settings2';

/** @type {boolean} Guards against double registration (module reloads). */
let registered = false;

/** @type {boolean} Guards against mounting the settings panel twice. */
let uiMounted = false;

/** @type {WSEStatusManager | null} */
let statusManager = null;

/** @type {WSEEngine | null} */
let engine = null;

function log(...args) {
    console.log(LOG_PREFIX, ...args);
}

function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
}

/**
 * Returns the live SillyTavern context.
 * @returns {ReturnType<typeof window.SillyTavern.getContext>}
 */
function getSTContext() {
    if (!globalThis.SillyTavern || typeof globalThis.SillyTavern.getContext !== 'function') {
        throw new Error(`${LOG_PREFIX} SillyTavern.getContext() is unavailable`);
    }
    return globalThis.SillyTavern.getContext();
}

// ---------------------------------------------------------------------------
// Extension settings (Enable / Disable)
// ---------------------------------------------------------------------------

/**
 * Returns the mutable `extension_settings.wse` object, creating it on demand.
 * @returns {Record<string, unknown> | null}
 */
function getWseSettings() {
    try {
        const context = getSTContext();
        if (!context.extensionSettings || typeof context.extensionSettings !== 'object') {
            return null;
        }
        context.extensionSettings.wse ??= {};
        return context.extensionSettings.wse;
    } catch (error) {
        warn('extensionSettings unavailable', error);
        return null;
    }
}

/**
 * Whether WSE is enabled. Defaults to `true` when the setting was never written.
 * @returns {boolean}
 */
export function isWseEnabled() {
    const settings = getWseSettings();
    return settings ? settings.enabled !== false : true;
}

/**
 * Enables/disables WSE, persists the setting and reflects it in the prompt.
 * Disabling clears the injected prompt immediately; enabling re-injects it.
 * @param {boolean} enabled
 * @returns {boolean} The stored value.
 */
export function setWseEnabled(enabled) {
    const value = Boolean(enabled);
    const settings = getWseSettings();

    if (settings) {
        settings.enabled = value;
        try {
            getSTContext().saveSettingsDebounced();
        } catch (error) {
            warn('saveSettingsDebounced() failed', error);
        }
    }

    log(`setWseEnabled(${value})`);

    if (value) {
        updateWSEPrompt();
    } else {
        clearWSEPrompt();
    }

    refreshSettingsUi();
    return value;
}

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------

/**
 * Builds the WSE system prompt from the current state.
 * @param {import('./status-manager.js').WSEState} [wseData]
 * @returns {string}
 */
export function buildWSEPrompt(wseData) {
    const data = wseData ?? {};
    const flags = data.flags && Object.keys(data.flags).length > 0 ? JSON.stringify(data.flags) : 'none';

    return [
        'Lin Qian current state:',
        `- chat id: ${data.chatId ?? 'none'}`,
        `- user messages observed: ${data.messageCount ?? 0}`,
        `- last state update: ${data.updatedAt ?? 'never'}`,
        `- flags: ${flags}`,
    ].join('\n');
}

/**
 * Injects (or refreshes) the WSE system prompt.
 * @param {import('./status-manager.js').WSEState} [wseData] State to render; defaults to the manager's current state.
 * @returns {string | null} The injected text, or `null` when injection is impossible.
 */
export function updateWSEPrompt(wseData) {
    try {
        const context = getSTContext();

        if (typeof context.setExtensionPrompt !== 'function') {
            warn(`setExtensionPrompt() is unavailable — cannot inject "${WSE_PROMPT_KEY}"`);
            return null;
        }

        const data = wseData ?? statusManager?.load();
        const prompt = buildWSEPrompt(data);

        context.setExtensionPrompt(WSE_PROMPT_KEY, prompt, WSE_PROMPT_POSITION, WSE_PROMPT_DEPTH);

        log(`updateWSEPrompt → injected "${WSE_PROMPT_KEY}" (${prompt.length} chars, position=${WSE_PROMPT_POSITION}, depth=${WSE_PROMPT_DEPTH})`);

        return prompt;
    } catch (error) {
        console.error(`${LOG_PREFIX} updateWSEPrompt failed`, error);
        return null;
    }
}

/**
 * Clears the injected prompt without removing the key from `extension_prompts`
 * (mirrors how core unsets an injection).
 * @returns {boolean}
 */
export function clearWSEPrompt() {
    try {
        const context = getSTContext();
        if (typeof context.setExtensionPrompt !== 'function') {
            return false;
        }
        context.setExtensionPrompt(WSE_PROMPT_KEY, '', WSE_PROMPT_POSITION, WSE_PROMPT_DEPTH);
        log(`cleared injected prompt "${WSE_PROMPT_KEY}"`);
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX} clearWSEPrompt failed`, error);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Settings panel: view model + actions (DOM free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Maps `wse_data` to the values shown in the "Current World Status" block.
 * `affection` / `corruption` / `trust` live in `flags` until the Phase-4 schema
 * adds them as first-class fields.
 * @param {import('./status-manager.js').WSEState} [state]
 * @returns {{ enabled: boolean, chatId: string, messageCount: number, updatedAt: string, affection: number, corruption: number, trust: number, flags: string }}
 */
export function buildStatusViewModel(state) {
    const data = state ?? {};
    const flags = data.flags && typeof data.flags === 'object' ? data.flags : {};

    return {
        enabled: isWseEnabled(),
        chatId: String(data.chatId ?? 'none'),
        messageCount: Number.isFinite(data.messageCount) ? Number(data.messageCount) : 0,
        updatedAt: String(data.updatedAt ?? 'never'),
        affection: Number.isFinite(flags.affection) ? Number(flags.affection) : 0,
        corruption: Number.isFinite(flags.corruption) ? Number(flags.corruption) : 0,
        trust: Number.isFinite(flags.trust) ? Number(flags.trust) : 0,
        flags: JSON.stringify(flags),
    };
}

/**
 * Backs the "Trigger Manual Simulation" button.
 * @returns {Promise<object | null>} Simulation event, or `null` when disabled.
 */
export async function runManualSimulation() {
    if (!isWseEnabled()) {
        log('WSE disabled — manual simulation ignored');
        return null;
    }
    if (!engine) {
        warn('manual simulation requested before registration');
        return null;
    }

    const simulationEvent = await engine.triggerSimulation('manual');
    log('manual simulation event', JSON.stringify(simulationEvent));
    return simulationEvent;
}

/**
 * Backs the "Reset Simulation State" button.
 * @returns {import('./status-manager.js').WSEState | null}
 */
export function resetSimulationState() {
    if (!engine) {
        warn('reset requested before registration');
        return null;
    }
    const state = engine.resetState();
    log('reset simulation state', JSON.stringify(state));
    return state;
}

// ---------------------------------------------------------------------------
// Settings panel: DOM wiring
// ---------------------------------------------------------------------------

/** @param {string} id @param {string} text */
function setText(id, text) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = text;
    }
}

/** @param {string} message */
function setFeedback(message) {
    const element = document.getElementById('wse_ui_feedback');
    if (element) {
        element.textContent = message;
    }
}

/**
 * Re-renders the settings panel from the current state.
 * Safe to call before the panel exists (no-op) and outside the browser (returns null).
 * @param {import('./status-manager.js').WSEState} [state]
 * @returns {ReturnType<typeof buildStatusViewModel> | null}
 */
export function refreshSettingsUi(state) {
    if (typeof document === 'undefined') {
        return null;
    }

    let data = state;
    if (!data) {
        try {
            data = statusManager?.load();
        } catch {
            data = undefined;
        }
    }

    const view = buildStatusViewModel(data);

    setText('wse_status_affection', String(view.affection));
    setText('wse_status_corruption', String(view.corruption));
    setText('wse_status_trust', String(view.trust));
    setText('wse_status_messages', String(view.messageCount));
    setText('wse_status_chat', view.chatId);
    setText('wse_status_updated', view.updatedAt);
    setText('wse_status_flags', view.flags);

    const enabledCheckbox = document.getElementById('wse_enabled');
    if (enabledCheckbox instanceof HTMLInputElement) {
        enabledCheckbox.checked = view.enabled;
    }

    return view;
}

/**
 * Binds the settings-panel controls. Idempotent.
 */
function bindSettingsUi() {
    const enabledCheckbox = document.getElementById('wse_enabled');
    if (enabledCheckbox instanceof HTMLInputElement) {
        enabledCheckbox.checked = isWseEnabled();
        enabledCheckbox.addEventListener('change', () => {
            setWseEnabled(enabledCheckbox.checked);
            setFeedback(enabledCheckbox.checked ? 'WSE enabled' : 'WSE disabled');
        });
    }

    const triggerButton = document.getElementById('wse_trigger_manual');
    if (triggerButton) {
        triggerButton.addEventListener('click', async () => {
            setFeedback('Running manual simulation…');
            try {
                const event = await runManualSimulation();
                setFeedback(
                    event
                        ? `Manual simulation done: messageCount=${event.messageCount ?? '?'}, AI ${event.ai?.ok ? 'ok' : 'failed'}`
                        : 'WSE is disabled — enable it first',
                );
            } catch (error) {
                setFeedback(`Manual simulation failed: ${error?.message ?? error}`);
            }
            refreshSettingsUi();
        });
    }

    const resetButton = document.getElementById('wse_reset');
    if (resetButton) {
        resetButton.addEventListener('click', () => {
            try {
                resetSimulationState();
                setFeedback('Simulation state reset');
            } catch (error) {
                setFeedback(`Reset failed: ${error?.message ?? error}`);
            }
            refreshSettingsUi();
        });
    }
}

/**
 * 手动从插件目录获取模板并渲染 (避开 ST 的内部模板限制)
 */
export async function mountSettingsUi() {
    if (typeof document === 'undefined') {
        log('UI mount skipped (no DOM)');
        return false;
    }

    if (uiMounted || document.getElementById('wse_settings')) {
        uiMounted = true;
        bindSettingsUi();
        refreshSettingsUi();
        return true;
    }

    try {
        // 使用 import.meta.url 获取当前脚本所在的绝对路径，自动拼出 settings.html 的地址
        const baseUrl = new URL('./', import.meta.url).href;
        const response = await fetch(`${baseUrl}settings.html`);
        
        if (!response.ok) throw new Error(`Fetch settings.html failed: ${response.status}`);
        
        const html = await response.text();
        const container = document.querySelector(WSE_SETTINGS_CONTAINER) ?? document.body;
        container.insertAdjacentHTML('beforeend', html);

        bindSettingsUi();
        refreshSettingsUi();
        uiMounted = true;
        log('Settings panel manually mounted');
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX} mountSettingsUi failed:`, error);
        return false;
    }
}

/**
 * Defers mounting until the DOM is ready, so `#extensions_settings2` exists.
 */
function scheduleUiMount() {
    if (typeof document === 'undefined') {
        log('UI mount skipped (no DOM)');
        return;
    }

    const mount = () => {
        mountSettingsUi().catch(error => {
            console.error(`${LOG_PREFIX} settings panel mount failed`, error);
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }
}

// ---------------------------------------------------------------------------
// Registration + events
// ---------------------------------------------------------------------------

/**
 * WSE registration entry point. Safe to call more than once.
 * @returns {boolean} `true` when this call performed the registration.
 */
export function registerExtension() {
    if (registered) {
        console.warn(`${LOG_PREFIX} registerExtension() called again — ignoring`);
        return false;
    }

    const context = getSTContext();
    const { eventSource, eventTypes } = context;

    if (!eventSource || typeof eventSource.on !== 'function' || !eventTypes) {
        throw new Error(`${LOG_PREFIX} event system is unavailable (eventSource/eventTypes missing)`);
    }

    statusManager = new WSEStatusManager();

    // State writes refresh both the injected prompt and the settings panel.
    engine = new WSEEngine({
        statusManager,
        onChange: state => {
            updateWSEPrompt(state);
            refreshSettingsUi(state);
        },
    });

    // --- event hooks --------------------------------------------------------
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    log(`Hooked event ${eventTypes.CHAT_CHANGED}`);

    eventSource.on(eventTypes.MESSAGE_SENT, onMessageSent);
    log(`Hooked event ${eventTypes.MESSAGE_SENT}`);
    // -----------------------------------------------------------------------

    registered = true;
    log(`registered as "${MODULE_NAME}" (metadata key "${WSE_METADATA_KEY}", prompt key "${WSE_PROMPT_KEY}")`);

    exposeDebugHandle();
    scheduleUiMount();

    // Prime the state, the prompt and the panel for the chat already open.
    onChatChanged(context.chatId ?? null);

    return true;
}

/**
 * `CHAT_CHANGED` handler: load/initialise `wse_data`, inject the prompt and
 * refresh the panel. Wrapped so a WSE failure can never break chat switching.
 * @param {string | null} chatId Chat id passed by SillyTavern.
 */
function onChatChanged(chatId) {
    try {
        const eventName = getSTContext().eventTypes.CHAT_CHANGED;
        log(`event ${eventName} → chatId="${chatId ?? 'null'}"`);

        const state = statusManager.load();
        let current = state;

        if (!statusManager.hasStoredState) {
            current = statusManager.save({
                chatId: chatId ?? null,
                createdAt: new Date().toISOString(),
            });
            log(`initialised ${WSE_METADATA_KEY} for chat "${chatId ?? 'null'}"`, JSON.stringify(current));
        } else {
            log(`loaded ${WSE_METADATA_KEY}`, JSON.stringify(state));
        }

        updateWSEPrompt(current);
        refreshSettingsUi(current);
    } catch (error) {
        console.error(`${LOG_PREFIX} CHAT_CHANGED handler failed`, error);
    }
}

/**
 * `MESSAGE_SENT` handler: run one simulation step unless WSE is disabled.
 *
 * The returned promise is intentionally **not awaited**: SillyTavern awaits the
 * `MESSAGE_SENT` emit inside `sendMessageAsUser` (public/script.js:5910/5917),
 * which `Generate` awaits at :4453, so awaiting the AI simulation here would
 * delay the user's own generation by one full extra request.
 *
 * @param {number} messageId Index of the user message that was just sent.
 */
function onMessageSent(messageId) {
    try {
        const eventName = getSTContext().eventTypes.MESSAGE_SENT;
        log(`event ${eventName} → messageId=${messageId}`);
        log(`is_send_press=${String(is_send_press)} (informational only, not used as a guard)`);

        if (!isWseEnabled()) {
            log('WSE disabled — skipping simulation');
            return;
        }

        const pending = engine.triggerSimulation('message_sent');

        // Fire-and-forget with full error containment.
        Promise.resolve(pending)
            .then(simulationEvent => {
                log('simulation event', JSON.stringify(simulationEvent));
                refreshSettingsUi();
            })
            .catch(error => {
                console.error(`${LOG_PREFIX} simulation failed`, error);
            });
    } catch (error) {
        console.error(`${LOG_PREFIX} MESSAGE_SENT handler failed`, error);
    }
}

/**
 * Debug handle for the browser console: `WSE.triggerSimulation('message_sent')`,
 * `WSE.processDelta({ messageCount: 5 })`, `WSE.reset()`, `WSE.setEnabled(false)`.
 * Read-only façade — internals stay module-scoped.
 */
function exposeDebugHandle() {
    const handle = {
        get engine() {
            return engine;
        },
        get statusManager() {
            return statusManager;
        },
        load: () => statusManager.load(),
        triggerSimulation: reason => engine.triggerSimulation(reason),
        processDelta: delta => engine.processDelta(delta),
        reset: resetSimulationState,
        isEnabled: isWseEnabled,
        setEnabled: setWseEnabled,
        buildWSEPrompt,
        buildStatusViewModel,
        updateWSEPrompt,
        refreshSettingsUi,
        mountSettingsUi,
        registerExtension,
        promptKey: WSE_PROMPT_KEY,
        promptPosition: WSE_PROMPT_POSITION,
        promptDepth: WSE_PROMPT_DEPTH,
    };

    globalThis.WSE = handle;
    log('debug handle exposed as globalThis.WSE');
}

/**
 * Waits for the SillyTavern API object, then registers.
 * Module scripts can execute before core finishes wiring globals on slow boots,
 * so this retries briefly instead of throwing once and going silent.
 */
function boot() {
    const MAX_ATTEMPTS = 40; // 40 × 250 ms = 10 s
    let attempts = 0;

    const tryRegister = () => {
        attempts += 1;

        if (globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function') {
            try {
                registerExtension();
            } catch (error) {
                console.error(`${LOG_PREFIX} registration failed`, error);
            }
            return;
        }

        if (attempts >= MAX_ATTEMPTS) {
            console.error(`${LOG_PREFIX} gave up waiting for SillyTavern.getContext()`);
            return;
        }

        setTimeout(tryRegister, 250);
    };

    tryRegister();
}

/** Exposed for console debugging / future status UI. */
export function getStatusManager() {
    return statusManager;
}

/** Exposed for debugging and for the Node self-test. */
export function getEngine() {
    return engine;
}

log('index.js loaded');
boot();
