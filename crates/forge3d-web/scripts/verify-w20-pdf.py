"""Independent MuPDF parse/render smoke of exported installed-package PDFs."""
import json
import base64
from pathlib import Path
import sys
import fitz

source = Path(sys.argv[1])
exports = []
if source.is_file() and source.suffix == '.json':
    def collect(value):
        if isinstance(value, dict):
            for attachment in value.get('attachments', []):
                if attachment.get('name') in ('cartography.pdf','arabic.pdf','devanagari.pdf') and attachment.get('contentType') == 'application/pdf':
                    if 'body' in attachment:
                        exports.append((attachment['name'], base64.b64decode(attachment['body'], validate=True)))
                    elif 'path' in attachment:
                        path = Path(attachment['path'])
                        exports.append((attachment['name'], path.read_bytes()))
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)
    collect(json.loads(source.read_text(encoding='utf-8')))
else:
    exports = [(str(path), path.read_bytes()) for path in source.rglob('*.pdf')]
if source.suffix == '.json':
    assert {'cartography.pdf','arabic.pdf','devanagari.pdf'} <= {name for name,_ in exports}, 'Missing independent script PDF coverage'
if not exports:
    raise SystemExit('No exported PDF attachments found')
reports = []
for path, data in exports:
    with fitz.open(stream=data, filetype='pdf') as pdf:
        assert len(pdf) == 1
        page = pdf[0]
        fonts = page.get_fonts()
        assert fonts
        pix = page.get_pixmap(matrix=fitz.Matrix(96 / 72, 96 / 72), alpha=False)
        if path in ('arabic.pdf','devanagari.pdf'):
            text, family = ('مرحبا بالعالم','NotoSansArabic') if path == 'arabic.pdf' else ('नमस्ते','NotoSansDevanagari')
            assert abs(page.rect.width - 225) < 1e-6 and abs(page.rect.height - 75) < 1e-6
            assert text in page.get_text(), repr(page.get_text())
            assert any(family in f[3] for f in fonts), fonts
            assert (pix.width,pix.height) == (300,100)
            dark = sum(max(pix.pixel(x,y)) < 120 for y in range(20,80) for x in range(10,290))
            assert dark > 100, dark
            assert pix.pixel(0,0) == (255,255,255)
        else:
            assert abs(page.rect.width - 150) < 1e-6 and abs(page.rect.height - 75) < 1e-6
            assert 'Montaña & Peak' in page.get_text(), page.get_text()
            assert page.get_drawings()
            assert (pix.width, pix.height) == (200, 100)
            assert pix.pixel(10, 80) == (255, 0, 0), pix.pixel(10, 80)
            assert pix.pixel(100, 65) == (255, 255, 255), pix.pixel(100, 65)
            assert pix.pixel(100, 50) == (0, 0, 255), pix.pixel(100, 50)
            dark = sum(max(pix.pixel(x, y)) < 100 for y in range(5, 24) for x in range(35, 165))
            assert dark > 20, dark
        reports.append({'file':str(path),'pages':len(pdf),'fonts':len(fonts),'paths':len(page.get_drawings()),'text':page.get_text().strip(),'darkTextPixels':dark,'renderPixels':[pix.width,pix.height]})
print(json.dumps({'renderer':'PyMuPDF '+fitz.VersionBind,'results':reports},indent=2))
