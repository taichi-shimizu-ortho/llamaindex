#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
import re
from pathlib import Path

def extract_frontmatter(content):
    """Extract YAML frontmatter from markdown content."""
    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not match:
        return {}

    yaml_content = match.group(1)
    properties = {}

    for line in yaml_content.split('\n'):
        if not line.strip() or ':' not in line:
            continue

        parts = line.split(':', 1)
        key = parts[0].strip()
        value = parts[1].strip() if len(parts) > 1 else ''

        if value.lower() == 'true':
            properties[key] = True
        elif value.lower() == 'false':
            properties[key] = False
        elif value.startswith('[') and value.endswith(']'):
            properties[key] = [v.strip().strip("'\"") for v in value[1:-1].split(',') if v.strip()]
        else:
            properties[key] = value.strip("'\"")

    return properties

def extract_abstract(content):
    """Extract abstract block from markdown content."""
    pattern = r'> \[!Abstract\]\n((?:>.*\n?)*)'
    match = re.search(pattern, content, re.MULTILINE)

    if not match:
        return ""

    abstract_block = match.group(1)
    lines = []
    for line in abstract_block.split('\n'):
        if line.startswith('> '):
            lines.append(line[2:])
        elif line.strip():
            lines.append(line)

    return '\n'.join(lines).strip()

def main():
    rxfp1_dir = Path(r'C:\Users\a2189\Dropbox\obsidian\10_article\RXFP1')
    output_file = Path(r'C:\Users\a2189\uv-envs\llamaindex\abstract_rxfp1.json')

    if not rxfp1_dir.exists():
        print(f"Error: Directory {rxfp1_dir} does not exist")
        return

    results = []
    md_files = sorted(rxfp1_dir.glob('*.md'))

    print(f"Found {len(md_files)} markdown files")

    for md_file in md_files:
        try:
            content = md_file.read_text(encoding='utf-8')
            properties = extract_frontmatter(content)
            abstract = extract_abstract(content)

            results.append({
                'filename': md_file.name,
                'properties': properties,
                'abstract': abstract
            })

            print(f"OK: {md_file.name}")
        except Exception as e:
            print(f"ERROR {md_file.name}: {e}")

    output = {
        'total_files': len(results),
        'files': results
    }

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\nSaved to: {output_file}")
    print(f"Total files: {len(results)}")

if __name__ == '__main__':
    main()
