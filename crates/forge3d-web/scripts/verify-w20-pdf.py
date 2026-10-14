"""Independent MuPDF parse/render smoke of exported installed-package PDFs."""
import json
from pathlib import Path
import sys
import fitz

paths = list(Path(sys.argv[1]).rglob('*.pdf'))
if not paths:
    raise SystemExit('No exported PDF attachments found')
reports = []
for path in paths:
    with fitz.open(path) as pdf:
        assert len(pdf) == 1
        page = pdf[0]
        assert abs(page.rect.width - 150) < 1e-6 and abs(page.rect.height - 75) < 1e-6
        assert 'Montaña & Peak' in page.get_text(), page.get_text()
        assert page.get_fonts() and page.get_drawings()
        pix = page.get_pixmap(matrix=fitz.Matrix(96 / 72, 96 / 72), alpha=False)
        assert (pix.width, pix.height) == (200, 100)
        assert pix.pixel(10, 80) == (255, 0, 0), pix.pixel(10, 80)
        assert pix.pixel(100, 65) == (255, 255, 255), pix.pixel(100, 65)
        assert pix.pixel(100, 50) == (0, 0, 255), pix.pixel(100, 50)
        dark = sum(max(pix.pixel(x, y)) < 100 for y in range(5, 24) for x in range(35, 165))
        assert dark > 20, dark
        reports.append({'file':str(path),'pages':len(pdf),'fonts':len(page.get_fonts()),'paths':len(page.get_drawings()),'text':page.get_text().strip(),'darkTextPixels':dark,'renderPixels':[pix.width,pix.height]})
print(json.dumps({'renderer':'PyMuPDF '+fitz.VersionBind,'results':reports},indent=2))
