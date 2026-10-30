import json
import re
from pathlib import Path
from typing import Dict, Any, List

def extract_frontmatter(content: str) -> Dict[str, Any]:
    """Extract YAML frontmatter from markdown content."""
    # Match content between first and second ---
    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not match:
        return {}

    yaml_content = match.group(1)
    properties = {}

    for line in yaml_content.split('\n'):
        if not line.strip():
            continue

        # Simple YAML parsing for key: value pairs
        if ':' in line:
            key, value = line.split(':', 1)
            key = key.strip()
            value = value.strip()

            # Handle different value types
            if value.lower() == 'true':
                properties[key] = True
            elif value.lower() == 'false':
                properties[key] = False
            elif value.startswith('[') and value.endswith(']'):
                # Parse list
                properties[key] = [v.strip().strip("'\"") for v in value[1:-1].split(',')]
            elif value.startswith("'") and value.endswith("'"):
                properties[key] = value[1:-1]
            elif value.startswith('"') and value.endswith('"'):
                properties[key] = value[1:-1]
            else:
                # Check if it's a quoted multi-line string
                properties[key] = value.strip("'\"")

    return properties

def extract_abstract(content: str) -> str:
    """Extract abstract block from markdown content."""
    # Match > [!Abstract] block
    pattern = r'> \[!Abstract\]\n((?:>.*\n?)*)'
    match = re.search(pattern, content, re.MULTILINE)

    if not match:
        return ""

    abstract_block = match.group(1)
    # Remove leading '> ' from each line and join
    lines = abstract_block.split('\n')
    abstract_text = '\n'.join(line[2:] if line.startswith('> ') else line for line in lines)

    return abstract_text.strip()

def process_rxfp1_files(directory: str) -> List[Dict[str, Any]]:
    """Process all markdown files in the RXFP1 directory."""
    rxfp1_dir = Path(directory)
    results = []

    # Get all markdown files
    md_files = sorted(rxfp1_dir.glob('*.md'))

    for md_file in md_files:
        content = md_file.read_text(encoding='utf-8')

        properties = extract_frontmatter(content)
        abstract = extract_abstract(content)

        results.append({
            'filename': md_file.name,
            'properties': properties,
            'abstract': abstract
        })

        print(f"✓ Processed: {md_file.name}")

    return results

def main():
    # Directory path
    rxfp1_dir = r'C:\Users\a2189\Dropbox\obsidian\10_article\RXFP1'
    output_file = r'C:\Users\a2189\uv-envs\llamaindex\abstract_rxfp1.json'

    # Process files
    print(f"Processing files from: {rxfp1_dir}")
    results = process_rxfp1_files(rxfp1_dir)

    # Create output structure
    output = {
        'total_files': len(results),
        'files': results
    }

    # Save to JSON
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n✓ Saved to: {output_file}")
    print(f"✓ Total files processed: {len(results)}")

if __name__ == '__main__':
    main()
