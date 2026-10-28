# Character Rules

Characters are the runtime source of truth for agents. Each character lives in
`house/characters/<key>.yaml`; `house/organization.yaml` is only a descriptive
manifest.

## Required fields

- `nickname` — display name, unique across the roster
- `gender`
- `age` — integer from **18 to 120**
- `personality`
- `appearance`

## Optional fields

- `role` — free text (for example `parent`, `friend`, `sibling`, `spourse`, `sister_in_law`)
- `system_prompt` — second person, starting with "You are ..."
- `memory_enabled` — `true`/`false`
- Roleplay extras: `background`, `speech_style`, `motivations`, `relationship`,
  `behavior_rules`

Extra fields are preserved on edits and included in the assembled prompt.

## Boundaries

All characters are adults. No character may be younger than 18. Romantic or
mature scenes must involve consenting adults, and the model must never control
the user's actions, thoughts, or consent.
