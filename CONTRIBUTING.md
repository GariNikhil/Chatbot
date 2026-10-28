# Chatbot — Contributing & Onboarding

Chatbot is a local-first, hierarchical multi-agent chat application. All LLM inference runs locally via **LM Studio**, and durable memory is stored in an **Obsidian** vault. The app will not run end-to-end without those two pieces installed.

## Prerequisites

Before contributing, install and configure the following:

### 1. LM Studio (local LLM inference)

- Download and install [LM Studio](https://lmstudio.ai/) (free, macOS/Windows/Linux).
- Start the local inference server: `lms server start` (port `1234` by default).
- Load a model, e.g. `lms load qwen3-4b`.
- Verify the server is reachable: `http://localhost:1234/v1/models` should return a JSON list of loaded models.

### 2. Obsidian (durable memory / knowledge base)

- Download and install [Obsidian](https://obsidian.md/) (free for personal use).
- Create or point to a vault folder. Set its absolute path in `.env`:
  ```
  OBSIDIAN_VAULT_PATH=/absolute/path/to/your/vault
  ```
  Memories are written to
  `<vault>/Chatbot/Memories/scenarios/<story>/<chapter>/<character>/<date>.md`,
  or `standalone/<chapter>/<character>/` for scenes without a story. Legacy
  `Memories/<character>/<date>.md` files remain readable.
- If `OBSIDIAN_VAULT_PATH` is unset, the server falls back to
  `workspace/memory` inside the server directory. Memory writes are best-effort:
  a failed write is logged but never fails a completed chat reply.

## Install & Run

```bash
# 1. Clone / open the repository (any local path works)
cd /path/to/Chatbot

# 2. Copy environment template and adjust paths
cp .env.example .env          # Windows: copy .env.example .env
# Edit .env to set LMSTUDIO_BASE_URL, LMSTUDIO_MODEL, CORS_ORIGIN,
# HOST, PORT, and OBSIDIAN_VAULT_PATH

# 3. Install server dependencies
cd server
npm install

# 4. Start the local API
npm start
# Server runs on http://127.0.0.1:3001 by default

# 5. Verify readiness
# http://127.0.0.1:3001/health  (should report LM Studio reachable)

# 6. Open the workspace UI
# http://127.0.0.1:3001/
```

The server binds to loopback only. Set `HOST=0.0.0.0` only when you intend to
expose it to other machines on your LAN.

There are also `start.bat` and `stop.bat` at the repo root that automate LM Studio + server startup/shutdown.

## Repository Layout

```
Chatbot/
├── docs/              # PRD, plan, phases, roadmap, design, tasks, rules
├── house/             # Manifest, characters/, scenes/, scenarios/, world cards/
├── server/            # Node.js HTTP API (index.js + lib/)
├── ui/                # workspace static chat UI
├── workspace/         # Runtime data (gitignored)
├── .opencode/         # OpenCode state (gitignored)
├── opencode.json      # OpenCode config (LM Studio provider)
├── .env.example       # Environment variable template
├── .gitignore         # Git ignore rules
├── readme.md          # Product README
└── CONTRIBUTING.md    # This file
```

## Coding Conventions

See `docs/RULES.md` for the full convention document. Key points:

- **Config-driven**: Characters, scenarios, scenes, and cards live in YAML under `house/`. No hardcoded agents.
  `house/characters/` is the runtime source of truth; `organization.yaml` is a
  descriptive manifest that the server does not read.
- **Local-first**: No cloud LLM APIs. All inference via LM Studio at `http://127.0.0.1:1234/v1`.
- **File naming** (`docs/RULES.md` §2): lowercase, slugified, `.yaml` extension.
  - Characters: `house/characters/<nickname>.yaml` (e.g. `mom.yaml`)
  - Scenarios: `house/scenarios/<name>.yaml` (e.g. `the_arranged_marriage.yaml`)
  - Scenes: `house/scenes/<name>.yaml` (e.g. `living_room_evening.yaml`)
  - Cards: `house/world cards/<name>.yaml` (e.g. `rainy_evening.yaml`)
- **YAML fields** (`docs/RULES.md` §3): snake_case keys; required character fields are `nickname`, `gender`, `age`, `personality`, `appearance`. Age must be an integer from 18 to 120.
- **System prompts** must be written in second person (`"You are..."`).
- **Commits**: conventional commits (`feat(scope): description`, `fix(scope): description`, etc.).
- **Branches**: `<type>/<short-description>` (e.g. `feat/core-chat`, `fix/memory-retrieval`).

## Testing

```bash
cd server
npm test
```

The suite runs 42 tests (all passing) against a mock LM Studio server, covering
config parsing, agent/scene/card loading, prompt assembly, SSE streaming chat,
model discovery, character/scene/card CRUD, memory read/write and scoping, and
smoke endpoints. Integration tests copy `house/` to a temporary directory via
`AI_HOUSE_ROOT`, so running them never mutates authored content.

## Submitting Changes

1. Create a feature branch: `git checkout -b feat/your-feature`
2. Make your changes (config + code + tests + docs).
3. Run `npm test` and ensure all tests pass.
4. Update `docs/PRD.md` and `docs/DESIGN.md` if behavior changes (`docs/RULES.md` §8).
5. Commit with a conventional commit message.
6. Demo the change to Nick (the user) for user-facing features.

## Definition of Done

Per `docs/RULES.md` §9:
- [ ] Code/config written and reviewed
- [ ] Tests pass (manual or automated)
- [ ] Docs updated (if applicable)
- [ ] Committed with conventional commit message
- [ ] Demoed to Nick (for user-facing features)

## Prohibited Practices

Per `docs/RULES.md` §10:
- ❌ No hardcoded agent responses (all generation via LM Studio)
- ❌ No cloud LLM API calls (OpenAI, Anthropic, etc.)
- ❌ No committed secrets or `.env` files with real values
- ❌ No runtime behaviour added to `house/organization.yaml` — agent data belongs in `house/characters/`