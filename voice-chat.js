const elements = {
    state: document.getElementById("state"),
    message: document.getElementById("message"),
    transcript: document.getElementById("transcript"),
    conversation: document.getElementById("conversation"),
    endpoint: document.getElementById("endpoint"),
    toggle: document.getElementById("toggle"),
    saveSettings: document.getElementById("saveSettings"),
    testConnection: document.getElementById("testConnection")
};

const DEFAULT_AI_SETTINGS = { endpoint: "" };
const MAX_HISTORY_MESSAGES = 24;
let state = "idle";
let recognition = null;
let runId = 0;
let pendingRequestId = null;
let conversation = [];
let speechChunks = [];

function setState(next, message) {
    state = next;
    elements.state.dataset.state = next;
    elements.state.textContent = next[0].toUpperCase() + next.slice(1);
    elements.message.textContent = message;
    elements.toggle.textContent = next === "listening" ? "Cancel listening" : "Start listening";
}

function interruptSpeech() {
    speechChunks = [];
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function discardRecognition() {
    if (!recognition) return;
    const previous = recognition;
    recognition = null;
    previous.onresult = null;
    previous.onerror = null;
    previous.onend = null;
    try { previous.abort(); } catch (error) { /* Recognition already ended. */ }
}

function cancelPendingRequest() {
    if (pendingRequestId === null) return;
    chrome.runtime.sendMessage({ action: "cancelVoiceChat", requestId: pendingRequestId }).catch(() => {});
    pendingRequestId = null;
}

function cancelToIdle() {
    runId += 1;
    cancelPendingRequest();
    discardRecognition();
    interruptSpeech();
    setState("idle", "Voice chat stopped.");
}

function validateAiSettings() {
    const endpoint = elements.endpoint.value.trim().replace(/\/+$/, "");
    let parsed;
    try { parsed = new URL(endpoint); }
    catch (error) { throw new Error("Enter your Gemini backend URL. For local development, use the address in the README."); }
    const localHost = ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost))
        || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
        throw new Error("Use an HTTPS backend URL. HTTP is allowed only for localhost development.");
    }
    return { endpoint };
}

async function saveAiSettings(showConfirmation = true) {
    const settings = validateAiSettings();
    await chrome.storage.local.set({ geminiBackendSettings: settings });
    if (showConfirmation) setState("idle", `Saved Gemini backend URL: ${settings.endpoint}.`);
    return settings;
}

function renderConversation() {
    elements.conversation.replaceChildren();
    if (!conversation.length) {
        const empty = document.createElement("p");
        empty.className = "empty-conversation";
        empty.textContent = "Your local chat history will appear here.";
        elements.conversation.append(empty);
        return;
    }
    for (const entry of conversation) {
        const bubble = document.createElement("div");
        bubble.className = `bubble ${entry.role}`;
        const speaker = document.createElement("strong");
        speaker.textContent = entry.role === "user" ? "You" : "Assistant";
        const content = document.createElement("span");
        content.textContent = entry.content;
        bubble.append(speaker, content);
        elements.conversation.append(bubble);
    }
    elements.conversation.scrollTop = elements.conversation.scrollHeight;
}

function splitSpeech(text, maximum = 1800) {
    const chunks = [];
    let remaining = text.trim();
    while (remaining.length > maximum) {
        let boundary = remaining.lastIndexOf(" ", maximum);
        if (boundary < maximum * 0.6) boundary = maximum;
        chunks.push(remaining.slice(0, boundary).trim());
        remaining = remaining.slice(boundary).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function speakNextChunk(speechRun) {
    if (speechRun !== runId || !speechChunks.length) {
        if (speechRun === runId && state === "speaking") setState("idle", "Speech finished. Press Alt+Shift+V to speak again.");
        return;
    }
    const utterance = new SpeechSynthesisUtterance(speechChunks.shift());
    utterance.lang = navigator.language || "en-US";
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) {
        utterance.voice = voices.find(voice => voice.lang.toLowerCase() === utterance.lang.toLowerCase())
            || voices.find(voice => voice.default) || voices[0];
    }
    utterance.onend = () => speakNextChunk(speechRun);
    utterance.onerror = event => {
        if (speechRun !== runId || event.error === "canceled" || event.error === "interrupted") return;
        speechChunks = [];
        setState("error", "Speech playback failed. Check that your device has an available speech voice.");
    };
    window.speechSynthesis.speak(utterance);
}

function speakText(text, statusMessage) {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
        setState("error", "Speech playback is unavailable in this browser. The response is still shown above.");
        return;
    }
    interruptSpeech();
    const speechRun = runId;
    speechChunks = splitSpeech(text);
    if (!speechChunks.length) {
        setState("error", "There is no conversation text to read aloud yet.");
        return;
    }
    setState("speaking", statusMessage);
    speakNextChunk(speechRun);
}

function readConversationAloud() {
    const text = conversation.map(entry => `${entry.role === "user" ? "You" : "Assistant"}: ${entry.content}`).join("\n\n");
    if (!text.trim()) {
        setState("error", "There is no saved voice chat conversation to read aloud yet.");
        return;
    }
    runId += 1;
    cancelPendingRequest();
    discardRecognition();
    interruptSpeech();
    speakText(text, "Reading this voice panel's saved conversation. Press Alt+Shift+V to interrupt.");
}

function isReadConversationCommand(transcript) {
    const phrase = transcript.toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
    return phrase.includes("read aloud the conversation")
        || phrase.includes("read the conversation aloud")
        || phrase === "read conversation";
}

async function submitTranscript(transcript, thisRun) {
    if (!transcript.trim()) {
        setState("error", "No speech was recognized. Press Alt+Shift+V to try again.");
        return;
    }
    if (isReadConversationCommand(transcript)) {
        readConversationAloud();
        return;
    }

    const requestId = `${Date.now()}-${thisRun}-${Math.random().toString(36).slice(2)}`;
    pendingRequestId = requestId;
        setState("processing", "Sending your request to the Gemini backend…");
    try {
        const response = await chrome.runtime.sendMessage({
            action: "voiceChatRequest",
            transcript,
            history: conversation,
            requestId
        });
        if (thisRun !== runId) return;
        if (!response?.ok || typeof response.reply !== "string" || !response.reply.trim()) {
            setState("error", response?.message || "Gemini returned an empty response. Check the backend connection and try again.");
            return;
        }

        conversation = [...conversation,
            { role: "user", content: transcript.trim() },
            { role: "assistant", content: response.reply.trim() }
        ].slice(-MAX_HISTORY_MESSAGES);
        await chrome.storage.local.set({ voiceChatHistory: conversation });
        if (thisRun !== runId) return;
        renderConversation();
        speakText(response.reply.trim(), `Reply from ${response.model || "Gemini"}. Press Alt+Shift+V to interrupt and listen again.`);
    } catch (error) {
        if (thisRun === runId) {
            setState("error", "Could not contact the extension service worker. Reload the extension and try again.");
        }
    } finally {
        if (pendingRequestId === requestId) pendingRequestId = null;
    }
}

function startListening() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
        setState("error", "Speech recognition is unavailable in this Chrome build. Use the popup controls or keyboard shortcuts instead.");
        return;
    }

    runId += 1;
    const thisRun = runId;
    cancelPendingRequest();
    discardRecognition();
    interruptSpeech();
    elements.transcript.value = "";
    setState("listening", "Listening once for your request. Speak now; press Alt+Shift+V again to cancel.");

    try {
        const currentRecognition = new Recognition();
        recognition = currentRecognition;
        currentRecognition.lang = navigator.language || "en-US";
        currentRecognition.continuous = false;
        currentRecognition.interimResults = false;
        currentRecognition.maxAlternatives = 1;
        currentRecognition.onresult = event => {
            if (thisRun !== runId) return;
            const transcript = event.results?.[0]?.[0]?.transcript?.trim() || "";
            elements.transcript.value = transcript;
            if (transcript) submitTranscript(transcript, thisRun);
            else setState("error", "No speech was recognized. Press Alt+Shift+V to try again.");
        };
        currentRecognition.onerror = event => {
            if (thisRun !== runId) return;
            const explanation = event.error === "not-allowed" || event.error === "service-not-allowed"
                ? "Microphone or speech-recognition access was denied. Allow access in Chrome, then try again."
                : event.error === "audio-capture"
                    ? "No microphone is available. Connect one, then try again."
                    : `Speech recognition error: ${event.error}. Press Alt+Shift+V to retry.`;
            setState("error", explanation);
        };
        currentRecognition.onend = () => {
            if (thisRun === runId && state === "listening") {
                recognition = null;
                setState("idle", "Listening ended. Press Alt+Shift+V to start again.");
            }
        };
        currentRecognition.start();
    } catch (error) {
        recognition = null;
        setState("error", "Could not start speech recognition. Check microphone access or use the popup controls.");
    }
}

function handleShortcut() {
    if (state === "listening") {
        cancelToIdle();
        return;
    }
    // Starting a fresh run aborts pending AI work and cancels speech playback.
    startListening();
}

async function testConnection() {
    elements.testConnection.disabled = true;
    try {
        const settings = validateAiSettings();
        const originPattern = `${new URL(settings.endpoint).origin}/*`;
        const granted = await chrome.permissions.request({ origins: [originPattern] });
        if (!granted) {
            setState("error", "Backend access was not granted. Approve the requested host permission to connect.");
            return;
        }
        await chrome.storage.local.set({ geminiBackendSettings: settings });
        setState("processing", "Checking the backend and Gemini configuration…");
        const response = await chrome.runtime.sendMessage({ action: "testAiBackend" });
        setState(response?.ok ? "idle" : "error", response?.message || "Gemini backend check failed.");
    } catch (error) {
        setState("error", error.message || "Could not save the local AI settings.");
    } finally {
        elements.testConnection.disabled = false;
    }
}

elements.toggle.addEventListener("click", () => {
    if (state === "listening") cancelToIdle();
    else startListening();
});
document.getElementById("close").addEventListener("click", () => window.close());
elements.saveSettings.addEventListener("click", async () => {
    try { await saveAiSettings(); }
    catch (error) { setState("error", error.message); }
});
elements.testConnection.addEventListener("click", testConnection);
document.getElementById("readConversation").addEventListener("click", readConversationAloud);
document.getElementById("clearConversation").addEventListener("click", async () => {
    conversation = [];
    await chrome.storage.local.remove("voiceChatHistory");
    renderConversation();
    setState("idle", "Saved conversation cleared from this extension.");
});

chrome.runtime.onMessage.addListener(message => {
    if (message.action === "voiceShortcut") handleShortcut();
});

async function initialize() {
    try {
        const stored = await chrome.storage.local.get(["geminiBackendSettings", "voiceChatHistory"]);
        const settings = { ...DEFAULT_AI_SETTINGS, ...(stored.geminiBackendSettings || {}) };
        elements.endpoint.value = settings.endpoint;
        conversation = Array.isArray(stored.voiceChatHistory)
            ? stored.voiceChatHistory.filter(item => (item?.role === "user" || item?.role === "assistant")
                && typeof item.content === "string").slice(-MAX_HISTORY_MESSAGES)
            : [];
        renderConversation();
    } catch (error) {
        setState("error", "Could not load saved voice-chat settings.");
    }
    chrome.runtime.sendMessage({ action: "voicePanelReady" }).catch(() => {});
    if (new URLSearchParams(location.search).get("start") === "1") startListening();
}

initialize();

window.addEventListener("pagehide", () => {
    runId += 1;
    cancelPendingRequest();
    discardRecognition();
    interruptSpeech();
    chrome.runtime.sendMessage({ action: "voicePanelClosed" }).catch(() => {});
});
