# Chatbot

A local, multi-agent chatbot system with a visual workspace UI for simulating conversations with AI characters in custom scenarios and scenes. Built for use with local LLMs like [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/).

## Features

- **Multi-Agent Conversations** - Chat with multiple AI characters, each with their own personality, role, and behavior defined in YAML
- **Group Chat** - Have all participants in a scene respond in a shared timeline, with mentioned characters answering first
- **Scenarios & Scenes** - Create stories with premises, relationships, and chapter-based scenes that build on each other
- **World Cards** - Add dynamic world-building elements (genres, locations, events) that influence agent responses
- **Tag System** - Categorize characters, scenarios, scenes, and world cards with a searchable tag picker
- **Memory System** - Conversations are automatically saved to an Obsidian-compatible vault, organized by story, chapter, and character
- **Visual Workspace UI** - Clean, browser-based interface with sidebar navigation, chapter jumping, and scene management
- **Local-First** - Runs entirely on your machine, uses local LLMs with no external API calls required
- **OpenAI-Compatible** - Works with any OpenAI-compatible API endpoint (LM Studio, Ollama, etc.)

## Tech Stack

- **Backend**: Node.js (ES modules) HTTP server with streaming chat support
- **Frontend**: Vanilla HTML, CSS, and JavaScript (no build step required)
- **Data Storage**: YAML files for characters, scenes, scenarios, and world cards
- **Memory**: Markdown files with frontmatter, Obsidian-compatible
- **LLM Integration**: OpenAI-compatible API (streaming)

## Project Structure

```text
Chatbot/
├── docs/                    # Documentation (PRD, design docs, roadmap, tasks)
├── ui/                      # Workspace chat UI (static HTML/CSS/JS)
├── server/                  # Local API server (loaders, prompt assembly, streaming)
├── house/                   # Agent definitions and world building
│   ├── organization.yaml   # Household manifest (reference only)
│   ├── characters/         # Character definitions (runtime source of truth)
│   ├── scenarios/          # Story premises and relationships
│   ├── scenes/             # Chapters/locations with participants
│   ├── world cards/        # World-building cards (genre, location, events)
│   └── tags.yaml           # Canonical tag catalog
├── workspace/              # Runtime data (gitignored)
├── .env.example            # Environment variable template
├── start.bat               # Quick start script (Windows)
├── stop.bat                # Stop server script (Windows)
└── README.md
```

## Prerequisites

- [Node.js](https://nodejs.org/) v22 or higher
- A local LLM provider:
  - [LM Studio](https://lmstudio.ai/) (recommended) - runs on `http://localhost:1234`
  - [Ollama](https://ollama.com/) - runs on `http://localhost:11434`

## Quick Start (Windows)

The easiest way to get started is with the provided batch scripts:

1. Clone this repository
2. Copy `.env.example` to `.env` in the `Chatbot/` directory and configure your provider
3. Double-click `start.bat` - this will:
   - Check for LM Studio and start it if needed (loading `qwen3-4b`)
   - Start the Chatbot server on port `3001`
   - Open the workspace UI in your browser

To stop the server, use `stop.bat` or click **Settings → End Session** in the UI.

## Manual Installation

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd Chatbot
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` to configure your LLM provider:

   ```env
   LLM_PROVIDER=lmstudio        # or 'ollama'
   LLM_BASE_URL=http://127.0.0.1:1234/v1
   LLM_MODEL=local-model
   ```

3. **Start your LLM provider**

   - **LM Studio**: Open LM Studio, load a model (e.g., `qwen3-4b`), and start the local server
   - **Ollama**: Run `ollama serve` and pull a model with `ollama pull qwen3:4b`

4. **Install dependencies and start the server**

   ```bash
   cd server
   npm install
   npm start
   ```

5. **Open the UI**

   Navigate to [http://localhost:3001](http://localhost:3001) in your browser.

## Usage

### Creating Characters

1. Go to **Settings → Characters** in the UI
2. Fill out the character form with name, role, personality traits, etc.
3. Characters are saved to `house/characters/` and become available immediately

### Creating Scenarios and Scenes

1. **Settings → Scenarios** - Create an overall story with a premise, relationships, and tags
2. **Settings → Scenes** - Create chapters within stories or standalone scenes, assign participants, and link to scenarios
3. Use the **Chapter** bar to navigate between scenes in a story

### World Cards

1. Go to **Settings → World Cards** to create cards that add context (genre, location shifts, events)
2. Toggle active world cards from **Settings → World Cards** while chatting
3. Active cards influence all agent responses

### Group Chat

1. Select a scene with multiple participants
2. Enable **Group Chat** in the Agents panel
3. All AI characters in the scene will respond in sequence to shared messages

### Memories

- Conversations are automatically saved when chatting with memory-enabled characters
- Browse memories in **Settings → Memories**, organized by story → chapter → character
- Memories are stored as Obsidian-compatible Markdown in your vault (or `workspace/memory/` by default)
- Delete individual memories via the UI or API

## API Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Server and provider health status |
| `GET` | `/agents` | List all characters/agents |
| `GET` | `/scenes` | List all scenes |
| `GET` | `/scenarios` | List all scenarios |
| `GET` | `/cards` | List world cards |
| `GET` | `/tags` | List tag catalog (filter with `?target=character\|scenario\|scene\|card`) |
| `GET` | `/models` | List loaded models from LLM provider |
| `POST` | `/chat` | Stream chat responses (supports single agent or group chat) |
| `POST/PUT/DELETE` | `/characters/*` | Character CRUD operations |
| `POST/PUT/DELETE` | `/scenes/*` | Scene CRUD operations |
| `POST/PUT/DELETE` | `/scenarios/*` | Scenario CRUD operations |
| `POST/PUT/PATCH` | `/cards/*` | World card operations |
| `GET/DELETE` | `/memories/*` | Memory browsing and deletion |
| `POST` | `/shutdown` | Gracefully stop the server |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Server bind address (use `0.0.0.0` for LAN access) |
| `PORT` | `3001` | Server port |
| `LLM_PROVIDER` | `lmstudio` | Provider type (`lmstudio` or `ollama`) |
| `LLM_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible API base URL |
| `LLM_MODEL` | `local-model` | Default model name |
| `CORS_ORIGIN` | `http://localhost:3001` | Allowed CORS origin |
| `MAX_BODY_BYTES` | `1048576` | Max request body size (1MB) |
| `OBSIDIAN_VAULT_PATH` | _(empty)_ | Path to Obsidian vault for memories (uses `workspace/memory/` if empty) |

## Testing

Run the server tests:

```bash
cd server
npm test
```

## Documentation

See the [`docs/`](./docs/) directory for detailed documentation:

- [PRD.md](./docs/PRD.md) - Product requirements and specifications
- [DESIGN.md](./docs/DESIGN.md) - System architecture and data models
- [PLAN.md](./docs/PLAN.md) - Development plan and milestones
- [ROADMAP.md](./docs/ROADMAP.md) - Timeline and dependencies
- [TASKS.md](./docs/TASKS.md) - Task checklist and progress
- [RULES.md](./docs/RULES.md) - Conventions and guidelines

## License

This project is licensed under the terms specified in the [LICENSE](./LICENSE) file.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on contributing to this project.
