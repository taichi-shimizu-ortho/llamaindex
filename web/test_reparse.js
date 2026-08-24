import fs from "fs";
import { simpleParser } from "mailparser";

async function main() {
  const filePath = "C:\\Users\\a2189\\Dropbox\\obsidian\\50_coding\\llamaindex\\raw_html\\Minimal criteria for defining multipotent mesenchymal stromal cells. The International Society for Cellular Therapy position statement - ScienceDirect.mhtml";
  console.log(`Reading MHTML from ${filePath}...`);
  const mhtml = fs.readFileSync(filePath, "utf-8");
  
  console.log("Parsing MHTML...");
  const parsed = await simpleParser(mhtml);
  
  const html = parsed.html || parsed.textAsHtml;
  if (!html) {
    console.error("Could not extract HTML from MHTML.");
    return;
  }
  
  const payload = {
    sourceUrl: "https://www.sciencedirect.com/science/article/pii/S1465324906708817",
    html: html,
    title: "Minimal criteria for defining multipotent mesenchymal stromal cells. The International Society for Cellular Therapy position statement"
  };

  console.log("Sending to http://localhost:5174/api/import/ors ...");
  try {
    const res = await fetch("http://localhost:5174/api/import/ors", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    
    const text = await res.text();
    console.log("Response status:", res.status);
    try {
      const data = JSON.parse(text);
      console.log("Response data references count:", data.totalReferences);
    } catch (e) {
      console.log("Response text:", text);
    }
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

main();
