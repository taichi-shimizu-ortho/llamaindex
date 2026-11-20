"""Extract visible Word body text, tables, and stable locators for manuscript review."""
import io
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MAX_XML_BYTES = 20 * 1024 * 1024

HEADINGS = {
    "abstract": "other",
    "introduction": "intro",
    "background": "intro",
    "methods": "methods",
    "materials and methods": "methods",
    "results": "results",
    "discussion": "discussion",
    "references": "references",
    "bibliography": "references",
    "tables": "tables",
    "figure legends": "figures",
    "figure captions": "figures",
    "conclusions": "conclusion",
    "conclusion": "conclusion",
}


def visible_text(node):
    if node.tag in {W + "del", W + "moveFrom", W + "txbxContent"}:
        return ""
    if node.tag == W + "t":
        return node.text or ""
    if node.tag == W + "tab":
        return "\t"
    if node.tag in {W + "br", W + "cr"}:
        return "\n"
    return "".join(map(visible_text, node))


def extract(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entry = archive.getinfo("word/document.xml")
        if entry.file_size > MAX_XML_BYTES:
            raise ValueError("The Word document body is too large.")
        xml = archive.read(entry)
    if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
        raise ValueError("Unsupported XML declaration in Word document.")
    body = ET.fromstring(xml).find(W + "body")
    if body is None:
        raise ValueError("The Word document has no body.")

    sections = {}
    references = {}
    notes = []
    section = "other"
    paragraph = table = 0
    title = ""
    current_reference = None
    for node in body:
        if node.tag == W + "p":
            paragraph += 1
            text = visible_text(node).strip()
            if not text:
                continue
            if not title:
                title = text
            heading = re.sub(r"^\d+(?:\.\d+)*[.)]?\s+", "", text).strip(" :").casefold()
            if heading in HEADINGS:
                section = HEADINGS[heading]
                continue
            if re.match(r"^(?:acknowledg|statements and declarations|conflicts? of interest|funding|author contributions|data availability)", heading):
                section = "other"
                continue
            if section == "references":
                entry = re.match(r"^(?:\[(\d+)\]|(\d+)[.)])\s*(.+)", text, re.S)
                if entry:
                    number = int(entry[1] or entry[2])
                    if number in references:
                        notes.append(f"Reference [{number}] occurs more than once.")
                        references[number] = ""
                        current_reference = None
                    else:
                        references[number] = entry[3]
                        current_reference = number
                elif current_reference is not None:
                    references[current_reference] += " " + text
                continue
            if section != "other":
                sections.setdefault(section, []).append({"location": f"P{paragraph}", "text": text})
        elif node.tag == W + "tbl":
            table += 1
            for row_number, row in enumerate(node.findall(W + "tr"), 1):
                cells = [" / ".join(filter(None, (visible_text(p).strip() for p in cell.findall(W + "p"))))
                         for cell in row.findall(W + "tc")]
                if any(cells):
                    sections.setdefault("tables", []).append({
                        "location": f"T{table}R{row_number}", "text": " | ".join(cells),
                    })
    if not references:
        notes.append("No numbered bibliography was detected. Citation mapping may be incomplete.")
    if body.find(".//" + W + "drawing") is not None:
        notes.append("Embedded images were not analyzed. Figure captions and Word table cells were extracted.")
    return {"title": title, "sections": sections, "references": {str(k): v for k, v in references.items() if v}, "notes": notes}


if __name__ == "__main__":
    try:
        print(json.dumps(extract(sys.stdin.buffer.read()), ensure_ascii=True))
    except (KeyError, ValueError, ET.ParseError, zipfile.BadZipFile) as exc:
        sys.exit(str(exc))
