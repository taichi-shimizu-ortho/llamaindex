"""Convert a text PDF using a visually reviewed layout profile (no network/OCR).

Coordinates are PDF points, pages are one-based, and regions are in reading order.
Profiles explicitly exclude running headers, footers, figure labels and boilerplate.
Different journal layouts require their own reviewed profile; scanned PDFs fail closed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pymupdf


# Set from the profile in convert(): fontGlyphs maps characters per font name (fonts that
# encode minus, plus or Greek letters as private codes), dehyphenate marks line-end hyphens.
FONT_GLYPHS: dict[str, dict[str, str]] = {}
DEHYPHENATE = False
REBUILD_LINES = False  # rebuild line text from character gaps (text layers that omit spaces)


def span_text(span) -> str:
    """Text of a rawdict span with a space wherever the gap between glyphs looks like one."""
    out, previous = "", None
    for char in span["chars"]:
        c = char["c"]
        if previous is not None and c != " " and not out.endswith(" ") \
                and char["bbox"][0] - previous["bbox"][2] > span["size"] * 0.1:
            out += " "
        out += c
        previous = char
    return out
LINE_HYPHEN = "\u2061"  # marks a hyphen that ended a line until resolve_hyphens() decides


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def join_lines(lines: list[str]) -> str:
    out = ""
    for line in lines:
        line = line.strip()
        if out.endswith("\u00ad"):
            out = out[:-1] + line
        elif out.endswith("-"):
            out += (LINE_HYPHEN if DEHYPHENATE else "") + line
        else:
            out += (" " if out else "") + line
    return normalize(out.replace("\u00ad", ""))


def lines_by_row(lines, tolerance):
    """Group nearby line fragments and order each row from left to right."""
    rows = []
    for line in sorted(lines, key=lambda l: (l["box"][1] + l["box"][3]) / 2):
        centre = (line["box"][1] + line["box"][3]) / 2
        if rows and centre - rows[-1][0] <= tolerance:
            rows[-1][1].append(line)
        else:
            rows.append((centre, [line]))
    for _, row in rows:
        yield sorted(row, key=lambda line: line["box"][0])


def region_lines(doc, region, citations=False):
    page = doc[region["page"] - 1]
    rect = pymupdf.Rect(region["box"])
    if rect.is_empty or not page.rect.contains(rect):
        raise ValueError(f"Region outside page: {region}")
    lines = []
    mode = "rawdict" if REBUILD_LINES else "dict"
    for block in page.get_text(mode, clip=rect)["blocks"]:
        for line in block.get("lines", []):
            if line["dir"] != (1.0, 0.0):
                continue
            text = ""
            spans = line["spans"]
            if REBUILD_LINES:
                for span in spans:
                    span["text"] = span_text(span)
            bold = all(s["flags"] & 16 for s in spans if s["text"].strip())
            previous_end = None
            for span in spans:
                value = span["text"]
                for font, glyphs in FONT_GLYPHS.items():
                    if font in span["font"]:
                        value = "".join(glyphs.get(ch, ch) for ch in value)
                if REBUILD_LINES and previous_end is not None and value[:1] != " " and not text.endswith(" ") \
                        and span["bbox"][0] - previous_end > span["size"] * 0.1:
                    text += " "
                previous_end = span["bbox"][2]
                if citations and span["flags"] & 1 and re.fullmatch(r"[\d,–\-]+", value.strip()):
                    if text.endswith("−"):
                        text = text[:-1] + "⁻"  # a unit exponent such as mL⁻¹
                        value = value.strip().translate(str.maketrans("0123456789-", "⁰¹²³⁴⁵⁶⁷⁸⁹⁻"))
                    elif re.search(r"(?:\d|[cmμ]m)$", text):
                        value = value.translate(str.maketrans("0123456789-", "⁰¹²³⁴⁵⁶⁷⁸⁹⁻"))
                    else:
                        value = "[" + value.strip() + "]"
                text += value
            if text.strip():
                lines.append({"text": text.strip(), "box": line["bbox"], "bold": bold,
                              "page": region["page"], "columnLeft": rect.x0})
    lines.sort(key=lambda line: (round(line["box"][1], 1), line["box"][0]))
    if REBUILD_LINES:
        # Justified lines with wide word spacing can come back as several pieces on one row.
        merged = []
        for row in lines_by_row(lines, 2.5):
            last = None
            for line in row:
                if last and line["box"][0] >= last["box"][2] - 1:
                    last["text"] += " " + line["text"]
                    last["box"] = (last["box"][0], min(last["box"][1], line["box"][1]),
                                   line["box"][2], max(last["box"][3], line["box"][3]))
                    last["bold"] = last["bold"] and line["bold"]
                else:
                    last = dict(line)
                    merged.append(last)
        lines = sorted(merged, key=lambda line: (round(line["box"][1], 1), line["box"][0]))
    if not lines:
        raise ValueError(f"No text in region (OCR may be needed): {region}")
    return lines


def resolve_hyphens(text: str, vocabulary: set[str]) -> str:
    """Drop a line-end hyphen when the joined word occurs elsewhere in the document, or
    when the word continues in lower case and the hyphenated form does not occur."""
    def decide(match):
        left, right = match[1], match[2]
        joined = (left + right).lower()
        if joined in vocabulary:
            return left + right
        if (left + "-" + right).lower() in vocabulary:
            return left + "-" + right
        return left + right if right[:1].islower() else left + "-" + right
    text = re.sub(r"([A-Za-z]+)-" + LINE_HYPHEN + r"([A-Za-z]+)", decide, text)
    return text.replace(LINE_HYPHEN, "")


def make_section(title, kind, paragraphs):
    return {"title": title, "type": kind, "content": "\n\n".join(paragraphs),
            "paragraphs": paragraphs, "subsections": []}


def body_sections(doc, profile):
    headings = {normalize(h["match"]): h for h in profile["headings"]}
    sections, buffer = [], []
    lead = profile.get("initialSection")
    current = make_section(lead["title"], lead["type"], []) if lead else None
    if current:
        sections.append(current)
    previous = None

    def flush():
        if buffer:
            if current is None:
                raise ValueError("Body text before the first configured heading")
            current["paragraphs"].append(join_lines(buffer))
            buffer.clear()

    drop_cap = profile.get("dropCap", "")
    drop_cap_bottom = 0
    paragraph_starts = tuple(profile.get("paragraphStarts", []))
    for region in profile["bodyRegions"]:
        lines = region_lines(doc, region, citations=True)
        i = 0
        while i < len(lines):
            line = lines[i]
            if drop_cap and line["text"] == drop_cap:
                drop_cap_bottom = line["box"][3]
                i += 1
                continue
            # Headings can wrap across several lines in a narrow column.
            matched = None
            for count in range(1, min(6, len(lines) - i) + 1):
                candidate = join_lines([x["text"] for x in lines[i:i + count]])
                if candidate in headings:
                    matched = (headings[candidate], count)
                    break
            if matched:
                flush()
                heading, count = matched
                current = make_section(heading["title"], heading["type"], [])
                sections.append(current)
                previous = None
                i += count
                continue
            same_column = previous and previous["page"] == line["page"] and abs(previous["columnLeft"] - line["columnLeft"]) < 1
            # paragraphIndentMax: lines indented further than this are list-item continuations
            # (e.g. BMJ bullet lists hang at 15 pt while paragraphs indent 9 pt), not new paragraphs.
            offset = line["box"][0] - line["columnLeft"]
            indented = line["box"][1] >= drop_cap_bottom and profile.get("paragraphIndent", 8) < offset <= profile.get("paragraphIndentMax", float("inf"))
            gap = line["box"][1] - previous["box"][3] if same_column else 0
            # Double-spaced manuscripts need a larger gap than typeset pages (paragraphGap, default 4 pt).
            if buffer and (indented or gap > profile.get("paragraphGap", 4) or line["text"].startswith(paragraph_starts)):
                flush()
            buffer.append(drop_cap + line["text"])
            drop_cap = ""
            previous = line
            i += 1
    flush()
    for section in sections:
        section["content"] = "\n\n".join(section["paragraphs"])
    if not any(s["paragraphs"] for s in sections):
        raise ValueError("No body paragraphs: check heading and region boundaries")
    return sections


def references(doc, profile, source_url):
    entries, current = [], None
    hanging = profile.get("referenceStyle") == "hanging"
    for region in profile["referenceRegions"]:
        page = doc[region["page"] - 1]
        links = page.get_links()
        for line in region_lines(doc, region):
            at_left = line["box"][0] - region["box"][0] <= 5
            if hanging:
                # Author-year lists: an entry starts at the left edge and continues with a hanging indent.
                match = at_left
            else:
                match = re.match(r"^(\d+)\.(?:\s+(.*)|$)", line["text"])
                if not at_left:
                    match = None  # A page range such as "96. https://doi…" is not a new entry.
            if match:
                current = ({"index": len(entries) + 1, "lines": [line["text"]], "uris": []} if hanging
                           else {"index": int(match[1]), "lines": [match[2] or ""], "uris": []})
                entries.append(current)
            else:
                if current is None:
                    raise ValueError("Reference continuation before reference 1")
                current["lines"].append(line["text"])
            for link in links:
                if link.get("uri") and pymupdf.Rect(line["box"]).intersects(link["from"]):
                    current["uris"].append(link["uri"])
    records = []
    for entry in entries:
        text = join_lines(entry["lines"])
        doi = next((u.split("doi.org/", 1)[1] for u in entry["uris"] if "doi.org/10." in u), "")
        if not doi:
            match = re.search(r"\b10\.\d{4,9}/[^\s]+", text)
            doi = match[0].rstrip(".,;") if match else ""
        records.append({"index": entry["index"], "text": text, "sourceUrl": source_url,
                        "href": "https://doi.org/" + doi if doi else "", "doi": doi,
                        "pmid": "", "pubmedFound": False})
    if [r["index"] for r in records] != list(range(1, len(records) + 1)):
        raise ValueError("Missing or out-of-order references")
    expected = profile.get("expectedReferences")
    if expected is not None and len(records) != expected:
        raise ValueError(f"Expected {expected} references, extracted {len(records)}")
    return records


def convert(pdf: Path, profile: dict, output: Path):
    global DEHYPHENATE, REBUILD_LINES
    REBUILD_LINES = bool(profile.get("rebuildLines"))
    FONT_GLYPHS.clear()
    FONT_GLYPHS.update(profile.get("fontGlyphs", {}))
    DEHYPHENATE = bool(profile.get("dehyphenate"))
    doc = pymupdf.open(pdf)
    if len(doc) != profile["pageCount"]:
        raise ValueError("PDF page count does not match the reviewed profile")
    metadata = profile["metadata"]
    fingerprint = hashlib.sha256(pdf.read_bytes()).hexdigest()
    edition = profile.get("sourceSha256")
    if edition and fingerprint != edition:
        raise ValueError("PDF does not match the reviewed source file")
    if not edition and metadata["doi"].lower() not in doc[0].get_text().lower():
        raise ValueError("Profile DOI is absent from the first PDF page")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", metadata["id"]) or metadata["id"] in {".", ".."}:
        raise ValueError("Invalid article ID")
    sections = []
    abstract_regions = profile["abstractRegions"] if "abstractRegions" in profile else [profile["abstractRegion"]]
    abstract_lines = [line["text"] for region in abstract_regions for line in region_lines(doc, region)]
    abstract = re.sub(r"^abstract[.:]?\s+", "", join_lines(abstract_lines), flags=re.I)
    sections.append(make_section("Abstract", "abstract", [abstract]))
    sections.extend(body_sections(doc, profile))
    def correct_text(text):
        for original, corrected in profile.get("textCorrections", {}).items():
            text = text.replace(original, corrected)
        return text
    for item in sections:
        item["paragraphs"] = [correct_text(text) for text in item["paragraphs"]]
        item["content"] = "\n\n".join(item["paragraphs"])

    output.mkdir(parents=True, exist_ok=True)
    for figure in profile.get("figures", []):
        page = doc[figure["page"] - 1]
        caption_page = figure.get("captionPage", figure["page"])
        caption = correct_text(join_lines([l["text"] for l in region_lines(doc, {"page": caption_page, "box": figure["captionBox"]})]))
        rect = pymupdf.Rect(figure["box"])
        if rect.is_empty or not page.rect.contains(rect):
            raise ValueError("Figure region outside page")
        pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=rect)
        png = pix.tobytes("png")
        (output / (figure["title"].replace(" ", "_") + ".png")).write_bytes(png)
        url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        sections.append(make_section(figure["title"], "figure", [caption + "\n\n[Image URL: " + url + "]"]))
    # Figure legends without images (e.g. an author manuscript): each legend starts at the
    # left edge with "Fig. N" and continues with a hanging indent.
    legends = []
    for region in profile.get("legendRegions", []):
        # A bold "Fig. 1." label can sit a few points off the baseline of the legend text
        # on the same row, so order lines by row (centre within 4 pt) and then by x.
        for line in (line for row in lines_by_row(region_lines(doc, region), 4) for line in row):
            label = re.match(r"^Fig(?:ure)?\.?\s*(S?\d+)\b", line["text"])
            if label and line["box"][0] - region["box"][0] <= 5:
                legends.append(("Figure " + label[1], [line["text"]]))
            elif legends:
                legends[-1][1].append(line["text"])
            else:
                raise ValueError(f"Legend text before the first figure label: {line['text']}")
    for title, lines in legends:
        sections.append(make_section(title, "figure", [correct_text(join_lines(lines))]))
    records = references(doc, profile, metadata["sourceUrl"])
    if DEHYPHENATE:
        words = set()
        for page in doc:
            words.update(w.lower() for w in re.findall(r"[A-Za-z]+(?:-[A-Za-z]+)*", page.get_text()))
        for item in sections:
            item["paragraphs"] = [resolve_hyphens(text, words) for text in item["paragraphs"]]
            item["content"] = "\n\n".join(item["paragraphs"])
        for record in records:
            record["text"] = resolve_hyphens(record["text"], words)
    now = datetime.now(timezone.utc).isoformat()
    article = {**metadata, "createdAt": now, "sections": sections,
               "chunkCount": sum(len(s["paragraphs"]) for s in sections), "extractionSource": "pdf",
               "pdfExtraction": {"profileVersion": profile["version"], "pages": len(doc),
                                 "profileSha256": hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest(),
                                 "sha256": fingerprint,
                                 "warnings": profile.get("warnings", [])}}
    reference = {"id": metadata["id"], "title": metadata["title"], "sourceUrl": metadata["sourceUrl"],
                 "doi": metadata["doi"], "createdAt": now, "totalReferences": len(records),
                 "pubmedFound": 0, "abstractFound": 0, "records": records, "extractionSource": "pdf"}
    if "\ufffd" in json.dumps(article, ensure_ascii=False):
        raise ValueError("Replacement character in extracted text")
    for name, data in [("article", article), ("reference", reference)]:
        (output / (name + ".json")).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {"id": article["id"], "sections": [{"title": s["title"], "paragraphs": len(s["paragraphs"])} for s in sections],
               "references": len(records), "warnings": article["pdfExtraction"]["warnings"]}
    (output / "report.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    convert(args.pdf, json.loads(args.profile.read_text(encoding="utf-8")), args.output_dir)
