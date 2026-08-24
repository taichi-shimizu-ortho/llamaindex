import fs from "fs";
import { harvestArticle } from "./src/server/articleHarvester.js";
import { harvestReferences } from "./src/server/referenceHarvester.js";

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Please provide the path to the HTML file.");
    process.exit(1);
  }
  
  console.log(`Reading HTML from ${filePath}...`);
  const html = fs.readFileSync(filePath, "utf-8");
  
  const options = {
    html: html,
    sourceUrl: "https://www.sciencedirect.com/science/article/pii/S1465324906708817", // Fallback URL if not found in HTML
  };

  try {
    console.log("Harvesting article...");
    const article = await harvestArticle(options);
    console.log("Article harvested successfully:", article.id);
  } catch (e) {
    console.error("Article harvest failed:", e);
  }

  try {
    console.log("Harvesting references...");
    const reference = await harvestReferences(options);
    console.log("References harvested successfully:", reference.id);
    console.log("Total references extracted:", reference.totalReferences);
  } catch (e) {
    console.error("Reference harvest failed:", e);
  }
}

main();
