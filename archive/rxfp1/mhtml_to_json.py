from __future__ import annotations

import argparse
import email
import hashlib
import json
import re
from datetime import datetime, timezone
from email import policy
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag


PUBLISHER_RULES = {
    "elsevier_sciencedirect": {
        "publisher": "Elsevier",
        "domains": ["sciencedirect.com", "elsevier.com"],
        "mime_preference": ["text/html"],
        "article_selectors": [
            "article", "main", "#article-main", ".article-content", ".body", ".fulltext"
        ],
        "title_selectors": [
            "h1", "meta[name='citation_title']", "meta[property='og:title']"
        ],
        "author_selectors": [
            "meta[name='citation_author']", ".author-name", ".authorName", "[class*='author']"
        ],
        "abstract_selectors": [
            "div.abstract", ".abstract", "section.abstract", "[id*='abstract']"
        ],
        "section_selectors": [
            "section", "div.section", ".sec", "[class*='section']"
        ],
        "reference_selectors": [
            "ol.references li", ".reference", ".bibliography li", "[class*='reference']"
        ],
        "metadata": {
            "doi": ["meta[name='citation_doi']", "meta[name='dc.identifier']"],
            "published": ["meta[name='citation_publication_date']", "meta[name='citation_date']"],
            "journal": ["meta[name='citation_journal_title']"],
            "volume": ["meta[name='citation_volume']"],
            "issue": ["meta[name='citation_issue']"],
            "pages": ["meta[name='citation_firstpage']", "meta[name='citation_lastpage']"],
            "pmid": ["meta[name='citation_pmid']"],
        },
        "normalization": {
            "remove_selectors": ["script", "style", "noscript", "nav", "header", "footer", ".advertisement", ".cookie"],
            "reference_number_pattern": r"^\\s*\\[?(\\d{1,4})\\]?\\.?\\s*",
        },
    },
    "generic_html": {
        "publisher": None,
        "domains": [],
        "mime_preference": ["text/html"],
        "article_selectors": ["article", "main", "body"],
        "title_selectors": ["h1", "title", "meta[property='og:title']"],
        "author_selectors": ["meta[name='author']", "meta[name='citation_author']", ".author"],
        "abstract_selectors": [".abstract", "section.abstract", "[id='abstract']"],
        "section_selectors": ["section", "h2"],
        "reference_selectors": [".reference", "ol.references li", ".bibliography li"],
        "metadata": {},
        "normalization": {"remove_selectors": ["script", "style", "noscript"], "reference_number_pattern": r"^\\s*\\[?(\\d{1,4})\\]?\\.?\\s*"},
    },
}


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\\s+", " ", value).strip()


def selector_text(soup: BeautifulSoup, selectors: list[str], multiple: bool = False) -> list[str] | str:
    if multiple:
        out: list[str] = []
        for selector in selectors:
            for node in soup.select(selector):
                value = clean_text(node.get("content") if node.name == "meta" else node.get_text(" ", strip=True))
                if value and value not in out:
                    out.append(value)
        return out
    for selector in selectors:
        node = soup.select_one(selector)
        if node:
            value = clean_text(node.get("content") if node.name == "meta" else node.get_text(" ", strip=True))
            if value:
                return value
    return ""


def choose_html(mhtml_path: Path) -> tuple[str, str]:
    raw = mhtml_path.read_bytes()
    msg = email.message_from_bytes(raw, policy=policy.default)
    candidates: list[tuple[int, str, str]] = []
    for part in msg.walk():
        if part.get_content_type() != "text/html":
            continue
        try:
            body = part.get_content()
        except Exception:
            payload = part.get_payload(decode=True) or b""
            body = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        score = len(body)
        if "article" in body.lower() or "references" in body.lower():
            score += 5_000_000
        candidates.append((score, part.get("Content-Location", ""), body))
    if not candidates:
        raise ValueError("MHTML内にtext/htmlパートが見つかりません")
    _, location, html = max(candidates, key=lambda x: x[0])
    return html, location


def meta_value(soup: BeautifulSoup, selectors: list[str]) -> str:
    return selector_text(soup, selectors)


def infer_citekey(title: str, doi: str, source: Path) -> str:
    if doi:
        tail = doi.rsplit("/", 1)[-1]
        tail = re.sub(r"[^A-Za-z0-9]+", "", tail)
        if tail:
            return tail
    words = re.findall(r"[A-Za-z]+", title)
    return (words[0] if words else source.stem[:30]) + str(datetime.now().year)


def extract_sections(root: Tag, rules: dict[str, Any]) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    seen: set[str] = set()
    for node in root.select("h2, h3, h4"):
        heading = clean_text(node.get_text(" ", strip=True))
        if not heading or heading.lower() in {"references", "bibliography", "acknowledgments", "acknowledgements", "supplementary material"}:
            continue
        if heading in seen:
            continue
        seen.add(heading)
        content_parts: list[str] = []
        for sibling in node.find_all_next():
            if sibling is node:
                continue
            if sibling.name in {"h2", "h3", "h4"} and clean_text(sibling.get_text(" ", strip=True)) != heading:
                break
            if sibling.name in {"p", "li"}:
                text = clean_text(sibling.get_text(" ", strip=True))
                if text and text not in content_parts:
                    content_parts.append(text)
        section_type = "methods" if re.search(r"method|material|experimental", heading, re.I) else "results" if re.search(r"result|finding", heading, re.I) else "discussion" if re.search(r"discussion|conclusion", heading, re.I) else "other"
        sections.append({"title": heading, "type": section_type, "content": "\\n\\n".join(content_parts), "subsections": []})
    if not sections:
        text = clean_text(root.get_text(" ", strip=True))
        sections.append({"title": "Main text", "type": "other", "content": text, "subsections": []})
    return sections


def extract_references(soup: BeautifulSoup, rules: dict[str, Any]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for selector in rules["reference_selectors"]:
        for node in soup.select(selector):
            text = clean_text(node.get_text(" ", strip=True))
            if len(text) < 10 or text in seen:
                continue
            seen.add(text)
            m = re.match(rules["normalization"]["reference_number_pattern"], text)
            number = int(m.group(1)) if m else len(refs) + 1
            doi_match = re.search(r"10\\.\\d{4,9}/[-._;()/:A-Z0-9]+", text, re.I)
            refs.append({"number": number, "text": text, "doi": doi_match.group(0).rstrip(".,;") if doi_match else ""})
        if refs:
            break
    refs.sort(key=lambda x: x["number"])
    return refs


def convert(mhtml_path: Path, out_path: Path, publisher: str = "elsevier_sciencedirect") -> dict[str, Any]:
    html, content_location = choose_html(mhtml_path)
    soup = BeautifulSoup(html, "html.parser")
    rules = PUBLISHER_RULES[publisher]
    for selector in rules["normalization"]["remove_selectors"]:
        for node in soup.select(selector):
            node.decompose()
    title = selector_text(soup, rules["title_selectors"])
    if title.lower().endswith(" - sciencedirect"):
        title = title[:-len(" - sciencedirect")].strip()
    authors = selector_text(soup, rules["author_selectors"], multiple=True)
    doi = meta_value(soup, rules["metadata"].get("doi", []))
    if doi.lower().startswith("doi:"):
        doi = doi[4:].strip()
    root = soup.select_one(rules["article_selectors"][0]) or soup.body or soup
    abstract = selector_text(root, rules["abstract_selectors"])
    sections = extract_sections(root, rules)
    references = extract_references(soup, rules)
    metadata = {key: meta_value(soup, sels) for key, sels in rules["metadata"].items() if sels}
    metadata = {k: v for k, v in metadata.items() if v}
    citekey = infer_citekey(title, doi, mhtml_path)
    article = {
        "citekey": citekey,
        "title": title,
        "authors": authors,
        "published": metadata.get("published", ""),
        "source": metadata.get("journal", "ScienceDirect"),
        "volume": metadata.get("volume", ""),
        "issue": metadata.get("issue", ""),
        "doi": doi,
        "tags": [],
        "abstract": abstract,
        "sections": sections,
        "is_review": False,
        "filename": mhtml_path.name,
        "pmid": metadata.get("pmid", ""),
        "publisher": rules.get("publisher") or "",
        "entrez_mesh_terms": [],
        "entrez_keywords": [],
        "references": references,
        "source_format": "mhtml",
        "source_location": content_location,
        "converted_at": datetime.now(timezone.utc).isoformat(),
        "source_sha256": hashlib.sha256(mhtml_path.read_bytes()).hexdigest(),
    }
    result = {"article": article, "references": references, "parser": {"publisher_rule": publisher, "version": "1.0.0"}}
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--publisher", default="elsevier_sciencedirect", choices=PUBLISHER_RULES)
    args = parser.parse_args()
    result = convert(Path(args.input), Path(args.output), args.publisher)
    print(json.dumps({"title": result["article"]["title"], "authors": len(result["article"]["authors"]), "sections": len(result["article"]["sections"]), "references": len(result["references"]), "output": args.output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
