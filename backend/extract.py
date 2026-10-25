"""Read-only PDF extraction for the local Zotero bilingual reader.

The CLI writes one JSON value to stdout, including on failure. Diagnostics use
stderr. All coordinates are unrotated PDF points, with one-based page numbers.
"""
from __future__ import annotations

import argparse
import hashlib
from collections import Counter
from contextlib import redirect_stdout
import json
from pathlib import Path
import re
from statistics import median
import sys
import unicodedata


CAPTION = re.compile(r"^(?:(?:Extended\s+Data|Supplementary|Supporting)\s+)?(?:Fig(?:ure)?s?\.?|Tables?)\s*[A-Z]?\d+[a-z]?(?:\b|[.:])", re.I)
SECTION = re.compile(r"^(?:(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+)?(?:abstract|introduction|background|results(?:\s+and\s+discussion)?|discussion|conclusions?|materials\s+and\s+methods|(?:online\s+)?methods|limitations?|references|acknowledg(?:e)?ments?|author\s+contributions?|data\s+availability|code\s+availability|competing\s+(?:financial\s+)?interests?|supplementary\s+information|experimental\s+procedures)\s*[:.]?$", re.I)


def area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def union(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def overlap(a, b):
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def nearby(a, b, gap=7):
    return not (a[2] + gap < b[0] or b[2] + gap < a[0] or a[3] + gap < b[1] or b[3] + gap < a[1])


def clip_box(box, bounds, pad=0):
    return (max(bounds[0], box[0] - pad), max(bounds[1], box[1] - pad), min(bounds[2], box[2] + pad), min(bounds[3], box[3] + pad))


def join_lines(lines):
    """Remove PDF line wrapping while retaining intentional compound hyphens."""
    result = ""
    compounds = {"long", "short", "high", "low", "well", "large", "small", "single", "double", "wild", "first", "second", "third", "cross"}
    for line in lines:
        line = unicodedata.normalize("NFC", line).strip()
        if line.endswith("\u00ad"):
            line = line[:-1] + "-"
        line = line.replace("\u00ad", "").translate(str.maketrans({"ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl"}))
        if not line:
            continue
        match = re.search(r"([A-Za-z]{2,})-$", result)
        if match and line[0].islower():
            if match[1].lower() not in compounds:
                result = result[:-1]
            result += line
        else:
            result += (" " if result else "") + line
    return re.sub(r"[ \t]+", " ", result).strip()


def bold_font(font, flags=0):
    return bool(flags & 16 or re.search(r"bold|black|heavy|(?:^|[_-])b(?:$|[_-])", font, re.I))


def heading_fonts(document):
    """Infer unusual section faces without treating the body face as a heading."""
    import pymupdf

    known, narrative = set(), Counter()
    for page in document:
        for block in page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)["blocks"]:
            if block.get("type") != 0:
                continue
            lines = block.get("lines", [])
            long_block = sum(len(s.get("text", "")) for l in lines for s in l["spans"]) >= 250
            for line in lines:
                text = "".join(s.get("text", "") for s in line["spans"]).strip()
                for span in line["spans"]:
                    font = span.get("font", "")
                    if SECTION.fullmatch(text) and not bold_font(font, span.get("flags", 0)):
                        known.add(font)
                    if long_block:
                        narrative[font] += len(span.get("text", ""))
    limit = sum(narrative.values()) * .08
    return {font for font in known if narrative[font] < limit}


def heading_line(line, section_fonts):
    text = "".join(s.get("text", "") for s in line["spans"]).strip()
    if SECTION.fullmatch(text):
        return True
    count = sum(len(s.get("text", "")) for s in line["spans"])
    styled = sum(len(s.get("text", "")) for s in line["spans"] if s.get("font") in section_fonts)
    words = re.findall(r"[^\W\d_]{2,}", text)
    return bool(5 < len(text) < 100 and 2 <= len(words) <= 12
                and not text.endswith((".", ";", "?", "!")) and styled > count * .5)


def native_text(page, section_fonts=frozenset()):
    import pymupdf

    flags = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    records = []
    for block in page.get_text("dict", flags=flags, sort=False)["blocks"]:
        if block.get("type") != 0:
            continue
        groups, group, previous_heading = [], [], False
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            # A PDF text block can contain independent columns or table cells.
            is_heading = heading_line(line, section_fonts)
            if group and (is_heading or previous_heading
                          or abs(line["bbox"][0] - group[-1]["bbox"][0]) > page.rect.width * .19
                          or line["bbox"][1] + 2 < group[-1]["bbox"][1]):
                groups.append(group)
                group = []
            group.append(line)
            previous_heading = is_heading
        if group:
            groups.append(group)
        for lines in groups:
            texts, sizes, bold, math_chars, heading_chars = [], [], 0, 0, 0
            char_count = 0
            for line in lines:
                text, previous = "", None
                for span in line["spans"]:
                    value = span.get("text", "")
                    if previous and value and text and not text[-1].isspace() and not value[0].isspace():
                        gap = span["bbox"][0] - previous["bbox"][2]
                        if gap > max(span["size"], previous["size"]) * .22:
                            text += " "
                    text += value
                    weight = max(1, len(value.strip()))
                    sizes.extend([float(span["size"])] * weight)
                    char_count += weight
                    font = span.get("font", "").lower()
                    if bold_font(font, span.get("flags", 0)):
                        bold += weight
                    if span.get("font") in section_fonts:
                        heading_chars += weight
                    if any(name in font for name in ("symbol", "math", "cmmi", "cmsy", "cmex", "stix")):
                        math_chars += weight
                    previous = span
                texts.append(text)
            original = join_lines(texts)
            box = union([line["bbox"] for line in lines])
            if original and area(box) > 0:
                records.append({"bbox": box, "original": original, "size": median(sizes),
                                "bold": bold > char_count / 2, "math": math_chars / max(1, char_count),
                                "headingFont": heading_chars > char_count * .5,
                                "vertical": any(abs(line.get("dir", (1, 0))[1]) > .5 for line in lines),
                                "lineBboxes": [tuple(line['bbox']) for line in lines],
                                "lineCount": len(lines), "type": "paragraph", "confidence": "high"})
    return records


def body_font_size(records):
    frequencies = Counter()
    for record in records:
        if len(record["original"]) >= 250 and record["lineCount"] >= 3 and record["size"] >= 7 and not CAPTION.match(record["original"]):
            frequencies[round(record["size"], 1)] += len(record["original"])
    if not frequencies:
        for record in records:
            frequencies[round(record["size"], 1)] += len(record["original"])
    return frequencies.most_common(1)[0][0] if frequencies else 10


def classify_text(records, page=None, body_size=None):
    body_size = body_size or body_font_size(records)
    for record in records:
        text = record["original"]
        words = re.findall(r"[^\W\d_]{2,}", text)
        heading_shape = (5 < len(text) < 180 and record["lineCount"] <= 3 and text.count(",") <= 1
                         and not text.endswith((".", ";", "?", "!"))
                         and (len(words) >= 2 or len(words) == 1 and len(words[0]) >= 6)
                         and sum(c.isdigit() for c in text) < max(2, len(text) * .15))
        if CAPTION.match(text):
            record["type"] = "caption"
        elif page is not None and (
            record["vertical"] and (record["bbox"][0] > page.rect.width * .9 or record["bbox"][2] < page.rect.width * .1)
            or re.match(r"^(?:Downloaded from\b|Received:|C[⃝©]|©)", text, re.I)
            or record["bbox"][1] > page.rect.height * .88 and len(text) < 500
            and (record["size"] < body_size * .92 or text.isdigit())
            or record["bbox"][1] < page.rect.height * .08
            and re.sub(r"\s+", "", text).upper() in {"ARTICLES", "ARTICLE", "LETTERS", "LETTER"}
        ):
            record["type"] = "note"
        elif SECTION.fullmatch(text) or heading_shape and (
            record["size"] >= body_size * 1.45
            or record["headingFont"] and record["size"] >= body_size * .8 and len(words) <= 12 and len(text) < 100
            or record["bold"] and record["size"] >= body_size * .95 and len(words) <= 16 and len(text) < 140
        ):
            record["type"] = "heading"
    return body_size


def reading_order(records, page_width):
    """Use gutters before y coordinates so independent columns stay together.

    Full-width blocks split a page into horizontal bands; columns are recovered
    separately within each band. No source text is dropped by this ordering.
    """
    if len(records) < 2:
        return records
    marginal = [r for r in records if r["type"] == "note"]
    if marginal:
        return reading_order([r for r in records if r["type"] != "note"], page_width) + sorted(marginal, key=lambda r: (r["bbox"][1], r["bbox"][0]))
    projected = sorted((r["bbox"][0], r["bbox"][2]) for r in records
                       if r["bbox"][2] - r["bbox"][0] < page_width * .64
                       and not (r["bbox"][0] < page_width * .4 and r["bbox"][2] > page_width * .6))
    merged = []
    for start, end in projected:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    gaps = [(b[0] - a[1], (a[1] + b[0]) / 2) for a, b in zip(merged, merged[1:])
            # Compact journal columns can have a gutter of only 10–12 pt.
            # These are gaps in the union of complete block projections, not
            # spaces between words; a 2.5%-of-page cutoff discarded real gutters.
            if b[0] - a[1] >= max(3, page_width * .008) and page_width * .22 < (a[1] + b[0]) / 2 < page_width * .78]
    # A DOI/address footer may bridge the gutter without spanning the whole
    # page. Recover column evidence from overlapping, similarly sized prose
    # blocks instead of requiring a gap in the union of *every* projection.
    columns = [r for r in records if page_width * .28 <= r['bbox'][2] - r['bbox'][0] <= page_width * .55]
    for a in columns:
        ax0, ay0, ax1, ay1 = a['bbox']
        for b in columns:
            bx0, by0, bx1, by1 = b['bbox']
            gap = bx0 - ax1
            overlap = min(ay1, by1) - max(ay0, by0)
            if (max(3, page_width * .008) <= gap <= page_width * .15
                    and ax0 < page_width * .4 < bx0
                    and min(ax1-ax0, bx1-bx0) >= max(ax1-ax0, bx1-bx0) * .65
                    and overlap >= min(ay1-ay0, by1-by0) * .25 and overlap >= 8):
                gaps.append((gap, (ax1 + bx0) / 2))
    # Pick a gutter supported by the whole prose region, not the widest space
    # after a short heading. A cut through a substantial column paragraph is
    # evidence against that gutter; figures/captions are independent floats.
    prose = [r for r in records if r['type'] in ('paragraph', 'heading')
             and page_width * .18 <= r['bbox'][2] - r['bbox'][0] <= page_width * .6]

    def gutter_score(candidate):
        gap, cut = candidate
        weights = [0., 0., 0.]
        for record in prose:
            x0, y0, x1, y1 = record['bbox']
            side = 0 if x1 <= cut else 1 if x0 >= cut else 2
            weights[side] += max(1, y1-y0)
        support = min(weights[0], weights[1])
        # Full-width material is handled below as horizontal band boundaries.
        # Narrow crossing material (e.g. a DOI) can remain a spanning block,
        # but may not outweigh hundreds of lines of coherent column evidence.
        return (weights[2] / max(1, support), -support, -gap, cut)

    for _, cut in sorted(set(gaps), key=gutter_score):
        left = [r for r in records if r["bbox"][2] <= cut]
        right = [r for r in records if r["bbox"][0] >= cut]
        spanning = [r for r in records if r not in left and r not in right]
        if not left or not right:
            continue
        if not spanning:
            return reading_order(left, page_width) + reading_order(right, page_width)
        spanning.sort(key=lambda r: (r["bbox"][1], r["bbox"][0]))
        remaining = left + right
        ordered = []
        for span in spanning:
            before = [r for r in remaining if (r["bbox"][1] + r["bbox"][3]) / 2 < (span["bbox"][1] + span["bbox"][3]) / 2]
            ordered.extend(reading_order(before, page_width))
            ordered.append(span)
            remaining = [r for r in remaining if r not in before]
        return ordered + reading_order(remaining, page_width)
    return sorted(records, key=lambda r: (round(r["bbox"][1], 1), r["bbox"][0]))


def cluster_boxes(boxes, gap=7):
    groups = []
    for box in boxes:
        current = box
        while True:
            touching = [other for other in groups if nearby(current, other, gap)]
            if not touching:
                break
            current = union([current, *touching])
            groups = [other for other in groups if other not in touching]
        groups.append(current)
    return groups


def equation(record, width):
    text = record["original"]
    if record["type"] != "paragraph" or len(text) > 220 or record["lineCount"] > 4:
        return False
    operators = sum(text.count(char) for char in "=∑∫√≈≤≥∂∏∞∝±")
    words = re.findall(r"[A-Za-z]{3,}", text)
    centered = abs((record["bbox"][0] + record["bbox"][2]) / 2 - width / 2) < width * .3
    return bool(centered and (record["math"] > .3 and operators or operators and len(words) <= 5
                              and (re.search(r"\(\d+[a-z]?\)\s*$", text) or re.search(r"[∑∫√∂∏∞]", text))))


def layout_boxes(document, notes):
    """Load library layout metadata once; native text remains the source of truth."""
    try:
        import pymupdf4llm

        chunks = pymupdf4llm.to_markdown(document, page_chunks=True, extract_words=True,
                                        show_progress=False, write_images=False)
        if not isinstance(chunks, list):
            return {}
        result = {}
        for index, chunk in enumerate(chunks):
            boxes = list(chunk.get("page_boxes", []))
            # v0.x exposes these source boxes rather than v2's page_boxes.
            for key, label in (("tables", "table"), ("images", "figure"), ("graphics", "figure")):
                for item in chunk.get(key, []):
                    if isinstance(item, dict) and item.get("bbox"):
                        boxes.append({"class": label, "bbox": item["bbox"]})
            result[index] = boxes
        return result
    except Exception as error:
        notes.append(f"Layout analysis unavailable ({type(error).__name__}); native PDF geometry is used and complex reading order may need review.")
        print(f"Layout fallback: {error}", file=sys.stderr)
        return {}


def complete_visual_regions(page, records, visuals, body_size=None):
    """Use captions and prose boundaries to recover complete figure/table regions.

    Drawing bounds omit text painted independently by the PDF. Include native
    text and all panels within the caption's region, stopping at narrative text.
    Uncertain/unassociated graphics retain their original extraction path.
    """
    bounds = tuple(page.mediabox)
    width, height = page.rect.width, page.rect.height
    body_size = body_size or body_font_size(records)
    captions = [r for r in records if r['type'] == 'caption']
    prose_records = [r for r in records if r['type'] != 'caption' and not r.get('vertical') and (
        r['type'] == 'heading' or len(r['original']) >= 90 and r.get('lineCount', 0) >= 2
        and r.get('size', body_size) >= body_size * .88)]
    # Text can wrap alongside a tall illustration and continue under it. A
    # paragraph's union rectangle crosses the picture; individual lines do not.
    prose = [{'bbox':box} for r in prose_records for box in r.get('lineBboxes', [r['bbox']])]
    content = [r['bbox'] for r in records if not r.get('vertical') and r['bbox'][0] >= width * .04
               and r['bbox'][2] <= width * .97 and r['bbox'][1] > height * .07 and r['bbox'][3] < height * .94]
    if not content:
        return []
    left, _, right, _ = union(content)
    drawings = [tuple(d['rect']) for d in page.get_drawings()]
    images = [tuple(i['bbox']) for i in page.get_image_info()]
    result, used = [], set()
    def intersects_x(a, b):
        return min(a[2], b[2]) > max(a[0], b[0])
    def centered_in(box, region):
        return region[0] <= (box[0]+box[2])/2 <= region[2] and region[1] <= (box[1]+box[3])/2 <= region[3]
    for caption in captions:
        cap = caption['bbox']
        kind = 'table' if re.match(r'^(?:(?:Supplementary|Extended\s+Data)\s+)?Table', caption['original'], re.I) else 'figure'
        candidates = [(i,v) for i,v in enumerate(visuals) if i not in used and v['type'] == kind]
        region = None
        # Captions beside tall multi-panel figures (e.g. Nature's narrow side column).
        if kind == 'figure' and cap[2] - cap[0] < width * .5:
            for side in ('left', 'right'):
                side_candidates = [(i,v) for i,v in candidates if (v['bbox'][2] <= cap[0] + 3 if side == 'left' else v['bbox'][0] >= cap[2] - 3)]
                aligned = [(i,v) for i,v in side_candidates if abs(v['bbox'][1] - cap[1]) < 55]
                if not aligned:
                    continue
                x0, x1 = (left, cap[0] - 8) if side == 'left' else (cap[2] + 8, right)
                top = min(cap[1], min(v['bbox'][1] for _,v in aligned)) - 6
                blockers = [r['bbox'][1] for r in prose + captions if r is not caption and r['bbox'][1] > top + 30
                            and intersects_x(r['bbox'], (x0,top,x1,height))]
                bottom = min(blockers, default=height * .94) - 5
                region = (x0-3, top, x1, bottom)
                break
        if region is None:
            above = [(i,v) for i,v in candidates if v['bbox'][3] <= cap[1]+4 and intersects_x(v['bbox'], cap)]
            below = [(i,v) for i,v in candidates if v['bbox'][1] >= cap[3]-4 and intersects_x(v['bbox'], cap)]
            above_gap = min((cap[1]-v['bbox'][3] for _,v in above), default=float('inf'))
            below_gap = min((v['bbox'][1]-cap[3] for _,v in below), default=float('inf'))
            before = kind == 'figure' and above_gap <= below_gap and above_gap < 140
            if kind == 'figure' and not before and below_gap > 100:
                continue
            # A wide caption generally spans its complete set of panels.
            x0, x1 = (left-3, right+3) if cap[2]-cap[0] >= width*.6 else (cap[0]-5, cap[2]+5)
            if kind == 'table':
                rules = [b for b in drawings if cap[3] <= b[1] < cap[3]+40 and b[3]-b[1] < 3
                         and b[2]-b[0] > (cap[2]-cap[0])*.7]
                if rules:
                    rule = union(rules); x0, x1 = rule[0]-3, rule[2]+3
            if before:
                barriers = [r['bbox'][3] for r in prose + captions if r is not caption and r['bbox'][3] < cap[1]
                            and intersects_x(r['bbox'], (x0,0,x1,cap[1]))]
                region = (x0, max(barriers, default=height*.07)+5, x1, cap[1]-3)
            else:
                barriers = [r['bbox'][1] for r in prose + captions if r is not caption and r['bbox'][1] > cap[3]+10
                            and intersects_x(r['bbox'], (x0,cap[3],x1,height))]
                region = (x0, cap[3]+3, x1, min(barriers, default=height*.94)-5)
        if region[3] - region[1] < 35:
            continue
        members = [i for i,v in candidates if centered_in(v['bbox'], region)]
        # Image/table text is not prose; all its bounds, including edge labels,
        # participate in the crop. Copyright margins and neighboring prose do not.
        text_boxes = [r['bbox'] for r in records if r not in captions and r not in prose_records and not r.get('vertical')
                      and not re.search(r'©|All rights reserved', r['original'], re.I)
                      and centered_in(r['bbox'], region)]
        graphic_boxes = [b for b in drawings + images if centered_in(b, region)
                         and b[0] >= region[0]-4 and b[2] <= region[2]+4
                         and b[1] >= region[1]-4 and b[3] <= region[3]+4]
        if not members and (kind != 'table' or len(text_boxes) < 6 or not graphic_boxes):
            continue
        boxes = text_boxes + graphic_boxes + [visuals[i]['bbox'] for i in members]
        if not boxes:
            continue
        crop = clip_box(union(boxes), bounds, 4)
        # Reject ambiguous geometry instead of including half a narrative column.
        if any(overlap(crop,r['bbox']) > area(r['bbox'])*.08 for r in prose):
            continue
        if area(crop) > area(bounds)*.85:
            continue
        result.append({'type':kind,'bbox':crop,'confidence':'high', 'captionOriginal':caption['original'],
                       'captionBBox':cap,'memberIndexes':members})
        used.update(members)
    return result


def extract_document(document, out):
    notes, all_records, ocr_pages = [], [], []
    incomplete = False
    assets_dir = out / "assets"
    assets_dir.mkdir(exist_ok=True)
    semantic_pages = layout_boxes(document, notes)
    section_fonts = heading_fonts(document)
    text_pages = {}
    for index, page in enumerate(document):
        try:
            text_pages[index] = native_text(page, section_fonts)
        except Exception:
            pass  # The normal per-page error path below reports this failure.
    body_size = body_font_size([record for records in text_pages.values() for record in records])
    for page_index, page in enumerate(document):
        number = page_index + 1
        try:
            records = text_pages[page_index] if page_index in text_pages else native_text(page, section_fonts)
            classify_text(records, page, body_size)
            bounds = tuple(page.mediabox)
            page_area = area(bounds)
            images = [tuple(image["bbox"]) for image in page.get_image_info()]
            drawings = page.get_drawings()
            native_chars = sum(len(r["original"]) for r in records)
            bad_chars = sum(sum(unicodedata.category(c) == "Co" or c == "\ufffd" for c in r["original"]) for r in records)
            large_raster = max([area(clip_box(box, bounds)) / page_area for box in images] or [0])
            scanned = large_raster > .6 and native_chars < 250 and not any(r["type"] == "caption" for r in records)
            corrupt = native_chars > 20 and bad_chars / native_chars > .04
            if scanned or corrupt:
                ocr_pages.append(number)
                incomplete = True
                reason = "a large raster region has no usable text layer" if scanned else "the text layer contains undecodable glyphs"
                notes.append(f"Page {number}: OCR required; {reason}. Available selectable text is retained, but this page is incomplete.")
                records.append({"type": "note", "original": "", "bbox": bounds, "confidence": "low"})
                for record in records:
                    record["confidence"] = "low"
            elif not native_chars and not images and not drawings:
                notes.append(f"Page {number}: blank page; no selectable text or graphics.")
                records.append({"type": "note", "original": "", "bbox": bounds, "confidence": "low"})

            visuals = []
            # Tables retain their exact rendered cell geometry, including vectors.
            try:
                finder = page.find_tables()
                for table in finder.tables:
                    box = clip_box(tuple(table.bbox), bounds, 2)
                    if area(box) > 100:
                        visuals.append({"type": "table", "bbox": box, "confidence": "high"})
            except Exception as error:
                notes.append(f"Page {number}: table geometry could not be analyzed ({type(error).__name__}); selectable text is retained.")

            # Layout metadata is optional; its boxes help group multi-panel figures.
            for item in semantic_pages.get(page_index, []):
                if not isinstance(item, dict):
                    continue
                label = str(item.get("class", item.get("type", ""))).lower()
                box = item.get("bbox")
                if not box or len(box) != 4:
                    continue
                kind = "equation" if any(s in label for s in ("equation", "formula")) else "table" if "table" in label else "figure" if any(s in label for s in ("picture", "figure", "image")) else None
                if kind and not scanned:
                    box = clip_box(tuple(box), bounds, 2)
                    if .002 < area(box) / page_area < .85 and not any(overlap(box, v["bbox"]) > .7 * min(area(box), area(v["bbox"])) for v in visuals):
                        visuals.append({"type": kind, "bbox": box, "confidence": "high"})
                elif "caption" in label:
                    for record in records:
                        if overlap(record["bbox"], box) > area(record["bbox"]) * .7:
                            record["type"] = "caption"

            graphic_boxes = []
            if not scanned:
                for box in images:
                    box = clip_box(box, bounds)
                    if .002 < area(box) / page_area < .72 and box[2] - box[0] > 30 and box[3] - box[1] > 25:
                        graphic_boxes.append(box)
                vector_boxes = []
                for drawing in drawings:
                    box = clip_box(tuple(drawing["rect"]), bounds, .5)
                    if 0 < area(box) / page_area < .72:
                        vector_boxes.append(box)
                for box in cluster_boxes(vector_boxes):
                    if box[2] - box[0] >= 35 and box[3] - box[1] >= 25 and area(box) / page_area > .002:
                        # Shaded text boxes are prose, rather than illustrations.
                        contained = [r for r in records if r["type"] == "paragraph" and overlap(r["bbox"], box) > .8 * area(r["bbox"])]
                        if any(len(r["original"]) > 450 and r["lineCount"] >= 5 for r in contained):
                            continue
                        graphic_boxes.append(box)
                for box in cluster_boxes(graphic_boxes):
                    if not any(overlap(box, v["bbox"]) > .5 * min(area(box), area(v["bbox"])) for v in visuals):
                        visuals.append({"type": "figure", "bbox": clip_box(box, bounds, 3), "confidence": "medium"})

            # Nearby, aligned panels with one shared caption form one figure.
            for caption in [r for r in records if r["type"] == "caption" and re.match(r"^(?:(?:Extended\s+Data|Supplementary)\s+)?Fig", r["original"], re.I)]:
                panels = [v for v in visuals if v["type"] == "figure"
                          and 0 <= caption["bbox"][1] - v["bbox"][3] < 75
                          and min(caption["bbox"][2], v["bbox"][2]) > max(caption["bbox"][0], v["bbox"][0])]
                if len(panels) > 1 and max(v["bbox"][3] for v in panels) - min(v["bbox"][3] for v in panels) < 40:
                    box = union([v["bbox"] for v in panels])
                    if area(box) / page_area < .72:
                        visuals = [v for v in visuals if v not in panels]
                        visuals.append({"type": "figure", "bbox": box, "confidence": "medium"})

            visuals = [v for v in visuals if not (v["type"] == "figure" and v["bbox"][3] < page.rect.height * .15
                       and area(v["bbox"]) / page_area < .025
                       and not any(r["type"] == "caption" and 0 <= r["bbox"][1] - v["bbox"][3] < 140 for r in records))]
            for visual in [v for v in visuals if v["type"] == "figure"]:
                # Detached panel letters/axis glyphs can be smaller than the
                # drawing-cluster filter. Include nearby vector marks too.
                box = visual["bbox"]
                labels = [tuple(d["rect"]) for d in drawings
                          if nearby(box, tuple(d["rect"]), 14) and area(tuple(d["rect"])) < area(box) * .15]
                if labels:
                    visual["bbox"] = clip_box(union([box, *labels]), bounds, 2)

            for record in records:
                if equation(record, page.rect.width):
                    visuals.append({"type": "equation", "bbox": clip_box(record["bbox"], bounds, 3), "confidence": "medium"})
            complete = complete_visual_regions(page, records, visuals, body_size)
            grouped = {index for visual in complete for index in visual['memberIndexes']}
            visuals = [visual for index, visual in enumerate(visuals) if index not in grouped] + complete
            text_records = []
            for record in records:
                inside_visual = any(overlap(record["bbox"], v["bbox"]) >= .8 * area(record["bbox"]) for v in visuals)
                if inside_visual and record["type"] not in ("caption", "note"):
                    record["type"] = "note"
                # Figure/table labels remain available as source text, while
                # only actual prose headings enter the reading outline.
                text_records.append(record)
            for visual in visuals:
                visual["original"] = ""
            page_records = reading_order(text_records + visuals, page.rect.width)
            for record in page_records:
                record["page"] = number
            all_records.extend(page_records)
        except Exception as error:
            incomplete = True
            notes.append(f"Page {number}: extraction skipped after {type(error).__name__}: {error}; review the original PDF.")
            all_records.append({"page": number, "type": "note", "original": "", "bbox": tuple(page.mediabox), "confidence": "low"})

    counters, blocks, assets = Counter(), [], []
    for order, record in enumerate(all_records):
        kind = record["type"]
        prefix = {"caption": "C", "figure": "F", "table": "T", "equation": "E"}.get(kind, "S")
        counters[prefix] += 1
        identifier = f"{prefix}{counters[prefix]:03d}"
        block = {"id": identifier, "page": record["page"], "type": kind, "order": order,
                 "original": record["original"], "translation": "", "bbox": [round(float(n), 3) for n in record["bbox"]],
                 "confidence": record.get("confidence", "medium")}
        if kind in ("figure", "table", "equation"):
            import pymupdf

            page = document[record["page"] - 1]
            rotation = page.rotation
            try:
                if rotation:
                    page.set_rotation(0)
                png = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=pymupdf.Rect(record["bbox"]), alpha=False).tobytes('png')
                name = identifier + '-' + hashlib.sha256(png).hexdigest()[:12] + '.png'
                target = assets_dir / name
                target.write_bytes(png)
                block["asset"] = name
                if record.get('captionOriginal'):
                    block['_captionOriginal'] = record['captionOriginal']
                assets.append({"name": name, "sourcePath": str(target.resolve())})
            except Exception as error:
                incomplete = True
                block["type"], block["confidence"] = "note", "low"
                notes.append(f"Page {record['page']}: {kind} crop {identifier} could not be rendered ({type(error).__name__}); review the original PDF.")
            finally:
                if rotation:
                    page.set_rotation(rotation)
        blocks.append(block)
    for block in blocks:
        caption = block.pop('_captionOriginal', None)
        if caption:
            block['captionIds'] = [other['id'] for other in blocks if other['page'] == block['page']
                                   and other['type'] == 'caption' and other['original'] == caption]
    return {"blocks": blocks, "assets": assets, "notes": notes, "ocrPages": ocr_pages, "incomplete": incomplete}


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    result = {"blocks": [], "assets": [], "notes": [], "ocrPages": [], "incomplete": False}
    try:
        if not args.pdf.is_absolute() or not args.pdf.is_file():
            raise ValueError("--pdf must be an existing absolute PDF path")
        if not args.out.is_dir():
            raise ValueError("--out must be an existing document directory")
        with redirect_stdout(sys.stderr):
            import pymupdf

            with pymupdf.open(args.pdf) as document:
                if not document.is_pdf:
                    raise ValueError("The input is not a PDF")
                if document.needs_pass:
                    raise ValueError("The PDF requires a password")
                result = extract_document(document, args.out.resolve())
        code = 0
    except Exception as error:
        message = f"PDF extraction failed: {error}"
        result["notes"].append(message)
        result["incomplete"] = True
        print(message, file=sys.stderr)
        code = 1
    json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
