"use strict";

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

function safeError(message) {
    return String(message || "No provider error details.")
        .replace(process.env.GEMINI_API_KEY || "\0", "[redacted-key]")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 500);
}

async function main() {
    loadEnvFile();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.includes("replace_with")) {
        throw new Error("Set a real GEMINI_API_KEY in backend/.env before running this live provider check.");
    }
    const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
    const modelsUrl = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    modelsUrl.searchParams.set("pageSize", "1000");
    console.log(`Checking GET ${modelsUrl.origin}${modelsUrl.pathname} for models supporting generateContent...`);
    const modelsResponse = await fetch(modelsUrl, { headers: { "x-goog-api-key": apiKey } });
    const modelsPayload = await modelsResponse.json().catch(() => ({}));
    if (!modelsResponse.ok) {
        const detail = safeError(modelsPayload?.error?.message || `HTTP ${modelsResponse.status}`);
        throw new Error(`Models API failed with HTTP ${modelsResponse.status}: ${detail}`);
    }
    const supported = (modelsPayload.models || []).filter(item =>
        Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes("generateContent"));
    const canonicalModel = model.startsWith("models/") ? model : `models/${model}`;
    const selected = supported.find(item => item.name === canonicalModel);
    console.log(`Models API returned ${supported.length} model(s) with generateContent.`);
    if (!selected) {
        console.log(`Available model names: ${supported.map(item => item.name).join(", ") || "none"}`);
        throw new Error(`Configured model ${canonicalModel} is not available for this API key with generateContent. Set GEMINI_MODEL to a listed model.`);
    }
    console.log(`Selected model verified for this key: ${selected.name} (${selected.displayName || "no display name"}).`);

    const generateUrl = `https://generativelanguage.googleapis.com/v1beta/${canonicalModel}:generateContent`;
    console.log(`Testing POST ${generateUrl} with a fixed minimal prompt (no user transcript).`);
    const generateResponse = await fetch(generateUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
        },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }] })
    });
    const generatedPayload = await generateResponse.json().catch(() => ({}));
    if (!generateResponse.ok) {
        const detail = safeError(generatedPayload?.error?.message || `HTTP ${generateResponse.status}`);
        throw new Error(`generateContent failed with HTTP ${generateResponse.status}: ${detail}`);
    }
    const text = generatedPayload?.candidates?.[0]?.content?.parts
        ?.filter(part => typeof part.text === "string").map(part => part.text).join("").trim();
    if (!text) throw new Error("generateContent returned no text in its candidate response.");
    console.log(`Minimal text-generation check passed for ${selected.name}; response text was returned.`);
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
