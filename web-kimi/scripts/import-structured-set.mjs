import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const obsidianDir = process.env.OBSIDIAN_DIR || path.join(home, "Dropbox", "obsidian");
const baseDir = path.join(obsidianDir, "50_coding", "llamaindex");
const articleDir = path.join(baseDir, "article_sets");
const referenceDir = path.join(baseDir, "reference_sets");
const id = process.argv[2] || "jbbrc201702115";
const articlePath = path.join(articleDir, `${id}.json`);
const referencePath = path.join(referenceDir, `${id}.json`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function paragraphs(content) {
  return String(content || "")
    .split(/\n\s*\n/g)
    .map((value) => value.trim())
    .filter(Boolean);
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
  return originalType || "other";
}

function normalizeArticle(source) {
  if (source?.id && Array.isArray(source?.sections) && "chunkCount" in source) return source;
  const sections = (source.sections || []).map((section) => {
    const subsectionSource = Array.isArray(section.subsections) ? section.subsections : [];
    return {
      title: section.title || "Untitled",
      type: sectionType(section.title, section.type),
      content: String(section.content || "").trim(),
      paragraphs: paragraphs(section.content),
      subsections: subsectionSource.map((subsection) => ({
        title: subsection.title || "Untitled",
        content: String(subsection.content || "").trim(),
        paragraphs: paragraphs(subsection.content),
      })),
    };
  });
  const chunkCount = sections.reduce(
    (total, section) => total + section.paragraphs.length + section.subsections.reduce((sum, subsection) => sum + subsection.paragraphs.length, 0),
    0,
  );
  const published = String(source.published || "");
  return {
    id: source.citekey || id,
    sourceUrl: source.source_location || (source.doi ? `https://doi.org/${source.doi}` : ""),
    title: source.title || id,
    authors: Array.isArray(source.authors) ? source.authors : [],
    journal: source.source || "",
    year: (published.match(/\b(19|20)\d{2}\b/) || ["", ""])[0],
    doi: source.doi || "",
    createdAt: source.converted_at || new Date().toISOString(),
    sections,
    chunkCount,
  };
}

function normalizeReferences(source, article) {
  if (source?.id && Array.isArray(source?.records) && "totalReferences" in source) return source;
  const records = (Array.isArray(source) ? source : source.records || []).map((record, offset) => {
    const metadata = record.metadata || {};
    const doi = record.doi || metadata.doi || "";
    return {
      index: Number(record.index ?? record.number ?? offset + 1),
      text: String(record.text || "").trim(),
      sourceUrl: article.sourceUrl,
      href: doi ? `https://doi.org/${doi}` : "",
      doi,
      pmid: record.pmid || "",
      pubmedFound: Boolean(record.pubmedFound),
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

if (!fs.existsSync(articlePath) || !fs.existsSync(referencePath)) {
  throw new Error(`Input files are required: ${articlePath} and ${referencePath}`);
}

const article = normalizeArticle(readJson(articlePath));
const references = normalizeReferences(readJson(referencePath), article);
writeJson(articlePath, article);
writeJson(referencePath, references);
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
