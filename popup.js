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

const controls = {
    toggleMode: document.getElementById("toggleMode"),
    toggleRuler: document.getElementById("toggleRuler"),
    toggleFocus: document.getElementById("toggleFocus"),
    rulerHeight: document.getElementById("rulerHeight"),
    fontSelect: document.getElementById("fontSelect"),
    fontSize: document.getElementById("fontSize"),
    lineHeight: document.getElementById("lineHeight"),
    letterSpacing: document.getElementById("letterSpacing"),
    wordSpacing: document.getElementById("wordSpacing"),
    themeSelect: document.getElementById("themeSelect"),
    resetSettings: document.getElementById("resetSettings"),
    status: document.getElementById("status"),
    readControls: document.getElementById("readControls"),
    readPage: document.getElementById("readPage"),
    pauseReading: document.getElementById("pauseReading"),
    resumeReading: document.getElementById("resumeReading"),
    stopReading: document.getElementById("stopReading"),
    spokenFeedback: document.getElementById("spokenFeedback"),
    voiceControl: document.getElementById("voiceControl"),
    speechStatus: document.getElementById("speechStatus")
};

let settings = { ...DEFAULTS };
let recognition = null;

function normalizeSettings(nextSettings) {
    const normalized = { ...DEFAULTS, ...nextSettings };
    if (!normalized.enabled) {
        normalized.focusMode = false;
        normalized.readingRuler = false;
    }
    return normalized;
}

async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

function showStatus(message) {
    controls.status.textContent = message;
}

function showSpeechStatus(message) {
    controls.speechStatus.textContent = message;
}

async function speakPopup(text) {
    const response = await sendSpeechCommand("speak", { text });
    if (response.ok) return true;

    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
        showSpeechStatus("Speech playback is unavailable in this browser.");
        return false;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onerror = () => showSpeechStatus("Speech playback could not start. Check that your device has a speech voice available.");
    window.speechSynthesis.speak(utterance);
    return true;
}

function announceIfEnabled(message) {
    if (settings.spokenFeedback) speakPopup(message);
}

function renderSettings() {
    controls.toggleMode.textContent = settings.enabled ? "ON" : "OFF";
    controls.toggleMode.setAttribute("aria-pressed", String(settings.enabled));
    controls.toggleRuler.textContent = settings.readingRuler ? "ON" : "OFF";
    controls.toggleRuler.setAttribute("aria-pressed", String(settings.readingRuler));
    controls.toggleFocus.textContent = settings.focusMode ? "ON" : "OFF";
    controls.toggleFocus.setAttribute("aria-pressed", String(settings.focusMode));
    controls.toggleRuler.disabled = !settings.enabled;
    controls.toggleFocus.disabled = !settings.enabled;
    controls.toggleRuler.setAttribute("aria-label", settings.enabled
        ? `Reading Ruler ${settings.readingRuler ? "on" : "off"}`
        : "Reading Ruler unavailable until Dyslexia Mode is on");
    controls.toggleFocus.setAttribute("aria-label", settings.enabled
        ? `Focus Mode ${settings.focusMode ? "on" : "off"}`
        : "Focus Mode unavailable until Dyslexia Mode is on");
    controls.spokenFeedback.checked = settings.spokenFeedback;
    controls.rulerHeight.value = settings.rulerHeight;
    controls.fontSelect.value = settings.font;
    controls.fontSize.value = settings.fontSize;
    controls.lineHeight.value = settings.lineHeight;
    controls.letterSpacing.value = settings.letterSpacing;
    controls.wordSpacing.value = settings.wordSpacing;
    controls.themeSelect.value = settings.theme;

    document.getElementById("fontSizeValue").textContent = `${settings.fontSize} px`;
    document.getElementById("lineHeightValue").textContent = Number(settings.lineHeight).toFixed(1);
    document.getElementById("letterSpacingValue").textContent = `${Number(settings.letterSpacing).toFixed(2)} em`;
    document.getElementById("wordSpacingValue").textContent = `${Number(settings.wordSpacing).toFixed(2)} em`;
    document.getElementById("rulerHeightValue").textContent = `${settings.rulerHeight} px`;
}

async function applySettingsToTab() {
    try {
        const tab = await getCurrentTab();
        if (!tab || !tab.id) {
            showStatus("No active tab found.");
            return;
        }
        await chrome.tabs.sendMessage(tab.id, {
            action: "updateSettings",
            settings
        });
        showStatus("Settings saved and applied.");
    } catch (error) {
        // Chrome blocks extension content scripts on some internal pages and the Web Store.
        showStatus("Saved. Open a regular webpage to apply settings.");
    }
}

async function saveAndApply() {
    renderSettings();
    await chrome.storage.local.set({ dyslexiaSettings: settings });
    await applySettingsToTab();
}

async function sendSpeechCommand(command, extra = {}) {
    try {
        const tab = await getCurrentTab();
        if (!tab || !tab.id) throw new Error("No active tab");
        const response = await chrome.tabs.sendMessage(tab.id, {
            action: "speechControl",
            command,
            ...extra
        });
        if (!response || !response.ok) {
            showSpeechStatus(response?.message || "Open a regular webpage to use read-aloud.");
            return response || { ok: false };
        }
        showSpeechStatus(response.message || "Speech command completed.");
        return response;
    } catch (error) {
        showSpeechStatus("Read-aloud is unavailable on this tab. Open a regular webpage and try again.");
        return { ok: false, message: "Read-aloud is unavailable on this tab." };
    }
}

function speakPopupInstructions() {
    speakPopup("Dyslexia Reader accessibility controls. Dyslexia Mode enables the Reading Ruler and Focus Mode. Use the font, size, spacing, and theme controls to adjust the page. Read selected text or the main article aloud with the Read selected text or main article button. Pause, resume, or stop speech with the playback buttons. Alt Shift D toggles Dyslexia Mode. Alt Shift V opens voice chat; press it again while listening to cancel, or while a reply is speaking to interrupt and listen again. Voice chat connects to Gemini through the backend URL configured in its panel. Say read aloud the conversation to hear that panel's saved chat; it does not read ChatGPT webpage content. Keyboard shortcuts can be customized at chrome extensions slash shortcuts. Press Start voice commands to use the popup microphone; Chrome's speech recognition service may process microphone audio.");
}

function stopVoiceRecognition() {
    if (!recognition) return;
    try {
        recognition.stop();
    } catch (error) {
        showSpeechStatus("Voice recognition has already stopped.");
    }
}

function startVoiceRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
        showSpeechStatus("Voice recognition is not supported here. Use the keyboard shortcuts or popup controls instead.");
        return;
    }

    try {
        recognition = new Recognition();
        recognition.lang = navigator.language || "en-US";
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.onstart = () => {
            controls.voiceControl.textContent = "Stop voice commands";
            controls.voiceControl.setAttribute("aria-pressed", "true");
            showSpeechStatus("Listening for one command. Speak a command, then wait for recognition to finish.");
        };
        recognition.onresult = event => {
            const transcript = event.results?.[0]?.[0]?.transcript || "";
            if (transcript) runVoiceCommand(transcript);
            else showSpeechStatus("No command was recognized. Press the microphone button to try again.");
        };
        recognition.onerror = event => {
            const message = event.error === "not-allowed" || event.error === "service-not-allowed"
                ? "Microphone access was denied. Allow it in Chrome site settings, or use keyboard and popup controls."
                : event.error === "audio-capture"
                    ? "No microphone is available. Connect one or use keyboard and popup controls."
                    : `Voice recognition error: ${event.error}. You can still use keyboard and popup controls.`;
            showSpeechStatus(message);
        };
        recognition.onend = () => {
            recognition = null;
            controls.voiceControl.textContent = "Start voice commands";
            controls.voiceControl.setAttribute("aria-pressed", "false");
        };
        recognition.start();
    } catch (error) {
        recognition = null;
        showSpeechStatus("Voice recognition could not start. Check microphone permission or use keyboard and popup controls.");
    }
}

async function runVoiceCommand(transcript) {
    const phrase = transcript.toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
    const has = (...options) => options.some(option => phrase.includes(option));

    if (has("enable dyslexia mode", "turn on dyslexia mode", "dyslexia mode on")) {
        settings.enabled = true;
        await saveAndApply();
        showSpeechStatus("Dyslexia Mode enabled.");
        announceIfEnabled("Dyslexia Mode on. Focus Mode and Reading Ruler remain off until enabled.");
        return;
    }
    if (has("disable dyslexia mode", "turn off dyslexia mode", "dyslexia mode off")) {
        settings.enabled = false;
        settings.focusMode = false;
        settings.readingRuler = false;
        await saveAndApply();
        showSpeechStatus("Dyslexia Mode, Focus Mode, and Reading Ruler disabled.");
        announceIfEnabled("Dyslexia Mode off. Focus Mode and Reading Ruler are also off.");
        return;
    }

    const wantsRulerOn = has("enable reading ruler", "turn on reading ruler", "reading ruler on");
    const wantsRulerOff = has("disable reading ruler", "turn off reading ruler", "reading ruler off");
    const wantsFocusOn = has("enable focus mode", "turn on focus mode", "focus mode on");
    const wantsFocusOff = has("disable focus mode", "turn off focus mode", "focus mode off");
    if (wantsRulerOn || wantsRulerOff || wantsFocusOn || wantsFocusOff) {
        if (!settings.enabled && (wantsRulerOn || wantsFocusOn)) {
            showSpeechStatus("Turn on Dyslexia Mode before enabling Focus Mode or the Reading Ruler.");
            announceIfEnabled("Turn on Dyslexia Mode first.");
            return;
        }
        if (wantsRulerOn || wantsRulerOff) settings.readingRuler = wantsRulerOn;
        if (wantsFocusOn || wantsFocusOff) settings.focusMode = wantsFocusOn;
        await saveAndApply();
        const message = `${settings.readingRuler ? "Reading Ruler on." : "Reading Ruler off."} ${settings.focusMode ? "Focus Mode on." : "Focus Mode off."}`;
        showSpeechStatus(message);
        announceIfEnabled(message);
        return;
    }

    if (has("read selected text", "read this page", "read the page")) {
        await sendSpeechCommand("readPage", { confirmation: "Starting read aloud. " });
        return;
    }
    if (has("pause reading", "pause read aloud")) {
        await sendSpeechCommand("pause");
        return;
    }
    if (has("resume reading", "resume read aloud")) {
        await sendSpeechCommand("resume");
        return;
    }
    if (has("stop reading", "stop read aloud")) {
        await sendSpeechCommand("stop");
        return;
    }
    if (has("increase text size", "increase font size", "make text bigger")) {
        settings.fontSize = Math.min(26, Number(settings.fontSize) + 1);
        await saveAndApply();
        showSpeechStatus(`Text size increased to ${settings.fontSize}.`);
        announceIfEnabled(`Text size ${settings.fontSize} pixels.`);
        return;
    }
    if (has("decrease text size", "decrease font size", "make text smaller")) {
        settings.fontSize = Math.max(14, Number(settings.fontSize) - 1);
        await saveAndApply();
        showSpeechStatus(`Text size decreased to ${settings.fontSize}.`);
        announceIfEnabled(`Text size ${settings.fontSize} pixels.`);
        return;
    }

    showSpeechStatus(`Command not recognized: ${transcript}. Try "read this page" or "enable Dyslexia Mode".`);
}

function updateFromControls() {
    settings = {
        ...settings,
        font: controls.fontSelect.value,
        fontSize: Number(controls.fontSize.value),
        lineHeight: Number(controls.lineHeight.value),
        letterSpacing: Number(controls.letterSpacing.value),
        wordSpacing: Number(controls.wordSpacing.value),
        theme: controls.themeSelect.value,
        rulerHeight: Number(controls.rulerHeight.value)
    };
    saveAndApply();
}

function describeControlChange(control) {
    if (control === controls.fontSelect) return `Font set to ${settings.font}.`;
    if (control === controls.fontSize) return `Font size ${settings.fontSize} pixels.`;
    if (control === controls.lineHeight) return `Line spacing ${Number(settings.lineHeight).toFixed(1)}.`;
    if (control === controls.letterSpacing) return `Letter spacing ${Number(settings.letterSpacing).toFixed(2)} em.`;
    if (control === controls.wordSpacing) return `Word spacing ${Number(settings.wordSpacing).toFixed(2)} em.`;
    if (control === controls.themeSelect) return `Reading theme ${settings.theme}.`;
    if (control === controls.rulerHeight) return `Reading Ruler height ${settings.rulerHeight} pixels.`;
    return "Setting updated.";
}

controls.toggleMode.addEventListener("click", async () => {
    settings.enabled = !settings.enabled;
    if (!settings.enabled) {
        settings.focusMode = false;
        settings.readingRuler = false;
    }
    await saveAndApply();
    announceIfEnabled(settings.enabled
        ? "Dyslexia Mode on. Focus Mode and Reading Ruler remain off until enabled."
        : "Dyslexia Mode off. Focus Mode and Reading Ruler are also off.");
});

controls.toggleRuler.addEventListener("click", async () => {
    if (!settings.enabled) return;
    settings.readingRuler = !settings.readingRuler;
    await saveAndApply();
    announceIfEnabled(`Reading Ruler ${settings.readingRuler ? "on" : "off"}.`);
});

controls.toggleFocus.addEventListener("click", async () => {
    if (!settings.enabled) return;
    settings.focusMode = !settings.focusMode;
    await saveAndApply();
    announceIfEnabled(`Focus Mode ${settings.focusMode ? "on" : "off"}.`);
});

controls.readControls.addEventListener("click", speakPopupInstructions);
controls.readPage.addEventListener("click", () => sendSpeechCommand("readPage"));
controls.pauseReading.addEventListener("click", () => sendSpeechCommand("pause"));
controls.resumeReading.addEventListener("click", () => sendSpeechCommand("resume"));
controls.stopReading.addEventListener("click", () => sendSpeechCommand("stop"));
controls.voiceControl.addEventListener("click", () => {
    if (recognition) stopVoiceRecognition();
    else startVoiceRecognition();
});

controls.spokenFeedback.addEventListener("change", () => {
    settings.spokenFeedback = controls.spokenFeedback.checked;
    saveAndApply();
    if (settings.spokenFeedback) announceIfEnabled("Spoken feedback on.");
});

[
    controls.fontSelect,
    controls.fontSize,
    controls.lineHeight,
    controls.letterSpacing,
    controls.wordSpacing,
    controls.themeSelect,
    controls.rulerHeight
].forEach(control => {
    control.addEventListener("input", updateFromControls);
    control.addEventListener("change", () => {
        updateFromControls();
        announceIfEnabled(describeControlChange(control));
    });
});

controls.resetSettings.addEventListener("click", async () => {
    if (recognition) stopVoiceRecognition();
    settings = { ...DEFAULTS };
    await saveAndApply();
    showStatus("Settings reset.");
});

(async function init() {
    const stored = await chrome.storage.local.get("dyslexiaSettings");
    settings = normalizeSettings(stored.dyslexiaSettings || {});
    renderSettings();
    if (stored.dyslexiaSettings && (
        stored.dyslexiaSettings.readingRuler !== settings.readingRuler ||
        stored.dyslexiaSettings.focusMode !== settings.focusMode
    )) {
        await chrome.storage.local.set({ dyslexiaSettings: settings });
    }
    // Re-apply saved preferences when the popup opens.
    applySettingsToTab();
})();

window.addEventListener("pagehide", () => {
    if (recognition) {
        recognition.onend = null;
        try {
            recognition.stop();
        } catch (error) {
            // The browser may already have ended one-shot recognition.
        }
        recognition = null;
    }
});

chrome.runtime.onMessage.addListener(message => {
    if (message.action === "speechNotice" && message.message) {
        showSpeechStatus(message.message);
    }
});
