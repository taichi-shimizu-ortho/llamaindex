"""Regression checks for publisher-specific paragraph extraction."""
import importlib.util
import unittest
from pathlib import Path

from bs4 import BeautifulSoup

spec = importlib.util.spec_from_file_location("mhtml_converter", Path(__file__).with_name("convert-local-mhtml.py"))
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class MhtmlImportTests(unittest.TestCase):
    def test_sciencedirect_preserves_nested_paragraphs(self):
        body = BeautifulSoup(
            '<article><h2>Results</h2><div class="u-margin-s-bottom">'
            '<div id="p0001" class="u-margin-s-bottom">First paragraph.</div>'
            '<div class="u-margin-s-bottom">Second paragraph.</div></div></article>',
            "html.parser",
        ).article
        sections = converter.extract_body(body, "sd")
        self.assertEqual(sections[0]["paragraphs"], ["First paragraph.", "Second paragraph."])

    def test_margin_class_does_not_create_paragraphs_for_other_publishers(self):
        body = BeautifulSoup(
            '<article><h2>Results</h2><div class="u-margin-s-bottom">Toolbar</div>'
            '<p>Results paragraph.</p></article>',
            "html.parser",
        ).article
        sections = converter.extract_body(body, "pmc")
        self.assertEqual(sections[0]["paragraphs"], ["Results paragraph."])
