"""Compose labeled contact sheets from the shots (PIL). Big labels, 1x CSS size per crop.

python -I sheet.py <spec.json> <out.png>
spec = {"title": str, "note": str, "rows": [{"label": str, "items": [{"file": str, "label": str}]}]}
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

BG = (24, 26, 30)
INK = (240, 242, 245)
SUB = (154, 163, 173)
ITEM = (214, 219, 226)
LINE = (58, 62, 70)
GAP = 36
PAD = 48
LABEL_H = 36 * 2 + 8
FONT = "C:/Windows/Fonts/segoeuib.ttf"
FONT_KO = "C:/Windows/Fonts/malgunbd.ttf"


def font(size, text=""):
    path = FONT_KO if any("\uac00" <= ch <= "\ud7a3" for ch in text) else FONT
    return ImageFont.truetype(path, size)


def fit(draw, text, size, width):
    """The biggest font, from size down, that keeps one label line inside its crop."""
    while size > 24 and draw.textlength(text, font=font(size, text)) > width:
        size -= 2
    return font(size, text)


def load(path):
    image = Image.open(path).convert("RGB")
    # Shots are taken at 2x; the sheet shows them at CSS size.
    return image.resize((image.width // 2, image.height // 2), Image.LANCZOS)


def main(spec_path, out_path):
    spec = json.load(open(spec_path, encoding="utf-8"))
    rows = []
    for row in spec["rows"]:
        items = [(load(item["file"]), item["label"]) for item in row["items"]]
        rows.append((row["label"], items))
    item_label = 36
    row_label = 48
    width = max(sum(image.width for image, _ in items) + GAP * (len(items) - 1) for _, items in rows) + PAD * 2
    height = PAD + 70 + 40
    for _, items in rows:
        height += row_label + 18 + LABEL_H + 14 + max(image.height for image, _ in items) + GAP * 2
    sheet = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(sheet)
    draw.text((PAD, PAD), spec["title"], font=font(56, spec["title"]), fill=INK)
    if spec.get("note"):
        draw.text((PAD, PAD + 70), spec["note"], font=font(26, spec["note"]), fill=SUB)
    y = PAD + 70 + 40 + GAP
    for label, items in rows:
        draw.line((PAD, y - GAP // 2, width - PAD, y - GAP // 2), fill=LINE, width=2)
        draw.text((PAD, y), label, font=font(row_label, label), fill=INK)
        y += row_label + 18
        x = PAD
        tallest = max(image.height for image, _ in items)
        for image, text in items:
            # Two lines per crop, so a label never runs into the next one: where, then what.
            where, _, what = text.partition(" · ")
            draw.text((x, y), where, font=fit(draw, where, item_label, image.width), fill=INK)
            if what:
                draw.text((x, y + item_label + 8), what, font=fit(draw, what, item_label, image.width), fill=ITEM)
            sheet.paste(image, (x, y + LABEL_H + 14))
            draw.rectangle((x - 1, y + LABEL_H + 13, x + image.width, y + LABEL_H + 14 + image.height), outline=LINE, width=1)
            x += image.width + GAP
        y += LABEL_H + 14 + tallest + GAP * 2
    sheet.save(out_path, optimize=True)
    print(out_path, sheet.size)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
