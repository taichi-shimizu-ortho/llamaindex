from __future__ import annotations
import argparse, email, json, mimetypes, re
from email import policy
from pathlib import Path
from urllib.parse import urlparse
from bs4 import BeautifulSoup, Tag

def normalize(value: str) -> str:
    return re.sub(r'\s+', ' ', value or '').strip()

def decode_mhtml(source: Path):
    message = email.message_from_bytes(source.read_bytes(), policy=policy.default)
    html_candidates, image_assets = [], {}
    for part in message.walk():
        content_type = part.get_content_type()
        payload = part.get_payload(decode=True) or b''
        if content_type == 'text/html':
            html = payload.decode('utf-8', errors='replace')
            html_candidates.append((len(html) + (5000000 if 'references' in html.lower() else 0), html))
        elif content_type.startswith('image/'):
            location = (part.get('Content-Location') or '').strip()
            if location:
                image_assets[location] = (content_type, payload)
    if not html_candidates:
        raise ValueError('No HTML MIME part was found in the MHTML source')
    return max(html_candidates, key=lambda item: item[0])[1], image_assets

def title_and_legend(figure: Tag, ordinal: int):
    caption = figure.select_one('.captions') or figure.select_one('figcaption')
    label = caption.select_one('.label') if caption else None
    raw_title = normalize(label.get_text(' ', strip=True) if label else '')
    title = re.sub(r'^fig\.?\s*', 'Figure ', raw_title, flags=re.I).strip() or f'Figure {ordinal}'
    caption_text = normalize(caption.get_text(' ', strip=True) if caption else '')
    legend = normalize(re.sub(rf'^{re.escape(raw_title)}\s*\.?\s*', '', caption_text, flags=re.I)) if raw_title else caption_text
    return title, legend

def filename_for(title: str, source_url: str, media_type: str):
    number = re.search(r'(\d+[A-Za-z]?)', title)
    stem = f'Figure_{number.group(1)}' if number else re.sub(r'[^A-Za-z0-9]+', '_', title).strip('_')
    suffix = Path(urlparse(source_url).path).suffix.lower() or mimetypes.guess_extension(media_type) or '.bin'
    return f'{stem}{suffix}'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mhtml', type=Path)
    parser.add_argument('article_json', type=Path)
    parser.add_argument('raw_html_dir', type=Path)
    parser.add_argument('--backup', action='store_true')
    args = parser.parse_args()
    article = json.loads(args.article_json.read_text(encoding='utf-8'))
    article_id = str(article.get('id') or args.article_json.stem)
    if args.backup:
        backup = args.article_json.with_name(f'{args.article_json.stem}.before_figure_extraction.json')
        backup.write_text(json.dumps(article, ensure_ascii=False, indent=2), encoding='utf-8')
    html, assets = decode_mhtml(args.mhtml)
    soup = BeautifulSoup(html, 'html.parser')
    root = soup.select_one('article') or soup
    asset_dir = args.raw_html_dir / f'{article_id}_figures'
    asset_dir.mkdir(parents=True, exist_ok=True)
    figures, used_titles = [], set()
    for ordinal, figure in enumerate(root.select('figure'), start=1):
        figure_id, image = figure.get('id', ''), figure.find('img')
        if not image or not figure_id.lower().startswith('fig'):
            continue
        source_url = image.get('src', '').strip()
        if not source_url or source_url not in assets:
            continue
        title, legend = title_and_legend(figure, ordinal)
        if title in used_titles:
            continue
        used_titles.add(title)
        media_type, payload = assets[source_url]
        filename = filename_for(title, source_url, media_type)
        (asset_dir / filename).write_bytes(payload)
        local_url = f'/raw_html/{article_id}_figures/{filename}'
        content = f'[Image URL: {local_url}]' + (f'\n\n{legend}' if legend else '')
        figures.append({'title': title, 'type': 'figure', 'content': content, 'paragraphs': [content], 'subsections': []})
    text_sections = [section for section in article.get('sections', []) if section.get('type') != 'figure']
    insertion_index = next((index + 1 for index, section in enumerate(text_sections) if section.get('type') == 'abstract'), 0)
    article['sections'] = text_sections[:insertion_index] + figures + text_sections[insertion_index:]
    article['chunkCount'] = sum(len(section.get('paragraphs', [])) for section in article['sections'] if section.get('type') != 'figure')
    args.article_json.write_text(json.dumps(article, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'id': article_id, 'figureCount': len(figures), 'assetDirectory': str(asset_dir), 'figures': [{'title': s['title'], 'image': s['content'].split('\n', 1)[0]} for s in figures], 'textChunkCount': article['chunkCount']}, ensure_ascii=False, indent=2))
if __name__ == '__main__':
    main()
