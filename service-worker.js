const DEFAULTS = {
    enabled: false,
    font: "Arial",
    fontSize: 18,
    lineHeight: 1.8,
    letterSpacing: 0.04,
    wordSpacing: 0.08,
    theme: "cream",
    readingRuler: false,
    rulerHeight: 36,
    focusMode: false,
    spokenFeedback: false
};

const activeVoiceRequests = new Map();
const MAX_HISTORY_CHARACTERS = 30000;

function validateAiSettings(settings = {}) {
    const endpoint = String(settings.endpoint || "").trim().replace(/\/+$/, "");
    let parsed;
    try {
        parsed = new URL(endpoint);
    } catch (error) {
        throw new Error("Enter the URL of your Gemini backend.");
    }
    const localHost = ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost))
        || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
        throw new Error("Use an HTTPS backend URL. HTTP is allowed only for localhost development.");
    }
    return { endpoint };
}

async function fetchWithTimeout(url, options, timeoutMs = 90000) {
    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (timedOut) {
            throw new Error("The Gemini backend request timed out. Try again in a moment.");
        }
        throw error;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", relayAbort);
    }
}

async function getBackendError(response) {
    try {
        const body = await response.json();
        if (typeof body?.error?.message === "string") return body.error.message;
        if (typeof body?.message === "string") return body.message;
    } catch (error) {
        // A proxy may return a non-JSON error page.
    }
    return `The Gemini backend returned HTTP ${response.status}.`;
}

async function handleVoiceChatRequest(message) {
    const transcript = typeof message.transcript === "string" ? message.transcript.trim() : "";
    if (!transcript) return { ok: false, code: "empty_transcript", message: "No speech was recognized. Try speaking again." };
    if (transcript.length > 12000) return { ok: false, code: "transcript_too_long", message: "That request is too long. Try a shorter prompt." };

    const requestId = String(message.requestId ?? "");
    if (!requestId) return { ok: false, code: "invalid_request", message: "This voice request could not be identified. Please try again." };
    const controller = new AbortController();
    activeVoiceRequests.set(requestId, controller);

    try {
        const stored = await chrome.storage.local.get("geminiBackendSettings");
        const { endpoint } = validateAiSettings(stored.geminiBackendSettings || {});
        const originPattern = `${new URL(endpoint).origin}/*`;
        if (!await chrome.permissions.contains({ origins: [originPattern] })) {
            return { ok: false, code: "permission_required", message: "Grant this extension access to the configured Gemini backend URL. Use Test backend in the Voice Chat panel first." };
        }
        const submittedHistory = Array.isArray(message.history) ? message.history.slice(-24) : [];
        const history = [];
        let historyCharacters = 0;
        for (const entry of submittedHistory.reverse()) {
            if ((entry?.role !== "user" && entry?.role !== "assistant") || typeof entry.content !== "string" || !entry.content.trim()) continue;
            const content = entry.content.slice(0, 4000);
            if (historyCharacters + content.length > MAX_HISTORY_CHARACTERS) continue;
            history.unshift({ role: entry.role, content });
            historyCharacters += content.length;
        }
        let response;
        try {
            response = await fetchWithTimeout(`${endpoint}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ transcript, history }),
                signal: controller.signal
            });
        } catch (error) {
            if (controller.signal.aborted) return { ok: false, code: "cancelled", message: "Request cancelled." };
            if (error.message.includes("timed out")) return { ok: false, code: "timeout", message: error.message };
            return {
                ok: false,
                code: "connection_failed",
                message: `Could not reach the Gemini backend at ${endpoint}. Check that it is running, the URL permission was granted, and its allowed extension origin includes this extension.`
            };
        }

        if (controller.signal.aborted) return { ok: false, code: "cancelled", message: "Request cancelled." };
        if (!response.ok) {
            const backendMessage = await getBackendError(response);
            if (response.status === 404) {
                return {
                    ok: false,
                    code: "backend_route_not_found",
                    message: `The extension request POST ${endpoint}/api/chat returned HTTP 404 (extension-to-backend route). Backend response: ${backendMessage}. This backend maps Gemini-side errors to HTTP 502.`
                };
            }
            return { ok: false, code: "backend_error", message: backendMessage };
        }
        let result;
        try {
            result = await response.json();
        } catch (error) {
            return { ok: false, code: "invalid_response", message: "The Gemini backend returned invalid JSON." };
        }
        if (controller.signal.aborted) return { ok: false, code: "cancelled", message: "Request cancelled." };
        const reply = result?.reply;
        if (typeof reply !== "string" || !reply.trim()) {
            return { ok: false, code: "empty_response", message: "Gemini returned an empty response. Please try again." };
        }
        return { ok: true, reply: reply.trim(), model: result.model || "Gemini" };
    } catch (error) {
        return { ok: false, code: "configuration_error", message: error.message || "Check the Gemini backend settings and try again." };
    } finally {
        if (activeVoiceRequests.get(requestId) === controller) activeVoiceRequests.delete(requestId);
    }
}

async function testAiBackend() {
    try {
        const stored = await chrome.storage.local.get("geminiBackendSettings");
        const { endpoint } = validateAiSettings(stored.geminiBackendSettings || {});
        const originPattern = `${new URL(endpoint).origin}/*`;
        if (!await chrome.permissions.contains({ origins: [originPattern] })) {
            return { ok: false, message: "Backend access has not been granted. Use Test backend and approve the host permission." };
        }
        let response;
        try {
            response = await fetchWithTimeout(`${endpoint}/api/health`, { method: "GET" }, 10000);
        } catch (error) {
            return { ok: false, message: `Could not reach the Gemini backend at ${endpoint}. Check that it is running and the backend URL has been granted to the extension.` };
        }
        if (!response.ok) return { ok: false, message: await getBackendError(response) };
        let data;
        try {
            data = await response.json();
        } catch (error) {
            return { ok: false, message: "The backend returned invalid JSON from /api/health." };
        }
        if (!data?.ok || !data?.geminiConfigured) {
            return { ok: false, message: data?.message || "The backend is reachable, but Gemini is not configured." };
        }
        let modelsResponse;
        try {
            modelsResponse = await fetchWithTimeout(`${endpoint}/api/models`, { method: "GET" }, 20000);
        } catch (error) {
            return { ok: false, message: `Backend is reachable, but its Google Models API check failed: ${error.message}` };
        }
        if (!modelsResponse.ok) return { ok: false, message: await getBackendError(modelsResponse) };
        let modelData;
        try { modelData = await modelsResponse.json(); }
        catch { return { ok: false, message: "The backend returned invalid JSON from /api/models." }; }
        if (modelData?.configuredModelSupported) {
            return { ok: true, message: `Gemini backend and API key are working. ${modelData.model} supports generateContent for this key.` };
        }
        const available = Array.isArray(modelData?.supportedModels)
            ? modelData.supportedModels.map(model => model.name).slice(0, 8).join(", ")
            : "none returned";
        return { ok: false, message: `Configured model ${modelData?.model || "(missing)"} is not available with generateContent for this API key. Available: ${available}. Set GEMINI_MODEL in backend/.env.` };
    } catch (error) {
        return { ok: false, message: error.message || "Check the Gemini backend URL." };
    }
}

async function getSettings() {
    const stored = await chrome.storage.local.get("dyslexiaSettings");
    const settings = { ...DEFAULTS, ...(stored.dyslexiaSettings || {}) };
    if (!settings.enabled) {
        settings.readingRuler = false;
        settings.focusMode = false;
    }
    return settings;
}

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
}

async function sendToTab(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
        return null;
    }
}

chrome.commands.onCommand.addListener(async (command) => {
    const tab = await getActiveTab();

    if (command === "voice_chat") {
        if (tab && typeof tab.id === "number") {
            await sendToTab(tab.id, { action: "speechControl", command: "stop" });
        }

        const { voicePanelWindowId } = await chrome.storage.session.get("voicePanelWindowId");
        if (typeof voicePanelWindowId === "number") {
            try {
                await chrome.windows.update(voicePanelWindowId, { focused: true });
                chrome.runtime.sendMessage({ action: "voiceShortcut" }).catch(() => {});
                return;
            } catch (error) {
                await chrome.storage.session.remove("voicePanelWindowId");
            }
        }

        const panel = await chrome.windows.create({
            url: chrome.runtime.getURL("voice-chat.html?start=1"),
            type: "popup",
            focused: true,
            width: 420,
            height: 620
        });
        if (typeof panel?.id === "number") {
            await chrome.storage.session.set({ voicePanelWindowId: panel.id });
        }
        return;
    }

    if (command === "toggle_read_aloud") {
        if (tab && typeof tab.id === "number") {
            await sendToTab(tab.id, { action: "speechControl", command: "toggle" });
        }
        return;
    }

    const settings = await getSettings();
    let confirmation = "";

    if (command === "toggle_dyslexia_mode") {
        settings.enabled = !settings.enabled;
        if (!settings.enabled) {
            settings.focusMode = false;
            settings.readingRuler = false;
            confirmation = "Dyslexia Mode off. Focus Mode and Reading Ruler are also off.";
        } else {
            confirmation = "Dyslexia Mode on. Focus Mode and Reading Ruler remain off until enabled.";
        }
    } else if (command === "toggle_reading_ruler" || command === "toggle_focus_mode") {
        if (!settings.enabled) {
            if (settings.spokenFeedback && tab && typeof tab.id === "number") {
                await sendToTab(tab.id, {
                    action: "speechControl",
                    command: "speak",
                    text: "Turn on Dyslexia Mode before enabling Focus Mode or the Reading Ruler."
                });
            }
            return;
        }

        if (command === "toggle_reading_ruler") {
            settings.readingRuler = !settings.readingRuler;
            confirmation = `Reading Ruler ${settings.readingRuler ? "on" : "off"}.`;
        } else {
            settings.focusMode = !settings.focusMode;
            confirmation = `Focus Mode ${settings.focusMode ? "on" : "off"}.`;
        }
    } else {
        return;
    }

    await chrome.storage.local.set({ dyslexiaSettings: settings });
    if (tab && typeof tab.id === "number") {
        await sendToTab(tab.id, { action: "updateSettings", settings });
    }

    if (settings.spokenFeedback && tab && typeof tab.id === "number") {
        await sendToTab(tab.id, {
            action: "speechControl",
            command: "speak",
            text: confirmation
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Keep the MV3 service worker available as a message recipient for notices
    // sent from content scripts; an open popup may also present them visually.
    if (message.action === "speechNotice") return false;
    if (message.action === "voicePanelReady" && sender.tab?.windowId !== undefined) {
        chrome.storage.session.set({ voicePanelWindowId: sender.tab.windowId });
        return false;
    }
    if (message.action === "voicePanelClosed") {
        chrome.storage.session.get("voicePanelWindowId").then(({ voicePanelWindowId }) => {
            if (voicePanelWindowId === sender.tab?.windowId) chrome.storage.session.remove("voicePanelWindowId");
        });
        return false;
    }
    if (message.action === "voiceChatRequest") {
        handleVoiceChatRequest(message).then(sendResponse);
        return true;
    }
    if (message.action === "cancelVoiceChat") {
        const controller = activeVoiceRequests.get(String(message.requestId ?? ""));
        if (controller) controller.abort();
        sendResponse({ ok: true });
        return false;
    }
    if (message.action === "testAiBackend") {
        testAiBackend().then(sendResponse);
        return true;
    }
});
