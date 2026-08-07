import fs from "fs";
import { simpleParser } from "mailparser";

async function main() {
  const filePath = "C:\\Users\\a2189\\Dropbox\\obsidian\\50_coding\\llamaindex\\raw_html\\Science.mhtml";
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
  
  const payload = {
    sourceUrl: "https://www.science.org/doi/10.1126/science.aaa6090",
    html: html,
    title: "Spatially resolved, highly multiplexed RNA profiling in single cells | Science"
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
      console.log("Response data:", JSON.stringify(data, null, 2));
    } catch (e) {
      console.log("Response text:", text);
    }
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

main();
