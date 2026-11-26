"""Regression checks for two-column order, wrapped references and profile mismatch.

Run with .venv/bin/python -m unittest discover -s scripts -p 'test_pdf_import.py'
"""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pymupdf

spec = importlib.util.spec_from_file_location("pdf_converter", Path(__file__).with_name("convert-local-pdf.py"))
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class PdfImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.pdf = self.root / "source.pdf"
        doc = pymupdf.open()
        page = doc.new_page(width=600, height=800)
        for x, y, text in [(50, 30, "DOI: 10.1234/example"), (50, 50, "A complete abstract."),
                           (50, 80, "BACKGROUND"), (64, 100, "Left starts and"),
                           (50, 114, "continues"), (300, 100, "across the column."),
                           (314, 120, "Next paragraph."), (50, 260, "1. First author."),
                           (70, 274, "Journal. 2024;1:82-"), (70, 288, "96. https://doi.org/10.1234/ref1"),
                           (50, 310, "2."), (70, 310, "Second author."),
                           (70, 324, "Journal. 2024;1:100-110.")]:
            page.insert_text((x, y), text, fontsize=10)
        page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(70, 277, 260, 290), "uri": "https://doi.org/10.1234/ref1"})
        doc.save(self.pdf)
        doc.close()
        self.profile = {"version": 1, "pageCount": 1,
                        "metadata": {"id": "Author2024", "doi": "10.1234/example", "title": "Example", "sourceUrl": "https://doi.org/10.1234/example"},
                        "abstractRegion": {"page": 1, "box": [49, 38, 550, 55]},
                        "bodyRegions": [{"page": 1, "box": [49, 68, 250, 130]}, {"page": 1, "box": [299, 88, 550, 130]}],
                        "headings": [{"match": "BACKGROUND", "title": "Background", "type": "intro"}],
                        "referenceRegions": [{"page": 1, "box": [49, 248, 550, 330]}], "expectedReferences": 2}

    def test_column_continuations_and_hanging_references(self):
        out = self.root / "out"
        converter.convert(self.pdf, self.profile, out)
        article = json.loads((out / "article.json").read_text())
        self.assertEqual(article["sections"][1]["paragraphs"], ["Left starts and continues across the column.", "Next paragraph."])
        refs = json.loads((out / "reference.json").read_text())["records"]
        self.assertEqual([r["index"] for r in refs], [1, 2])
        self.assertIn("82-96.", refs[0]["text"])
        self.assertEqual(refs[0]["doi"], "10.1234/ref1")
        self.assertTrue(refs[1]["text"].startswith("Second author."))

    def test_wrong_pdf_is_rejected(self):
        self.profile["metadata"]["doi"] = "10.1234/different"
        with self.assertRaisesRegex(ValueError, "DOI"):
            converter.convert(self.pdf, self.profile, self.root / "out")

    def test_rebuild_orders_fragments_left_to_right_on_the_same_row(self):
        with pymupdf.open() as doc, patch.object(converter, "REBUILD_LINES", True):
            page = doc.new_page(width=600, height=800)
            page.insert_text((60, 101), "first", fontsize=10)
            page.insert_text((120, 100), "second", fontsize=10)
            page.insert_text((60, 116), "next row", fontsize=10)
            lines = converter.region_lines(doc, {"page": 1, "box": [50, 80, 200, 130]})
        self.assertEqual([line["text"] for line in lines], ["first second", "next row"])

    def test_scanned_or_empty_region_is_rejected(self):
        self.profile["abstractRegion"]["box"] = [49, 400, 550, 450]
        with self.assertRaisesRegex(ValueError, "OCR"):
            converter.convert(self.pdf, self.profile, self.root / "out")


if __name__ == "__main__":
    unittest.main()
