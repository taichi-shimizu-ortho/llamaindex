import fs from "fs";
import { simpleParser } from "mailparser";
import { harvestReferences } from "./src/server/referenceHarvester.js";

async function main() {
  const filePath = "C:\\Users\\a2189\\Dropbox\\obsidian\\50_coding\\llamaindex\\raw_html\\Minimal criteria for defining multipotent mesenchymal stromal cells. The International Society for Cellular Therapy position statement - ScienceDirect.mhtml";
  const mhtml = fs.readFileSync(filePath, "utf-8");
  const parsed = await simpleParser(mhtml);
  const html = parsed.html || parsed.textAsHtml;
  
  if (!html) {
      console.log("No HTML");
      return;
  }
  
  const result = await harvestReferences({
    sourceUrl: "https://www.sciencedirect.com/science/article/pii/S1465324906708817",
    html: html,
    title: "Minimal criteria for defining multipotent mesenchymal stromal cells"
  });

  console.log("Extracted references:", result.totalReferences);
  console.log(result.records.map(r => r.index + ". " + r.text).join('\n'));
}

main();
