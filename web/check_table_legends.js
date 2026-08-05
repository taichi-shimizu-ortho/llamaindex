import fs from "fs";
import { simpleParser } from "mailparser";

async function main() {
  const filePath = "C:\\Users\\a2189\\Dropbox\\obsidian\\50_coding\\llamaindex\\raw_html\\Science.mhtml";
  const mhtml = fs.readFileSync(filePath, "utf-8");
  const parsed = await simpleParser(mhtml);
  const html = parsed.html || parsed.textAsHtml;

  // Find all <figure> tags and see if any of them contain "Table" or table wrappers
  const figures = Array.from(html.matchAll(/<figure\b([^>]*?)>([\s\S]*?)<\/figure>/gi));
  console.log(`Total <figure> tags in MHTML: ${figures.length}`);
  
  figures.forEach((f, i) => {
    const attrs = f[1];
    const content = f[2];
    console.log(`\n--- Figure ${i} (Attrs: ${attrs}) ---`);
    const figcaptionMatch = content.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i);
    const legendSnippet = figcaptionMatch ? figcaptionMatch[1].slice(0, 200) : content.slice(0, 200);
    console.log("Snippet:", legendSnippet.replace(/\s+/g, " "));
  });

  // Also inspect Chen2015.json figures
  const jsonPath = "C:\\Users\\a2189\\Dropbox\\obsidian\\50_coding\\llamaindex\\article_sets\\Chen2015.json";
  if (fs.existsSync(jsonPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const figSections = data.sections.filter(s => s.type === "figure" || s.title.toLowerCase().includes("fig"));
    console.log(`\n\nTotal Figure sections in Chen2015.json: ${figSections.length}`);
    figSections.forEach((s, idx) => {
      console.log(`\nJSON Fig ${idx}: Title="${s.title}"`);
      console.log("Content snippet:", s.content.slice(0, 250).replace(/\s+/g, " "));
    });
  }
}

main().catch(console.error);
