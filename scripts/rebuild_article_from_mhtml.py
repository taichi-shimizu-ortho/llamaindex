from __future__ import annotations

import argparse
import email
import json
import re
from email import policy
from pathlib import Path

from bs4 import BeautifulSoup, Tag


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def mhtml_html(source: Path) -> str:
    message = email.message_from_bytes(source.read_bytes(), policy=policy.default)
    candidates: list[tuple[int, str]] = []
    for part in message.walk():
        if part.get_content_type() != "text/html":
            continue
        payload = part.get_payload(decode=True) or b""
        html = payload.decode("utf-8", errors="replace")
        score = len(html) + (5_000_000 if "references" in html.lower() else 0)
        candidates.append((score, html))
    if not candidates:
        raise ValueError("No HTML MIME part was found")
    return max(candidates, key=lambda item: item[0])[1]


def nearest_section(node: Tag) -> Tag | None:
    return node.find_parent("section")


def section_type(title: str) -> str:
    if re.match(r"^1\.", title) or re.search(r"introduction", title, re.I):
        return "intro"
    if re.match(r"^2\.", title) or re.search(r"method|material|experimental", title, re.I):
        return "methods"
    if re.match(r"^3\.", title) or re.search(r"result|finding", title, re.I):
        return "results"
    if re.match(r"^4\.", title) or re.search(r"discussion|conclusion", title, re.I):
        return "discussion"
    return "other"


def section_paragraphs(section: Tag) -> list[str]:
    values: list[str] = []
    for node in section.find_all(["p", "li", "div"]):
        if nearest_section(node) is not section:
            continue
        # Old ScienceDirect uses leaf divs as paragraphs; wrapper divs contain
        # other block nodes and must not duplicate section content.
        if node.name == "div" and node.find(["div", "p", "li"]):
            continue
        text = normalize(node.get_text(" ", strip=True))
        if not text or text.startswith("Download:") or text in values:
            continue
        values.append(text)
    return values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mhtml", type=Path)
    parser.add_argument("article_json", type=Path)
    parser.add_argument("--backup", action="store_true")
    args = parser.parse_args()

    article = json.loads(args.article_json.read_text(encoding="utf-8"))
    if args.backup:
        backup = args.article_json.with_name(f"{args.article_json.stem}.before_mhtml_rebuild.json")
        backup.write_text(json.dumps(article, ensure_ascii=False, indent=2), encoding="utf-8")

    soup = BeautifulSoup(mhtml_html(args.mhtml), "html.parser")
    for selector in ["script", "style", "noscript", "nav", "header", "footer", ".cookie", ".advertisement"]:
        for node in soup.select(selector):
            node.decompose()
    root = soup.select_one("article") or soup.body or soup

    abstract_node = root.select_one("div.abstract.author")
    if abstract_node is None:
        abstract_node = next((node for node in root.select("div.abstract") if "author-highlights" not in (node.get("class") or []) and "reference-abstract" not in (node.get("id") or "")), None)
    abstract = normalize(abstract_node.get_text(" ", strip=True) if abstract_node else "")
    abstract = re.sub(r"^Abstract\s*", "", abstract, flags=re.I)
    if not abstract or abstract in {"Previous article in issue", "Next article in issue"}:
        raise ValueError("The true abstract could not be extracted from the local MHTML")

    sections: list[dict] = [{
        "title": "Abstract",
        "type": "abstract",
        "content": abstract,
        "paragraphs": [abstract],
        "subsections": [],
    }]
    stop = {"references", "bibliography", "transparency document", "acknowledgments", "acknowledgements", "supplementary material"}
    skip = {"highlights", "keywords", "abstract"}
    seen: set[str] = set()
    for section in root.select("section"):
        heading = section.find(["h2", "h3", "h4"], recursive=False)
        if heading is None:
            continue
        title = normalize(heading.get_text(" ", strip=True))
        title_lower = title.lower()
        if title_lower in stop:
            break
        if not title or title_lower in skip or title in seen:
            continue
        seen.add(title)
        paragraphs = section_paragraphs(section)
        sections.append({
            "title": title,
            "type": section_type(title),
            "content": "\n\n".join(paragraphs),
            "paragraphs": paragraphs,
            "subsections": [],
        })

    article["sections"] = sections
    article["chunkCount"] = sum(len(section["paragraphs"]) for section in sections)
    args.article_json.write_text(json.dumps(article, ensure_ascii=False, indent=2), encoding="utf-8")
    intro = next((section for section in sections if section["type"] == "intro"), {"content": ""})
    print(json.dumps({
        "id": article.get("id"),
        "sections": len(sections),
        "chunkCount": article["chunkCount"],
        "abstractLength": len(abstract),
        "hasReplacementCharacter": "�" in intro.get("content", ""),
        "excluded": ["Highlights", "Keywords"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
