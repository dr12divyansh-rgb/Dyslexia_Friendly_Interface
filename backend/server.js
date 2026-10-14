"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function loadEnvFile() {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (match && !Object.hasOwn(process.env, match[1])) {
            process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
        }
    }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_HISTORY_MESSAGES = 24;
const MAX_TEXT_LENGTH = 12000;
const MAX_HISTORY_CHARACTERS = 30000;
const MAX_REQUESTS_PER_MINUTE = Math.max(1, Number(process.env.MAX_REQUESTS_PER_MINUTE || 12));
const allowedOrigins = new Set((process.env.ALLOWED_EXTENSION_ORIGINS || "")
    .split(",").map(origin => origin.trim()).filter(Boolean));
const rateBuckets = new Map();
let cachedModels = null;

function sendJson(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers
    });
    res.end(body);
}

function applyCors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!allowedOrigins.has(origin)) return false;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    return true;
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let tooLarge = false;
        const chunks = [];
        req.on("data", chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            if (!tooLarge) chunks.push(chunk);
        });
        req.on("end", () => {
            if (tooLarge) {
                reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
                return;
            }
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch { reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 })); }
        });
        req.on("error", reject);
    });
}

function getClientKey(req) {
    // Do not trust arbitrary X-Forwarded-For values supplied by clients.
    return req.socket.remoteAddress || "unknown";
}

function isRateLimited(req) {
    const now = Date.now();
    const key = getClientKey(req);
    const bucket = rateBuckets.get(key) || { start: now, count: 0 };
    if (now - bucket.start >= 60000) {
        bucket.start = now;
        bucket.count = 0;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (rateBuckets.size > 10000) {
        for (const [client, value] of rateBuckets) {
            if (now - value.start >= 60000) rateBuckets.delete(client);
        }
    }
    return bucket.count > MAX_REQUESTS_PER_MINUTE;
}

function normalizeChat(body) {
    const transcript = typeof body?.transcript === "string" ? body.transcript.trim() : "";
    if (!transcript) throw Object.assign(new Error("Enter or speak a message before sending."), { status: 400 });
    if (transcript.length > MAX_TEXT_LENGTH) throw Object.assign(new Error("That message is too long. Please shorten it."), { status: 413 });

    const history = [];
    let characters = transcript.length;
    const submitted = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_MESSAGES) : [];
    for (const entry of submitted) {
        if (!entry || !["user", "assistant"].includes(entry.role) || typeof entry.content !== "string") continue;
        const content = entry.content.trim().slice(0, MAX_TEXT_LENGTH);
        if (!content || characters + content.length > MAX_HISTORY_CHARACTERS) continue;
        characters += content.length;
        history.push({
            role: entry.role === "assistant" ? "model" : "user",
            parts: [{ text: content }]
        });
    }
    history.push({ role: "user", parts: [{ text: transcript }] });
    return history;
}

function sanitizeProviderMessage(value, sensitiveValues = []) {
    let message = String(value || "Gemini returned no error details.")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]");
    if (process.env.GEMINI_API_KEY) message = message.replaceAll(process.env.GEMINI_API_KEY, "[redacted-key]");
    for (const sensitive of sensitiveValues) {
        if (typeof sensitive === "string" && sensitive.length >= 3) {
            message = message.replaceAll(sensitive, "[redacted-input]");
        }
    }
    return message.slice(0, 500);
}

async function readGeminiError(response, sensitiveValues = []) {
    let payload;
    try { payload = await response.json(); }
    catch { return { code: "unknown", message: `Gemini returned HTTP ${response.status} with a non-JSON error body.` }; }
    const code = payload?.error?.status || String(response.status);
    const message = sanitizeProviderMessage(payload?.error?.message, sensitiveValues);
    return { code, message };
}

function getModelId() {
    return GEMINI_MODEL.replace(/^models\//, "");
}

async function listGeminiModels(signal) {
    if (cachedModels && Date.now() - cachedModels.checkedAt < 5 * 60 * 1000) {
        return { ok: true, supportedModels: cachedModels.supportedModels };
    }
    const models = [];
    let pageToken = "";
    for (let page = 0; page < 10; page += 1) {
        const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
        url.searchParams.set("pageSize", "1000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const response = await fetch(url, {
            method: "GET",
            headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
            signal
        });
        if (!response.ok) {
            const error = await readGeminiError(response);
            console.error(`[Gemini] models.list HTTP ${response.status}; code=${error.code}; message="${error.message}"`);
            return { ok: false, status: response.status, error };
        }
        const payload = await response.json();
        if (Array.isArray(payload.models)) models.push(...payload.models);
        pageToken = payload.nextPageToken || "";
        if (!pageToken) break;
    }
    const supportedModels = models
        .filter(model => Array.isArray(model.supportedGenerationMethods)
            && model.supportedGenerationMethods.includes("generateContent"))
        .map(model => ({ name: model.name, displayName: model.displayName }))
        .filter(model => typeof model.name === "string");
    cachedModels = { checkedAt: Date.now(), supportedModels };
    return { ok: true, supportedModels };
}

async function handleChat(req, res) {
    if (isRateLimited(req)) {
        return sendJson(res, 429, { ok: false, error: { code: "rate_limited", message: "Too many requests. Wait a minute and try again." } });
    }
    if (!process.env.GEMINI_API_KEY) {
        return sendJson(res, 503, { ok: false, error: { code: "gemini_not_configured", message: "Gemini is not configured on the backend. Set GEMINI_API_KEY in backend/.env and restart the server." } });
    }

    let contents;
    try { contents = normalizeChat(await readJson(req)); }
    catch (error) {
        return sendJson(res, error.status || 400, { ok: false, error: { code: "invalid_request", message: error.message || "Invalid request." } });
    }

    const abortController = new AbortController();
    const abortIfClientLeaves = () => {
        if (!res.writableEnded) abortController.abort();
    };
    req.once("aborted", abortIfClientLeaves);
    res.once("close", abortIfClientLeaves);
    const timeout = setTimeout(() => abortController.abort(), 60000);
    try {
        const modelCheck = await listGeminiModels(abortController.signal);
        if (abortController.signal.aborted) return;
        if (!modelCheck.ok) {
            const status = modelCheck.status === 401 || modelCheck.status === 403 ? 502 : modelCheck.status === 429 ? 429 : 502;
            return sendJson(res, status, { ok: false, error: { code: "gemini_models_failed", message: `Could not verify GEMINI_MODEL against this API key (upstream HTTP ${modelCheck.status}). ${modelCheck.error.message}` } });
        }
        if (!modelCheck.supportedModels.some(model => model.name === `models/${GEMINI_MODEL}` || model.name === GEMINI_MODEL)) {
            const choices = modelCheck.supportedModels.map(model => model.name.replace(/^models\//, "")).slice(0, 12).join(", ");
            console.error(`[Gemini] configured model ${GEMINI_MODEL} is not listed with generateContent support for this key`);
            return sendJson(res, 400, { ok: false, error: { code: "model_not_supported", message: `GEMINI_MODEL "${GEMINI_MODEL}" is not available for this API key with generateContent. Available examples: ${choices || "none returned"}.` } });
        }
    
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(getModelId())}:generateContent`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: "You are a helpful, concise reading assistant. Use clear, accessible language and answer the user's request directly." }] },
                contents,
                generationConfig: { maxOutputTokens: 2048 }
            }),
            signal: abortController.signal
        });
        if (abortController.signal.aborted) return;
        if (!response.ok) {
            const providerError = await readGeminiError(response, contents.map(item => item.parts?.[0]?.text));
            console.error(`[Gemini] generateContent HTTP ${response.status}; model=${GEMINI_MODEL}; code=${providerError.code}; message="${providerError.message}"`);
            const messages = {
                400: "Gemini rejected the request. Check the model configuration or try a shorter message.",
                401: "Gemini did not accept the backend API key. Check GEMINI_API_KEY.",
                403: "Gemini denied access. Check the API key, Gemini API enablement, and project quota settings.",
                404: "The configured Gemini model was not found. Check GEMINI_MODEL.",
                429: "Gemini quota or rate limit reached. Check your Google AI Studio project limits and try again later."
            };
            const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : response.status === 401 || response.status === 403 ? 502 : response.status === 404 ? 502 : 502;
            return sendJson(res, status, {
                ok: false,
                error: {
                    code: response.status === 429 ? "gemini_rate_limited" : "gemini_request_failed",
                    message: `${messages[response.status] || "Gemini could not complete the request."} Gemini detail: ${providerError.message}`
                }
            });
        }

        let result;
        try { result = await response.json(); }
        catch { return sendJson(res, 502, { ok: false, error: { code: "invalid_provider_response", message: "Gemini returned an invalid response. Please try again." } }); }
        const reply = result?.candidates?.[0]?.content?.parts
            ?.filter(part => typeof part.text === "string")
            .map(part => part.text).join("").trim();
        if (!reply) return sendJson(res, 502, { ok: false, error: { code: "empty_provider_response", message: "Gemini returned no text. Please rephrase your request and try again." } });
        return sendJson(res, 200, { ok: true, reply, model: GEMINI_MODEL });
    } catch (error) {
        if (abortController.signal.aborted) {
            if (!res.writableEnded && !res.destroyed) {
                sendJson(res, 504, { ok: false, error: { code: "gemini_timeout", message: "Gemini took too long to respond. Please try again." } });
            }
            return;
        }
        console.error(`[Gemini] upstream request failed; message="${sanitizeProviderMessage(error.message)}"`);
        sendJson(res, 502, { ok: false, error: { code: "gemini_connection_failed", message: "The backend could not connect to Gemini. Check backend network access and try again." } });
    } finally {
        clearTimeout(timeout);
        req.removeListener("aborted", abortIfClientLeaves);
        res.removeListener("close", abortIfClientLeaves);
    }
}

const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    res.once("finish", () => console.log(`[Backend] ${req.method} ${pathname} -> HTTP ${res.statusCode}`));
    if (!applyCors(req, res)) {
        return sendJson(res, 403, { ok: false, error: { code: "origin_denied", message: "This extension origin is not allowed by the backend." } });
    }
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
        const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
        return sendJson(res, 200, {
            ok: true,
            geminiConfigured,
            model: GEMINI_MODEL,
            ...(!geminiConfigured ? { message: "Gemini API key is not configured on the backend. Set GEMINI_API_KEY in backend/.env and restart the server." } : {})
        });
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/models") {
        if (!process.env.GEMINI_API_KEY) {
            return sendJson(res, 503, { ok: false, error: { code: "gemini_not_configured", message: "Gemini is not configured on the backend. Set GEMINI_API_KEY and restart the server." } });
        }
        try {
            const result = await listGeminiModels();
            if (!result.ok) {
                const status = result.status === 401 || result.status === 403 ? 502 : result.status === 429 ? 429 : 502;
                return sendJson(res, status, { ok: false, error: { code: "gemini_models_failed", message: `Could not list models for the configured Gemini key (upstream HTTP ${result.status}). ${result.error.message}` } });
            }
            const configuredModel = `models/${GEMINI_MODEL}`;
            const configuredModelSupported = result.supportedModels.some(model => model.name === configuredModel || model.name === GEMINI_MODEL);
            return sendJson(res, 200, {
                ok: true,
                model: GEMINI_MODEL,
                configuredModelSupported,
                supportedModels: result.supportedModels
            });
        } catch (error) {
            console.error(`[Gemini] models.list request failed; message="${sanitizeProviderMessage(error.message)}"`);
            return sendJson(res, 502, { ok: false, error: { code: "gemini_models_unavailable", message: "Could not contact the Gemini Models API. Check backend network access and try again." } });
        }
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/chat") return handleChat(req, res);
    return sendJson(res, 404, { ok: false, error: { code: "not_found", message: "Route not found." } });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Gemini backend listening on port ${PORT}; configured=${Boolean(process.env.GEMINI_API_KEY)}; model=${GEMINI_MODEL}`);
});

server.requestTimeout = 15000;
server.headersTimeout = 20000;
