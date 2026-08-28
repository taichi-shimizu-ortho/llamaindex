import fs from "fs";
import { simpleParser } from "mailparser";
import { harvestArticle } from "./src/server/articleHarvester.js";

async function main() {
  const filePath = "/Users/taichishimizu/Library/CloudStorage/Dropbox/obsidian/50_coding/llamaindex/raw_html/Muscle hypertrophy and ladder‐based resistance training for rodents_ A systematic review and meta‐analysis - Lourenço - 2020 - Physiological Reports - Wiley Online Library.mhtml";
  console.log(`Reading MHTML from ${filePath}...`);
  const mhtml = fs.readFileSync(filePath, "utf-8");
  
  console.log("Parsing MHTML...");
  const parsed = await simpleParser(mhtml);
  
  const html = parsed.html || parsed.textAsHtml;
  if (!html) {
    console.error("Could not extract HTML from MHTML.");
    return;
  }
  
  console.log(`Extracted HTML of size ${html.length} bytes.`);
  
  console.log("Harvesting article...");
  try {
    const article = await harvestArticle({
      sourceUrl: "", 
      html: html,
      title: "Muscle hypertrophy and ladder‐based resistance training for rodents: A systematic review and meta‐analysis"
    });
    console.log("Successfully harvested article:");
    console.log(`ID: ${article.id}`);
    console.log(`Title: ${article.title}`);
    console.log(`Saved to article_sets directory`);
  } catch (err) {
    console.error("Harvesting failed:", err);
  }
}

main();
