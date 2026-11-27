// corpus RAG の埋め込みを、段落の本文・メタデータと一緒に JSONL へ書き出す CLI。
// 別の RAG（LlamaIndex の TextNode など）でそのまま使えるように、1行に1段落を置く。
//
//   npm run export:embeddings -- --folder "European league"           # フォルダ（子フォルダを含む）
//   npm run export:embeddings -- --ids Martins2026,Montiel2026         # 論文を指定
//   npm run export:embeddings -- --folder "European league" --no-vectors   # 本文とメタデータだけ
//   npm run export:embeddings -- --folder "European league" --out D:/x.jsonl
//
// 1行の形: { id, text, embedding?, metadata: { article_id, title, authors, year, journal, doi, pmid,
//            article_type, section, subsection, section_group, paragraph_index, total_paragraphs,
//            source, embedding_model } }
//
// 埋め込みは embeddings_cache/corpus/ に保存済みのものだけを使い、API は呼ばない。
// 段落はアプリと同じ paragraphsOf で作り直し、保存時のシグネチャと一致したものだけを書き出す。
// 一致しない論文（本文が変わった・まだ埋め込んでいない）は飛ばして理由を表示する。
// その場合は RAG 画面でその論文を含むフォルダを開く（prepare）と作り直される。
import fs from "node:fs";
import path from "node:path";
import { listArticleSets, loadArticleSet } from "../src/server/articleHarvester.js";
import { MODELS, PATHS } from "../src/server/config.js";
import { paragraphsOf } from "../src/server/corpusRag.js";
import { cachedEmbeddings } from "../src/server/embeddingStore.js";
import { descendantIds, readLibrary } from "../src/server/library.js";

const USAGE =
  'Usage: npm run export:embeddings -- (--folder "<name>" | --ids a,b,c) [--no-subfolders] [--no-vectors] [--out <file.jsonl>]';

interface Options {
  folder: string;
  ids: string[];
  subfolders: boolean;
  vectors: boolean;
  out: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { folder: "", ids: [], subfolders: true, vectors: true, out: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--folder") options.folder = value();
    else if (arg === "--ids") options.ids = value().split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "--no-subfolders") options.subfolders = false;
    else if (arg === "--no-vectors") options.vectors = false;
    else if (arg === "--out") options.out = value();
    else throw new Error(`Unknown option ${arg}\n${USAGE}`);
  }
  if (!options.folder && !options.ids.length) throw new Error(USAGE);
  return options;
}

// RAG 画面の「Ask this folder」と同じ選び方：主フォルダか Zotero のコレクションがそのフォルダ（と子孫）にある論文。
function folderArticleIds(name: string, subfolders: boolean): string[] {
  const library = readLibrary();
  const matches = library.folders.filter((folder) => folder.name === name || folder.id === name);
  if (matches.length !== 1) throw new Error(`Folder "${name}" ${matches.length ? "is ambiguous" : "not found"}`);
  const targets = subfolders ? descendantIds(library, matches[0].id) : new Set([matches[0].id]);
  return listArticleSets()
    .map((set) => set.id)
    .filter((id) => {
      const folders = new Set(library.zoteroFolders?.[id] ?? []);
      const primary = library.assignments[id];
      if (primary) folders.add(primary);
      return [...folders].some((folderId) => targets.has(folderId));
    })
    .sort();
}

function slug(value: string): string {
  return value.replace(/[<>:"/\\|?*\s]+/g, "_").replace(/^_+|_+$/g, "") || "corpus";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const ids = options.folder ? folderArticleIds(options.folder, options.subfolders) : options.ids;
  if (!ids.length) throw new Error("No papers selected");
  const out =
    options.out ||
    path.join(PATHS.outputDir, "exports", `${slug(options.folder || "selection")}_corpus_embeddings${options.vectors ? "" : "_text"}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const lines: string[] = [];
  const skipped: string[] = [];
  let dimension = 0;
  for (const id of ids) {
    let set;
    try {
      set = loadArticleSet(id);
    } catch (e) {
      skipped.push(`${id}: could not read (${String((e as Error)?.message ?? e)})`);
      continue;
    }
    const paragraphs = paragraphsOf(set);
    if (!paragraphs.length) {
      skipped.push(`${id}: no main text`);
      continue;
    }
    const vectors = options.vectors ? cachedEmbeddings("corpus", id, paragraphs.map((p) => p.text)) : null;
    if (options.vectors && !vectors) {
      skipped.push(`${id}: no saved embeddings for its current text (open it in the RAG screen to rebuild)`);
      continue;
    }
    paragraphs.forEach((p, i) => {
      if (vectors) dimension = vectors[i].length;
      lines.push(
        JSON.stringify({
          id: `${id}::${i + 1}`,
          text: p.text,
          ...(vectors ? { embedding: vectors[i] } : {}),
          metadata: {
            article_id: id,
            title: set.title,
            authors: set.authors ?? [],
            year: (set.year ?? "").slice(0, 4),
            journal: set.journal ?? "",
            doi: set.doi ?? "",
            pmid: set.pmid ?? "",
            article_type: set.articleType ?? null,
            section: p.section,
            subsection: p.subsection,
            section_group: p.group,
            paragraph_index: p.paragraphIndex,
            total_paragraphs: p.totalParagraphs,
            source: set.canonicalId ? `canonical:${set.canonicalId}` : `article_sets:${set.extractionSource ?? ""}`,
            ...(vectors ? { embedding_model: MODELS.embed } : {}),
          },
        }),
      );
    });
  }

  fs.writeFileSync(out, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
  const exported = ids.length - skipped.length;
  console.log(`Wrote ${lines.length} paragraphs from ${exported}/${ids.length} papers to ${out}`);
  if (options.vectors) console.log(`Embedding model: ${MODELS.embed} (${dimension} dimensions)`);
  for (const reason of skipped) console.log(`  skipped ${reason}`);
  if (skipped.length) process.exitCode = 1;
}

try {
  main();
} catch (e) {
  console.error(String((e as Error)?.message ?? e));
  process.exit(1);
}
