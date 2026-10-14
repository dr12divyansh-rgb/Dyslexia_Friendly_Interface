# Dyslexia-Friendly Reader

## Voice Chat with Google Gemini

Voice Chat sends the recognized transcript and up to 24 saved user/assistant messages to the backend URL configured in the Voice Chat panel. The Node backend calls Gemini and keeps `GEMINI_API_KEY` on the server. The extension contains no Gemini key. Chat history is stored in Chrome extension local storage and can be deleted with **Clear**.

### Run the backend locally

Requirements: Node.js 18 or newer and a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

1. Find the unpacked extension ID at `chrome://extensions` after loading this project.
2. In PowerShell, open this repository's `backend` folder and create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

3. In `backend/.env`, replace the key placeholder and extension ID:

   ```ini
   GEMINI_API_KEY=your_real_key_here
   GEMINI_MODEL=gemini-3.8-flash
   PORT=8787
   ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
   MAX_REQUESTS_PER_MINUTE=12
   ```

   Do not commit or share `backend/.env`. It is ignored by Git. The checked-in `.env.example` contains placeholders only. You may list multiple exact extension origins separated by commas.
4. Start the server from the `backend` folder:

   ```powershell
   node server.js
   ```

   The server reports whether the key is configured; it never prints the key. `GET http://localhost:8787/api/health` reports backend configuration status.
5. Before using Voice Chat, independently test the configured key and model from the `backend` folder:

   ```powershell
   npm run test:gemini
   ```

   The check calls `GET /v1beta/models`, selects only models whose `supportedGenerationMethods` contains `generateContent`, and then sends a fixed minimal prompt to the documented `POST /v1beta/models/MODEL_NAME:generateContent` URL. It does not send saved chat history or microphone transcripts. It reports errors without printing the key.
6. Open Voice Chat with **Alt+Shift+V**. Enter `http://localhost:8787` as the Backend URL and click **Test backend**. Approve the Chrome host permission prompt. This checks the extension-to-backend health route and asks the backend to verify the selected model against the Models API for its configured key. Then speak a message. For a deployed service, enter its HTTPS base URL instead.

No server dependencies need installing; this backend uses Node's built-in HTTP server and `fetch`.

### Backend behavior and deployment

- `POST /api/chat` validates the transcript and history, limits request size, applies an in-memory per-IP rate limit, and returns `{ "ok": true, "reply": "…", "model": "…" }`.
- `GET /api/models` queries the official Models API with the backend key and lists only models that explicitly support `generateContent`. The backend checks `GEMINI_MODEL` against that list before generating text (cached for five minutes).
- Server logs identify incoming backend method/path/status and upstream Gemini status plus a sanitized provider error. They never log request bodies, transcripts, or API keys.
- The backend maps Gemini authentication, quota, timeout, connectivity, invalid-response, and empty-response errors to short messages. API keys and prompts are not logged.
- CORS allows only the exact origins listed in `ALLOWED_EXTENSION_ORIGINS`. CORS is a browser policy, **not authentication**.
- For hosting, deploy this Node service to a Node 18+ host that provides HTTPS and inject `GEMINI_API_KEY` from that host's secret manager. Set `GEMINI_MODEL`, `PORT`, and `ALLOWED_EXTENSION_ORIGINS` in the hosting environment. Do not put the Gemini key in the extension, a frontend config file, or a public repository. Use the extension ID users will run (for a published extension, its stable Chrome Web Store ID).
- The in-memory request limiter is useful for local development and a single-process trial, but it resets on restart and is not distributed. **Before making a backend publicly reachable, add real user authentication and enforce per-user quotas/usage limits** (for example, a signed user token verified by the server, plus a managed API gateway or shared rate-limit store). Do not treat an obscure URL, CORS, or the extension ID as access control.
- `GEMINI_MODEL` defaults to `gemini-3.8-flash`; use a currently available text model for your Google project. Gemini availability, quotas, and billing depend on that project.

### Voice behavior and privacy

- Microphone recognition starts only after the user presses **Alt+Shift+V** or **Start listening**.
- Pressing **Alt+Shift+V** while the AI is processing or speaking aborts that request, cancels queued speech, and starts a fresh listening run. Old responses are ignored.
- Saying **“read aloud the conversation”** reads this extension panel's stored conversation locally. It does not send that command to Gemini and does not scrape ChatGPT or arbitrary webpage conversations.
- The browser's speech-recognition implementation may process microphone audio through its own recognition service. The recognized transcript and chat history are sent to the configured backend and then to Gemini.

### Chrome testing

1. Start the backend and confirm `/api/health` reports `geminiConfigured: true`.
2. Reload the extension at `chrome://extensions`, open Voice Chat, enter the backend URL, and use **Test backend**. Approve the requested host access.
3. Press **Alt+Shift+V**, speak a short question, and verify its transcript appears, Gemini's reply is shown, and speech synthesis reads it aloud.
4. Start a longer response and press **Alt+Shift+V**. Confirm speech stops and a new listening session begins; an older reply should not appear or play afterward.
5. Say **“read aloud the conversation”** and verify the existing extension-panel messages are read locally.
6. Stop the backend or temporarily remove the key, then retry. The panel should show a backend connection or missing-key message.
7. Check invalid URL, denied host permission, empty speech, and quota failures for readable errors.

## Official API references

- [Gemini API generateContent REST reference](https://ai.google.dev/api/generate-content)
- [Gemini API key guidance](https://ai.google.dev/gemini-api/docs/generate-content/api-key)
- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Chrome optional host permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
