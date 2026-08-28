import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();

function resolveObsidianDir() {
  if (process.env.OBSIDIAN_DIR) return process.env.OBSIDIAN_DIR;
  const candidates = [
    path.join(home, "Dropbox", "obsidian"),
    path.join(home, "Library", "CloudStorage", "Dropbox", "obsidian"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function parseArgs(args) {
  const positional = args.find((arg) => !arg.startsWith("--"));
  const inputIndex = args.indexOf("--input-dir");
  const inputDir = inputIndex >= 0 ? args[inputIndex + 1] : "";
  if (inputIndex >= 0 && !inputDir) throw new Error("--input-dir requires a directory path");
  return { id: positional || "jbbrc201702115", inputDir };
}

const { id, inputDir } = parseArgs(process.argv.slice(2));
const obsidianDir = resolveObsidianDir();
const baseDir = path.join(obsidianDir, "50_coding", "llamaindex");
const articleDir = path.join(baseDir, "article_sets");
const referenceDir = path.join(baseDir, "reference_sets");
const articlePath = path.join(articleDir, `${id}.json`);
const referencePath = path.join(referenceDir, `${id}.json`);
const articleInputPath = inputDir ? path.join(inputDir, "article.json") : articlePath;
const referenceInputPath = inputDir ? path.join(inputDir, "reference.json") : referencePath;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function paragraphs(content) {
  return String(content || "")
    .split(/\n\s*\n/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizedParagraphs(value, content) {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.map((item) => item.trim()).filter(Boolean);
  }
  return paragraphs(content);
}

function sectionType(title, originalType) {
  const value = String(title || "").trim();
  if (/^abstract$/i.test(value)) return "abstract";
  if (/highlight/i.test(value)) return "other";
  if (/keyword/i.test(value)) return "keywords";
  if (/^1\./.test(value) || /introduction/i.test(value)) return "intro";
  if (/^2\./.test(value) || /method|material|experimental/i.test(value)) return "methods";
  if (/^3\./.test(value) || /result|finding/i.test(value)) return "results";
  if (/^4\./.test(value) || /discussion|conclusion/i.test(value)) return "discussion";
  if (/reference/i.test(value)) return "references";
  if (/acknowledg/i.test(value)) return "acknowledgements";
  return originalType || "other";
}

function authorName(author) {
  if (typeof author === "string") return author.trim();
  if (author && typeof author === "object") {
    return String(author.name || `${author.given_names || ""} ${author.surname || ""}`).trim();
  }
  return "";
}

function sectionContent(section) {
  if (typeof section?.content === "string") return section.content.trim();
  if (typeof section?.text === "string") return section.text.trim();
  if (Array.isArray(section?.paragraphs)) return section.paragraphs.join("\n\n").trim();
  return "";
}

function normalizedSection(section, type) {
  const content = sectionContent(section);
  const subsectionSource = Array.isArray(section?.subsections) ? section.subsections : [];
  return {
    title: section?.title || "Untitled",
    type,
    content,
    paragraphs: normalizedParagraphs(section?.paragraphs, content),
    subsections: subsectionSource.map((subsection) => {
      const subsectionContent = sectionContent(subsection);
      return {
        title: subsection?.title || "Untitled",
        content: subsectionContent,
        paragraphs: normalizedParagraphs(subsection?.paragraphs, subsectionContent),
      };
    }),
  };
}

function normalizedSections(rawSections) {
  let inheritedType = "other";
  return rawSections.map((section) => {
    const detectedType = sectionType(section?.title, section?.type);
    const level = Number(section?.level ?? 1);
    const type = detectedType === "other" && level > 1 ? inheritedType : detectedType;
    if (level === 1 && detectedType !== "other") inheritedType = detectedType;
    return normalizedSection(section, type);
  });
}

function normalizeArticle(source) {
  if (source?.id && Array.isArray(source?.sections) && "chunkCount" in source) return source;

  // Supports both the legacy structured schema and the JATS intermediate schema
  // used when a publisher page is reconstructed from open full-text XML.
  const metadata = source?.metadata || {};
  const content = source?.content || {};
  const rawSections = Array.isArray(source?.sections)
    ? source.sections
    : Array.isArray(content.flat_sections)
      ? content.flat_sections
      : Array.isArray(content.sections)
        ? content.sections
        : [];
  const sections = normalizedSections(rawSections);
  const chunkCount = sections.reduce(
    (total, section) => total + section.paragraphs.length + section.subsections.reduce((sum, subsection) => sum + subsection.paragraphs.length, 0),
    0,
  );
  const publicationDates = Array.isArray(metadata.publication_dates) ? metadata.publication_dates : [];
  const published = String(source?.published || publicationDates.map((date) => date?.year || "").find(Boolean) || "");
  const rawAuthors = Array.isArray(source?.authors) ? source.authors : Array.isArray(metadata.authors) ? metadata.authors : [];
  const authors = rawAuthors.map(authorName).filter(Boolean);
  const sourceUrls = metadata.source_urls || {};

  return {
    id: source?.citekey || source?.id || id,
    sourceUrl: source?.sourceUrl || source?.source_location || sourceUrls.publisher || sourceUrls.pmc || (metadata.doi ? `https://doi.org/${metadata.doi}` : source?.doi ? `https://doi.org/${source.doi}` : ""),
    title: source?.title || metadata.title || id,
    authors,
    journal: source?.journal || source?.source || metadata.journal || "",
    year: (published.match(/\b(19|20)\d{2}\b/) || ["", ""])[0],
    doi: source?.doi || metadata.doi || "",
    createdAt: source?.converted_at || source?.createdAt || new Date().toISOString(),
    sections,
    chunkCount,
  };
}

function normalizeReferences(source, article) {
  if (source?.id && Array.isArray(source?.records) && "totalReferences" in source) return source;
  const sourceRecords = Array.isArray(source) ? source : source?.records || source?.references || [];
  const records = sourceRecords.map((record, offset) => {
    const metadata = record?.metadata || {};
    const doi = record?.doi || metadata.doi || "";
    return {
      index: Number(record?.index ?? record?.number ?? record?.position ?? offset + 1),
      text: String(record?.text || record?.raw_text || "").trim(),
      sourceUrl: article.sourceUrl,
      href: doi ? `https://doi.org/${doi}` : "",
      doi,
      pmid: record?.pmid || "",
      pubmedFound: Boolean(record?.pubmedFound),
    };
  }).filter((record) => record.text);
  return {
    id: article.id,
    sourceUrl: article.sourceUrl,
    title: article.title,
    createdAt: article.createdAt,
    totalReferences: records.length,
    pubmedFound: records.filter((record) => record.pubmedFound).length,
    abstractFound: records.filter((record) => record.pubmed?.abstract?.trim()).length,
    records,
  };
}

if (!fs.existsSync(articleInputPath) || !fs.existsSync(referenceInputPath)) {
  throw new Error(`Input files are required: ${articleInputPath} and ${referenceInputPath}`);
}

const article = normalizeArticle(readJson(articleInputPath));
const references = normalizeReferences(readJson(referenceInputPath), article);
if (!article.sections.length || !article.chunkCount) {
  throw new Error("Article conversion produced no searchable paragraphs; source JSON was not recognized.");
}
if (!references.records.length) {
  throw new Error("Reference conversion produced no records; source JSON was not recognized.");
}
writeJsonAtomically(articlePath, article);
writeJsonAtomically(referencePath, references);
console.log(JSON.stringify({
  id: article.id,
  articlePath,
  referencePath,
  articleSections: article.sections.length,
  searchableParagraphs: article.sections
    .filter((section) => !new Set(["references", "acknowledgements", "abbreviations", "keywords", "other"]).has(section.type))
    .reduce((total, section) => total + section.paragraphs.length + section.subsections.reduce((sum, subsection) => sum + subsection.paragraphs.length, 0), 0),
  references: references.totalReferences,
  referenceAbstracts: references.abstractFound,
}, null, 2));
