// Tag catalog and helpers.
//
// The single canonical tag source is house/tags.yaml. Selected tags are stored
// on characters/scenes/scenarios/cards as
// `tag_selections: { categoryId: [tagId, ...] }`
// using the stable ids returned by listTagCategories(). Unknown ids are kept on
// save (so deleting a tag never destroys authored data) but ignored by prompts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HOUSE_DIR = path.resolve(
  process.env.AI_HOUSE_ROOT ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "house"),
);
const TAGS_FILE = path.join(HOUSE_DIR, "tags.yaml");
const VALID_TARGETS = new Set(["character", "scene", "scenario", "card"]);

export class TagValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Normalizes raw YAML into a stable catalog. Malformed categories/tags are
// skipped with a warning rather than breaking chat or every entity list.
function normalizeCatalog(data) {
  const rawCategories = Array.isArray(data?.categories) ? data.categories : [];
  const seenCategories = new Set();
  const categories = [];

  for (const raw of rawCategories) {
    const id = asText(raw?.id);
    const label = asText(raw?.label) || id;
    if (!id || !/^[a-z0-9_]+$/.test(id) || seenCategories.has(id)) {
      console.warn(`tags.yaml: skipping invalid/duplicate category "${id}"`);
      continue;
    }
    const appliesTo = Array.isArray(raw?.applies_to)
      ? [...new Set(raw.applies_to.map(asText).filter((target) => VALID_TARGETS.has(target)))]
      : [];
    if (!appliesTo.length) {
      console.warn(`tags.yaml: category "${id}" has no valid applies_to; skipping`);
      continue;
    }
    const seenTags = new Set();
    const tags = [];
    for (const rawTag of Array.isArray(raw?.tags) ? raw.tags : []) {
      const tagId = asText(rawTag?.id);
      const tagLabel = asText(rawTag?.label) || tagId;
      if (!tagId || !/^[a-z0-9_]+$/.test(tagId) || seenTags.has(tagId)) {
        console.warn(`tags.yaml: skipping invalid/duplicate tag "${tagId}" in "${id}"`);
        continue;
      }
      seenTags.add(tagId);
      tags.push({ id: `${id}.${tagId}`, label: tagLabel });
    }
    if (!tags.length) {
      console.warn(`tags.yaml: category "${id}" has no tags; skipping`);
      continue;
    }
    seenCategories.add(id);
    categories.push({
      id,
      label,
      appliesTo,
      multiple: raw?.multiple !== false,
      tags,
    });
  }

  return { version: Number(data?.version) || 1, categories };
}

export function loadTagCatalog() {
  if (!fs.existsSync(TAGS_FILE)) {
    console.warn(`Tag catalog not found at ${TAGS_FILE}`);
    return { version: 1, categories: [] };
  }
  try {
    const raw = yaml.load(fs.readFileSync(TAGS_FILE, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("tags.yaml must contain a mapping");
    }
    return normalizeCatalog(raw);
  } catch (err) {
    console.warn(`Unable to load tags.yaml: ${err.message}`);
    return { version: 1, categories: [] };
  }
}

// Full catalog for GET /tags and the UI picker.
export function listTagCategories(target = null) {
  const { categories } = loadTagCatalog();
  if (!target) return categories;
  return categories.filter((category) => category.appliesTo.includes(target));
}

// Accepts only the documented shape and keeps unknown ids for round-tripping.
export function normalizeTagSelections(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TagValidationError(`"tag_selections" must be an object of category ids to tag ids`);
  }
  const selections = {};
  for (const [categoryId, tagIds] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(categoryId)) continue;
    if (!/^[a-z0-9_]+$/.test(categoryId)) {
      throw new TagValidationError(`Invalid tag category "${categoryId}"`);
    }
    if (!Array.isArray(tagIds)) {
      throw new TagValidationError(`"tag_selections.${categoryId}" must be a list of tag ids`);
    }
    const unique = [];
    for (const tagId of tagIds) {
      if (typeof tagId !== "string" || !tagId.trim()) {
        throw new TagValidationError(`"tag_selections.${categoryId}" must contain text tag ids`);
      }
      const trimmed = tagId.trim();
      if (!unique.includes(trimmed)) unique.push(trimmed);
    }
    if (unique.length) selections[categoryId] = unique;
  }
  return selections;
}

// Resolves stored ids to readable labels, grouped by category. Unknown ids are
// silently ignored (for example after deleting a tag from tags.yaml).
export function describeTagSelections(selections) {
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) return [];
  const catalog = loadTagCatalog();
  const byId = new Map();
  for (const category of catalog.categories) {
    for (const tag of category.tags) byId.set(tag.id, { category, label: tag.label });
  }

  const described = [];
  for (const [categoryId, tagIds] of Object.entries(selections)) {
    if (!Array.isArray(tagIds)) continue;
    const category = catalog.categories.find((candidate) => candidate.id === categoryId);
    if (!category) continue;
    const labels = [];
    for (const tagId of tagIds) {
      const match = byId.get(String(tagId));
      if (match && match.category.id === categoryId && !labels.includes(match.label)) {
        labels.push(match.label);
      }
    }
    if (labels.length) described.push({ categoryId, categoryLabel: category.label, labels });
  }
  return described;
}

// One line per category, ready for the prompt assembler.
export function tagSelectionLines(selections) {
  return describeTagSelections(selections).map(
    ({ categoryLabel, labels }) => `${categoryLabel}: ${labels.join(", ")}`,
  );
}

export function tagsForTarget(target, selections) {
  return describeTagSelections(selections).filter(({ categoryId }) =>
    listTagCategories(target).some((category) => category.id === categoryId),
  );
}
