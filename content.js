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

let settings = { ...DEFAULTS };
let rulerHost = null;
let focusHost = null;
let focusedBlock = null;
let lastFocusEventTarget = null;
let lastPointerPosition = null;
let pointerTracking = false;
let focusAnimationFrame = null;
let focusCurrentRect = null;
let focusLastFrameTime = 0;
let speechQueue = [];
let speechRunId = 0;
let speechActive = false;
let speechPaused = false;

const FOCUS_BLOCK_SELECTOR = "p, li, blockquote, figcaption, dd, dt, article";
const FOCUS_EXCLUDED_SELECTOR = "nav, header, footer, aside, [role='navigation'], input, textarea, select, button";

function getReadableText() {
    const selectedText = window.getSelection?.().toString().trim();
    if (selectedText) return { text: selectedText, source: "selected text" };

    const mainContent = document.querySelector("article") || document.querySelector("main") || document.body;
    return {
        text: (mainContent?.innerText || mainContent?.textContent || "").replace(/\n{3,}/g, "\n\n").trim(),
        source: mainContent?.tagName === "ARTICLE" ? "main article" : "main page content"
    };
}

function splitSpeechText(text, maxLength = 1800) {
    const chunks = [];
    let remaining = text.trim();
    while (remaining.length > maxLength) {
        let boundary = remaining.lastIndexOf(" ", maxLength);
        if (boundary < maxLength * 0.6) boundary = maxLength;
        chunks.push(remaining.slice(0, boundary).trim());
        remaining = remaining.slice(boundary).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function stopSpeech() {
    speechRunId += 1;
    speechQueue = [];
    speechActive = false;
    speechPaused = false;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function reportSpeechNotice(message) {
    chrome.runtime.sendMessage({ action: "speechNotice", message }).catch(() => {});
}

function speakNextChunk(runId) {
    if (runId !== speechRunId || !speechActive) return;
    const chunk = speechQueue.shift();
    if (!chunk) {
        speechActive = false;
        speechPaused = false;
        reportSpeechNotice("Read-aloud finished.");
        return;
    }

    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = navigator.language || "en-US";
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) {
        utterance.voice = voices.find(voice => voice.lang.toLowerCase() === utterance.lang.toLowerCase())
            || voices.find(voice => voice.default)
            || voices[0];
    }
    utterance.onend = () => speakNextChunk(runId);
    utterance.onerror = event => {
        if (runId !== speechRunId || event.error === "canceled" || event.error === "interrupted") return;
        speechActive = false;
        speechPaused = false;
        speechQueue = [];
        reportSpeechNotice("Speech playback failed. Check that your device has an available speech voice.");
    };
    window.speechSynthesis.speak(utterance);
}

function startSpeech(text) {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
        return { ok: false, message: "Speech playback is unavailable in this browser." };
    }
    if (!text.trim()) return { ok: false, message: "There is no readable text on this page." };

    stopSpeech();
    speechQueue = splitSpeechText(text);
    speechActive = true;
    const runId = speechRunId;
    speakNextChunk(runId);
    return { ok: true, message: "Read-aloud started." };
}

function handleSpeechControl(message) {
    const command = message.command;
    if (command === "readPage") {
        const readable = getReadableText();
        const text = `${message.confirmation || ""}${readable.text}`;
        const response = startSpeech(text);
        if (response.ok) response.message = `Reading ${readable.source}.`;
        return response;
    }
    if (command === "toggle") {
        if (speechActive || speechPaused || window.speechSynthesis?.speaking || window.speechSynthesis?.paused) {
            stopSpeech();
            return { ok: true, message: "Read-aloud stopped." };
        }
        const readable = getReadableText();
        return startSpeech(readable.text);
    }
    if (command === "pause") {
        if (!speechActive || !("speechSynthesis" in window)) return { ok: false, message: "Nothing is being read aloud." };
        window.speechSynthesis.pause();
        speechPaused = true;
        return { ok: true, message: "Read-aloud paused." };
    }
    if (command === "resume") {
        if (!speechActive || !("speechSynthesis" in window)) return { ok: false, message: "There is no paused reading to resume." };
        window.speechSynthesis.resume();
        speechPaused = false;
        return { ok: true, message: "Read-aloud resumed." };
    }
    if (command === "stop") {
        stopSpeech();
        return { ok: true, message: "Read-aloud stopped." };
    }
    if (command === "speak") {
        return startSpeech(message.text || "");
    }
    return { ok: false, message: "Unknown speech command." };
}

function handlePointerMove(event) {
    positionRuler(event);
    lastPointerPosition = { x: event.clientX, y: event.clientY };
    updateFocusFromPointer(event);
}

function handleViewportChange() {
    if (!settings.focusMode || !lastPointerPosition) return;

    const target = document.elementFromPoint(lastPointerPosition.x, lastPointerPosition.y);
    const block = findFocusBlock(target);
    if (block) focusedBlock = block;
    scheduleFocusUpdate();
}

function syncPointerTracking() {
    const shouldTrack = settings.readingRuler || settings.focusMode;
    if (shouldTrack === pointerTracking) return;

    pointerTracking = shouldTrack;
    if (pointerTracking) {
        document.addEventListener("pointermove", handlePointerMove, { passive: true });
        document.addEventListener("scroll", handleViewportChange, { passive: true, capture: true });
        window.addEventListener("resize", handleViewportChange, { passive: true });
    } else {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("scroll", handleViewportChange, true);
        window.removeEventListener("resize", handleViewportChange);
    }
}

function positionRuler(event) {
    if (!rulerHost) return;

    const height = Math.max(24, Math.min(80, Number(settings.rulerHeight) || DEFAULTS.rulerHeight));
    const top = Math.max(0, Math.min(window.innerHeight - height, event.clientY - height / 2));
    const ruler = rulerHost.shadowRoot.querySelector(".ruler");
    if (ruler) ruler.style.transform = `translateY(${top}px)`;
}

function updateRulerAppearance() {
    if (!rulerHost) return;

    const ruler = rulerHost.shadowRoot.querySelector(".ruler");
    if (!ruler) return;

    const isDark = settings.theme === "dark";
    ruler.style.height = `${Math.max(24, Math.min(80, Number(settings.rulerHeight) || DEFAULTS.rulerHeight))}px`;
    ruler.style.background = isDark ? "rgba(130, 177, 255, 0.19)" : "rgba(255, 220, 105, 0.28)";
    ruler.style.borderColor = isDark ? "rgba(185, 211, 255, 0.55)" : "rgba(164, 125, 25, 0.38)";
}

function removeReadingRuler() {
    if (!rulerHost) return;

    rulerHost.remove();
    rulerHost = null;
}

function showReadingRuler() {
    if (rulerHost || !document.documentElement) return;

    rulerHost = document.createElement("div");
    rulerHost.id = "dyslexia-reading-ruler-host";
    rulerHost.style.cssText = [
        "all: initial !important",
        "position: fixed !important",
        "top: 0 !important",
        "left: 0 !important",
        "width: 100vw !important",
        "height: 0 !important",
        "z-index: 2147483647 !important",
        "pointer-events: none !important"
    ].join(";");

    const shadow = rulerHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
        .ruler {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            box-sizing: border-box;
            border-top: 1px solid;
            border-bottom: 1px solid;
            pointer-events: none;
            transform: translateY(0);
            will-change: transform;
        }
    `;
    const ruler = document.createElement("div");
    ruler.className = "ruler";
    shadow.append(style, ruler);
    document.documentElement.appendChild(rulerHost);
    updateRulerAppearance();
}

function applyReadingRuler() {
    if (settings.readingRuler) {
        if (!rulerHost) showReadingRuler();
        updateRulerAppearance();
    } else {
        removeReadingRuler();
    }
    syncPointerTracking();
}

function isEligibleFocusBlock(element) {
    if (!element || element.closest(FOCUS_EXCLUDED_SELECTOR)) return false;

    const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const rect = element.getBoundingClientRect();
    const minimumTextLength = element.matches("article") ? 40 : 12;
    return text.length >= minimumTextLength && rect.width >= 120 && rect.height >= 24;
}

function findFocusBlock(target) {
    let element = target instanceof Element ? target : target && target.parentElement;
    while (element && element !== document.body) {
        if (element.matches(FOCUS_BLOCK_SELECTOR) && isEligibleFocusBlock(element)) return element;
        element = element.parentElement;
    }
    return null;
}

function clearFocusOverlay() {
    if (!focusHost) return;

    const shadow = focusHost.shadowRoot;
    shadow.querySelectorAll(".shade, .focus-frame").forEach(panel => {
        setPanelRect(panel, 0, 0, 0, 0);
    });
}

function setPanelRect(panel, left, top, width, height) {
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${Math.max(0, width)}px`;
    panel.style.height = `${Math.max(0, height)}px`;
}

function updateFocusOverlay(rect) {
    if (!focusHost || !rect) return;

    const left = Math.max(0, Math.min(window.innerWidth, rect.left));
    const right = Math.max(left, Math.min(window.innerWidth, rect.right));
    const top = Math.max(0, Math.min(window.innerHeight, rect.top));
    const bottom = Math.max(top, Math.min(window.innerHeight, rect.bottom));
    const shadow = focusHost.shadowRoot;

    setPanelRect(shadow.querySelector(".top"), 0, 0, window.innerWidth, top);
    setPanelRect(shadow.querySelector(".bottom"), 0, bottom, window.innerWidth, window.innerHeight - bottom);
    setPanelRect(shadow.querySelector(".left"), 0, top, left, bottom - top);
    setPanelRect(shadow.querySelector(".right"), right, top, window.innerWidth - right, bottom - top);

    const frame = shadow.querySelector(".focus-frame");
    setPanelRect(frame, left, top, right - left, bottom - top);
}

function updateFocusFromPointer(event) {
    if (!settings.focusMode || !focusHost) return;

    if (event.target !== lastFocusEventTarget) {
        lastFocusEventTarget = event.target;
        const block = findFocusBlock(event.target);
        if (block && block !== focusedBlock) {
            focusedBlock = block;
            scheduleFocusUpdate();
        }
    }

    if (focusedBlock && !focusedBlock.isConnected) {
        focusedBlock = null;
        focusCurrentRect = null;
        if (focusAnimationFrame !== null) cancelAnimationFrame(focusAnimationFrame);
        focusAnimationFrame = null;
        clearFocusOverlay();
    }
}

function scheduleFocusUpdate() {
    if (!focusHost || !focusedBlock || focusAnimationFrame !== null) return;
    focusAnimationFrame = requestAnimationFrame(animateFocusOverlay);
}

function animateFocusOverlay(timestamp) {
    focusAnimationFrame = null;
    if (!settings.enabled || !settings.focusMode || !focusHost || !focusedBlock || !focusedBlock.isConnected) return;

    const rect = focusedBlock.getBoundingClientRect();
    const target = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    if (!focusCurrentRect) {
        focusCurrentRect = target;
    } else {
        const elapsed = focusLastFrameTime ? Math.min(50, timestamp - focusLastFrameTime) : 16;
        const easing = 1 - Math.exp(-elapsed / 45);
        focusCurrentRect = {
            left: focusCurrentRect.left + (target.left - focusCurrentRect.left) * easing,
            top: focusCurrentRect.top + (target.top - focusCurrentRect.top) * easing,
            right: focusCurrentRect.right + (target.right - focusCurrentRect.right) * easing,
            bottom: focusCurrentRect.bottom + (target.bottom - focusCurrentRect.bottom) * easing
        };
    }
    focusLastFrameTime = timestamp;
    updateFocusOverlay(focusCurrentRect);

    const remaining = Math.max(
        Math.abs(target.left - focusCurrentRect.left),
        Math.abs(target.top - focusCurrentRect.top),
        Math.abs(target.right - focusCurrentRect.right),
        Math.abs(target.bottom - focusCurrentRect.bottom)
    );
    if (remaining > 0.5) {
        focusAnimationFrame = requestAnimationFrame(animateFocusOverlay);
    } else {
        focusCurrentRect = target;
        updateFocusOverlay(target);
        focusLastFrameTime = 0;
    }
}

function updateFocusAppearance() {
    if (!focusHost) return;

    const isDark = settings.theme === "dark";
    const shadow = focusHost.shadowRoot;
    shadow.querySelectorAll(".shade").forEach(panel => {
        panel.style.background = isDark ? "rgba(0, 0, 0, 0.38)" : "rgba(29, 27, 22, 0.28)";
    });
    shadow.querySelector(".focus-frame").style.borderColor = isDark
        ? "rgba(177, 204, 255, 0.72)"
        : "rgba(255, 255, 255, 0.8)";
}

function removeFocusMode() {
    if (!focusHost) return;

    if (focusAnimationFrame !== null) cancelAnimationFrame(focusAnimationFrame);
    focusAnimationFrame = null;
    focusCurrentRect = null;
    focusLastFrameTime = 0;
    focusHost.remove();
    focusHost = null;
    focusedBlock = null;
    lastFocusEventTarget = null;
    lastPointerPosition = null;
}

function showFocusMode() {
    if (focusHost || !document.documentElement) return;

    focusHost = document.createElement("div");
    focusHost.id = "dyslexia-focus-mode-host";
    focusHost.style.cssText = [
        "all: initial !important",
        "position: fixed !important",
        "top: 0 !important",
        "left: 0 !important",
        "width: 0 !important",
        "height: 0 !important",
        "z-index: 2147483646 !important",
        "pointer-events: none !important"
    ].join(";");

    const shadow = focusHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
        .shade, .focus-frame {
            position: fixed;
            box-sizing: border-box;
            pointer-events: none;
            transition: background-color 120ms ease;
        }
        .shade { left: 0; top: 0; width: 0; height: 0; }
        .focus-frame {
            border: 1px solid;
            border-radius: 2px;
            background: transparent;
        }
    `;
    const panels = ["top", "bottom", "left", "right"].map(side => {
        const panel = document.createElement("div");
        panel.className = `shade ${side}`;
        return panel;
    });
    const frame = document.createElement("div");
    frame.className = "focus-frame";
    shadow.append(style, ...panels, frame);
    document.documentElement.appendChild(focusHost);
    updateFocusAppearance();
}

function applyFocusMode() {
    if (settings.focusMode) {
        if (!focusHost) showFocusMode();
        updateFocusAppearance();
    } else {
        removeFocusMode();
    }
    syncPointerTracking();
}

function applySettings(nextSettings) {
    settings = { ...DEFAULTS, ...nextSettings };
    if (!settings.enabled) {
        settings.focusMode = false;
        settings.readingRuler = false;
    }

    // Keep one overlay and one pointer listener while preferences change.
    applyReadingRuler();
    applyFocusMode();

    if (settings.enabled) {
        if (document.body) document.body.classList.add("dyslexia-mode");
    } else if (document.body) {
        document.body.classList.remove("dyslexia-mode");
    }

    const root = document.documentElement;
    root.style.setProperty("--dyslexia-font", `"${settings.font}", sans-serif`);
    root.style.setProperty("--dyslexia-font-size", `${settings.fontSize}px`);
    root.style.setProperty("--dyslexia-line-height", String(settings.lineHeight));
    root.style.setProperty("--dyslexia-letter-spacing", `${settings.letterSpacing}em`);
    root.style.setProperty("--dyslexia-word-spacing", `${settings.wordSpacing}em`);

    const themes = {
        cream: { background: "#f7f3e8", text: "#2d2d2d" },
        light: { background: "#ffffff", text: "#222222" },
        dark: { background: "#202124", text: "#e8eaed" }
    };
    const theme = themes[settings.theme] || themes.cream;
    root.style.setProperty("--dyslexia-background", theme.background);
    root.style.setProperty("--dyslexia-text", theme.text);
}

let receivedSettingsUpdate = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "updateSettings" && message.settings) {
        receivedSettingsUpdate = true;
        applySettings(message.settings);
        sendResponse({ ok: true });
        return false;
    }
    if (message.action === "speechControl") {
        sendResponse(handleSpeechControl(message));
        return false;
    }
});

chrome.storage.local.get("dyslexiaSettings", (result) => {
    // A popup update can arrive before storage responds. In that case, keep the
    // newer settings instead of overwriting them with the startup snapshot.
    if (!receivedSettingsUpdate && result.dyslexiaSettings) applySettings(result.dyslexiaSettings);
});

// Settings are global in Chrome Storage. Keep already-open pages synchronized
// when a shortcut or popup changes them in another tab.
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.dyslexiaSettings?.newValue) return;
    receivedSettingsUpdate = true;
    applySettings(changes.dyslexiaSettings.newValue);
});
