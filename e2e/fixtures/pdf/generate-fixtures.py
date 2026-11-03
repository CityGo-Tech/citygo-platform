"""Synthetic local PDF fixtures only; no customer data. Run with reportlab + pypdf."""
from pathlib import Path
from io import BytesIO
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pdfencrypt import StandardEncryption
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter

OUT = Path(__file__).resolve().parent
# The fixture embeds only a subset. Liberation/DejaVu Sans can be passed on Linux.
import os
FONT = os.environ.get("CITYGO_FIXTURE_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
pdfmetrics.registerFont(TTFont("FixtureSans", FONT))

def document(name, pages, password=None):
    buf = BytesIO()
    encryption = StandardEncryption(password, ownerPassword="fixture-owner-only") if password else None
    c = canvas.Canvas(buf, pagesize=(595, 842), invariant=1, encrypt=encryption)
    c.setTitle("CityGo synthetic parser test")
    for lines in pages:
        c.setFont("FixtureSans", 11)
        text = c.beginText(48, 790)
        text.setLeading(15)
        for line in lines: text.textLine(line)
        c.drawText(text)
        c.showPage()
    c.save()
    (OUT / name).write_bytes(buf.getvalue())

document("cyrillic.pdf", [["Резюме для переезда", "Город: Москва", "Бюджет: 50 000 рублей"], ["Опыт работы: инженер", "Ищу жильё рядом с метро"]])
document("long-text.pdf", [["Строка %03d: проверенный материал для самостоятельного выбора фрагмента." % n for n in range(i, i + 45)] for i in (0, 45)])
document("password.pdf", [["Этот документ защищён тестовым паролем"]], "fixture-only")
document("too-many-pages.pdf", [["Синтетическая страница %d" % n] for n in range(1, 52)])
# A genuine embedded raster, deliberately without a searchable text layer.
image = Image.new("RGB", (300, 420), "white")
draw = ImageDraw.Draw(image)
draw.text((20, 20), "SYNTHETIC SCAN - NO TEXT LAYER", fill="black")
for y in range(60, 350, 20): draw.rectangle((20, y, 240, y + 3), fill=(60, 60, 60))
buf = BytesIO(); c = canvas.Canvas(buf, pagesize=(595, 842), invariant=1)
c.drawImage(ImageReader(image), 45, 45, width=500, height=700); c.save()
(OUT / "scan-no-text.pdf").write_bytes(buf.getvalue())
writer = PdfWriter(); writer.append(PdfReader(OUT / "cyrillic.pdf"))
writer.add_js("globalThis.CITYGO_PDF_SCRIPT_EXECUTED = true;")
writer.add_uri(0, "https://pdf-fixture.invalid/private-document", [45, 650, 300, 720])
with (OUT / "active-content.pdf").open("wb") as f: writer.write(f)
for f in sorted(OUT.glob("*.pdf")):
    reader = PdfReader(f)
    if reader.is_encrypted: assert reader.decrypt("fixture-only")
    print(f.name, len(reader.pages), f.stat().st_size)
