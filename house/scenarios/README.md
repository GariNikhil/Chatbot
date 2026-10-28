# Scenarios

Files in this folder are **live story foundations**. A scenario is the whole
book: its premise, central relationship, tone, themes, recurring cast, and world
facts persist across every chapter. Scenes in `../scenes/` are the chapters
inside it; a scene opts in with its optional `scenario` field.

Manage scenarios from **Settings ▸ Scenarios** in the UI or with
`GET/POST /scenarios` and `PUT/DELETE /scenarios/:key`. Renaming a scenario
repoints its linked scenes. Deleting one unlinks those scenes instead of deleting
them, so every chapter keeps working as a standalone scene.

The scenario form lists every scene with an **Include all scenes** toggle. The
same bulk assignment is available over the API by passing a transient `scenes`
list, for example `PUT /scenarios/the_arranged_marriage {"scenes": ["The First
Meeting", "The Family Dinner"]}`. Listed chapters are linked, linked chapters
left out become standalone, and omitting `scenes` leaves membership unchanged.
The list itself is not stored in the scenario YAML.

While chatting, the **Chapter** bar above the messages lists every chapter of the
active scenario, so you can jump from one room or situation to another (Living
Room → Kitchen) without opening settings. Each chapter keeps its own history and
memories.

Scenes without a `scenario` field remain standalone. Each scene still keeps its
own conversation history and memories; the scenario supplies persistent story
context, not a shared transcript. Durable memories are stored in the vault under
`Memories/scenarios/<scenario>/<scene>/<character>/`, or
`Memories/standalone/<scene>/<character>/` for standalone scenes.

## Scenario shape

Only `name` is required. Sparse older templates still load.

```yaml
name: "The Arranged Marriage"
description: "Nick's family has arranged a marriage with Priya..."
genre: "Romance · Drama"
tone: "Warm, tense, slow-burn"
themes: "Duty vs. desire, family expectations"
premise: "An arranged marriage brings Nick and Priya together..."
relationship_dynamics: "They begin as polite strangers bound by family expectations."
central_conflict: "The engagement ceremony is approaching."
narrative_direction: "A slow-burn romance from awkward formality to genuine connection."
background: "The Sharma and Rao families have been close for years."
long_term_objectives: "Decide whether to continue the engagement."
opening_message: "The doorbell rings earlier than expected..."
participants:
  - Nick
  - Priya
world_card: "The City of Little Moments"
tag_selections:
  story_genres: [story_genres.romance]
  relationship_dynamics: [relationship_dynamics.arranged_marriage]
```

Any extra string or list fields are preserved and included in the scenario
prompt block. Scenario tags live in `tag_selections` and apply only at story
level; scene tags stay on each scene.

## Linking a chapter

```yaml
# ../scenes/the_first_meeting.yaml
name: "The First Meeting"
description: "Both families gather for the first proper meeting."
participants: [Nick, Priya, Mom, Dad]
location: "The Living Room"
scenario: the_arranged_marriage
```

The file key is the stable reference (`the_arranged_marriage`), but a scene may
also use the display name; it is resolved to the key on load. Older files with
non-slug filenames are normalized the same way (for example
`birthday party.yaml` → `birthday_party`).
