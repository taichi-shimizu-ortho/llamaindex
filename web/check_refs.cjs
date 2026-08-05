const fs = require('fs');
const html = fs.readFileSync('science_raw.html', 'utf-8');
const entries = Array.from(html.matchAll(/<div\b[^>]*class=["'][^"']*biblioentry[^"']*["'][^>]*>([\s\S]*?)<\/div>(?=\s*<div\b[^>]*class=["'][^"']*biblioentry|$)/gi));
console.log(`Found ${entries.length} entries`);
entries.slice(0, 3).forEach((e, i) => {
  console.log(`--- Entry ${i + 1} ---`);
  console.log(e[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
});
