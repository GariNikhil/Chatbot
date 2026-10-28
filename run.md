# Chatbot — Local Run Setup

## 1. Start LM Studio

Open a terminal and start the local inference server:

```bash
lms server start
lms load qwen3-4b
```

The OpenAI-compatible endpoint defaults to `http://127.0.0.1:1234/v1`.
Use `LMSTUDIO_BASE_URL` in `.env` if yours runs on a different port or host.

## 2. Start Chatbot

From the repository root:

```bash
cd server
npm install    # first run only
npm start
```

The server listens on `http://127.0.0.1:3001` by default. Open that URL in a
browser to use the workspace UI. Set `PORT` or `HOST` in `.env` to change
the bind address. Keep the default loopback binding unless you intentionally
want LAN access.

## Windows shortcut

`start.bat` and `stop.bat` at the repository root automate starting and
stopping the server. They expect LM Studio to be installed and `lms` on `PATH`.
You can also stop the server from the UI with **Settings ▸ End session**.
