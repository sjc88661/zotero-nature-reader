"""Enrich existing PDF blocks without extracting/reordering/changing their text.

Offsets are UTF-16, end-exclusive. Rectangles use the original, unrotated PDF
coordinate system (bottom-left, including CropBox offsets). Whitespace without
a physical glyph has no character rectangle. Ambiguous text mapping fails closed.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
from statistics import median
import sys
import unicodedata

VERSION = 1
MAPPING_VERSION = 2


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def content_hash(blocks):
    # Direct/offline extraction helper; runtime passes its authoritative JS hash.
    payload = [[b.get('id'), b.get('page'), b.get('order'), b.get('bbox'), b.get('original', '')] for b in blocks]
    return digest(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))


def rounded(box):
    return [round(float(n), 3) for n in box]


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def norm(text):
    # NFKD expands ligatures and aligns precomposed/decomposed accents;
    # whitespace and discretionary soft hyphens are
    # deliberately excluded from geometric matching, never from the source text.
    return ''.join(c for c in unicodedata.normalize('NFKD', text) if not c.isspace() and c != '\u00ad')


def face_name(name):
    return re.sub(r'^[A-Z]{6}\+', '', name)


class Fonts:
    def __init__(self, document, out):
        self.document, self.out = document, out
        self.records, self.raw, self.page_names, self.glyphs = {}, {}, {}, defaultdict(lambda: defaultdict(set))
        self.space_ratios = defaultdict(list)

    def inspect_page(self, page):
        names = defaultdict(set)
        for row in page.get_fonts(full=True):
            xref, extension, kind, name = row[:4]
            names[face_name(name)].add(xref)
            if xref not in self.raw:
                self.raw[xref] = (extension, kind, name)
        self.page_names[page.number] = names
        for trace in page.get_texttrace():
            xrefs = names.get(face_name(trace['font']), set())
            if len(xrefs) == 1:
                xref = next(iter(xrefs))
                if trace.get('size', 0) > 0:
                    self.space_ratios[xref].append(trace.get('spacewidth', 0) / trace['size'])
                for codepoint, gid, *_ in trace['chars']:
                    if 0 < codepoint <= 0x10ffff and codepoint != 0xfffd and gid > 0:
                        self.glyphs[xref][codepoint].add(gid)

    def get(self, page, span):
        name = face_name(span.get('font', 'Unknown'))
        xrefs = self.page_names[page.number].get(name, set())
        xref = next(iter(xrefs)) if len(xrefs) == 1 else None
        identifier = 'f' + (str(xref) if xref is not None else digest(name)[:12])
        if identifier not in self.records:
            flags = span.get('flags', 0)
            self.records[identifier] = {'id': identifier, 'family': 'NaturePDF_' + identifier,
                'name': name, 'sourcePath': None, 'format': None, 'available': False,
                'fallback': 'monospace' if flags & 8 else 'serif' if flags & 4 else 'sans-serif', '_xref': xref}
        return identifier

    def export(self):
        warnings = []
        self.out.mkdir(parents=True, exist_ok=True)
        for record in self.records.values():
            xref = record.pop('_xref')
            if xref is None or not xref:
                continue
            try:
                _, extension, _, data = self.document.extract_font(xref)
                if not data:
                    continue
                font = browser_font(data, extension, self.glyphs[xref], record['family'])
                if font is None:
                    continue
                repair_spaces(font, reliable_space_ratio(self.space_ratios[xref]))
                extension = 'otf' if font.sfntVersion == 'OTTO' else 'ttf'
                compiled = BytesIO()
                font.save(compiled)
                exported = compiled.getvalue()
                # Hash the converted font, not its PDF source: metric/cmap
                # repairs must invalidate browser and local asset caches.
                target = self.out / (record['id'] + '-' + hashlib.sha256(exported).hexdigest()[:12] + '.' + extension)
                target.write_bytes(exported)
                # Round-trip forces compilation and verifies cmap/glyph references.
                from fontTools.ttLib import TTFont
                with TTFont(target) as checked:
                    if not checked.getBestCmap():
                        raise ValueError('font has no verified Unicode cmap')
                    if any(checked['hmtx'][checked.getBestCmap()[cp]][0] <= 0 for cp in (32, 160)):
                        raise ValueError('font has no positive space advance')
                record.update(sourcePath=str(target.resolve()), format='opentype' if extension == 'otf' else 'truetype', available=True)
            except Exception as error:
                warnings.append(f"Font {record['name']}: fallback ({type(error).__name__}: {error})")
        return list(self.records.values()), warnings


def reliable_space_ratio(ratios):
    """Trace spacewidth can be a variable surrogate when PDF space is zero.

    Trust a plausible, stable font-relative value. Inconsistent or absent
    measurements get a conservative quarter-em rather than a letter width.
    """
    if not ratios or any(not .1 <= value <= .6 for value in ratios):
        return .25
    middle = median(ratios)
    return middle if max(ratios) - min(ratios) <= max(.015, middle * .08) else .25


def repair_spaces(font, ratio=.25):
    """Ensure SPACE/NBSP are blank glyphs with nonzero horizontal advance.

    PDF producers commonly position words explicitly and subset a zero-width
    space. Browser shaping cannot reproduce those PDF text-position commands.
    Add a dedicated blank glyph when necessary without altering other glyphs.
    """
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.pens.t2CharStringPen import T2CharStringPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    cmap = dict(font.getBestCmap() or {})
    name = cmap.get(32)
    glyphs = font.getGlyphSet()
    blank = False
    if name in glyphs:
        pen = BoundsPen(glyphs)
        glyphs[name].draw(pen)
        blank = pen.bounds is None
    if not blank or font['hmtx'][name][0] <= 0:
        order = list(font.getGlyphOrder())
        name = 'znr.space'
        while name in order:
            name += '_'
        advance = max(1, round(font['head'].unitsPerEm * ratio))
        if 'CFF ' in font:
            cff = font['CFF '].cff
            top = cff.topDictIndex[0]
            private = top.Private
            charstring = T2CharStringPen(advance - private.nominalWidthX, None).getCharString(private=private, globalSubrs=cff.GlobalSubrs)
            chars = top.CharStrings
            if chars.charStringsAreIndexed:
                chars.charStrings[name] = len(chars.charStringsIndex)
                chars.charStringsIndex.append(charstring)
            else:
                chars.charStrings[name] = charstring
            top.charset = [*order, name]
        elif 'glyf' in font:
            font['glyf'][name] = TTGlyphPen(None).glyph()
        else:
            raise ValueError('unsupported outline format for missing-space repair')
        font.setGlyphOrder([*order, name])
        font['hmtx'].metrics[name] = (advance, 0)
        font['maxp'].numGlyphs = len(order) + 1
    cmap[32] = cmap[160] = name
    FontBuilder(font=font).setupCharacterMap(cmap)


def browser_font(data, extension, observed, family):
    """Wrap raw CFF or repair SFNT cmap using the PDF renderer's Unicode/GID pairs.

    Guessing Unicode from subset glyph names is unsafe. Only unambiguous glyph
    mappings actually observed in the PDF are used for CFF. Existing Unicode
    cmap entries in SFNT fonts remain available when they agree with the PDF.
    """
    from fontTools.ttLib import TTFont, newTable
    from fontTools.fontBuilder import FontBuilder
    from fontTools.cffLib import CFFFontSet
    from fontTools.pens.boundsPen import BoundsPen

    if extension == 'cff':
        cff = CFFFontSet()
        cff.decompile(BytesIO(data), None)
        top = cff.topDictIndex[0]
        if hasattr(top, 'ROS'):
            return None  # CID CFF requires FDArray/variation handling.
        matrix = top.FontMatrix
        if matrix[1:4] != [0, 0, matrix[0]] or matrix[4:] != [0, 0] or matrix[0] <= 0:
            return None
        upem = round(1 / matrix[0])
        if not 16 <= upem <= 16384:
            return None
        builder = FontBuilder(upem, isTTF=False)
        order = top.charset
        builder.setupGlyphOrder(order)
        cmap = {cp: order[next(iter(gids))] for cp, gids in observed.items() if len(gids) == 1 and 0 < next(iter(gids)) < len(order)}
        if 'space' in order:
            cmap.setdefault(32, 'space')
        if not cmap:
            return None
        builder.setupCharacterMap(cmap)
        metrics = {}
        for name in order:
            charstring = top.CharStrings[name]
            pen = BoundsPen(None)
            charstring.draw(pen)
            metrics[name] = (round(charstring.width), round(pen.bounds[0]) if pen.bounds else 0)
        builder.setupHorizontalMetrics(metrics)
        ascent, descent = round(top.FontBBox[3]), round(top.FontBBox[1])
        builder.setupHorizontalHeader(ascent=ascent, descent=descent)
        builder.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': family,
                               'fullName': family, 'psName': family, 'version': 'Version 1.0'})
        builder.setupOS2(sTypoAscender=ascent, sTypoDescender=descent, usWinAscent=max(0, ascent), usWinDescent=max(0, -descent))
        builder.setupPost(italicAngle=top.ItalicAngle)
        builder.setupMaxp()
        table = newTable('CFF ')
        table.cff = cff
        cff.otFont = builder.font
        builder.font.sfntVersion = 'OTTO'
        builder.font['CFF '] = table
        return builder.font
    if extension not in ('ttf', 'otf'):
        return None
    font = TTFont(BytesIO(data))
    order = font.getGlyphOrder()
    cmap = dict(font.getBestCmap() or {})
    for cp, gids in observed.items():
        if len(gids) == 1 and 0 < next(iter(gids)) < len(order):
            cmap[cp] = order[next(iter(gids))]
        else:
            cmap.pop(cp, None)
    if not cmap:
        return None
    FontBuilder(font=font).setupCharacterMap(cmap)
    return font


def ligature_clusters(page):
    """Keep only actual multi-Unicode glyph clusters recorded by the renderer.

    MuPDF uses gid=-1 for additional Unicode characters of one physical glyph.
    rawdict may put those characters at the glyph's end with zero width.
    An empty rectangle alone is never evidence of a ligature.
    """
    import pymupdf
    result = defaultdict(set)
    for span in page.get_texttrace():
        chars, index = span['chars'], 0
        while index < len(chars):
            first = chars[index]
            end = index + 1
            if first[1] >= 0:
                while end < len(chars) and chars[end][1] == -1 and chars[end][2] == first[2]:
                    end += 1
                rect = pymupdf.Rect(first[3])
                if end > index + 1 and not rect.is_empty and not rect.is_infinite:
                    text = ''.join(chr(c[0]) for c in chars[index:end])
                    key = (face_name(span['font']), *rounded(first[2]))
                    result[key].add((text, tuple(first[3])))
            index = end
    return result


def ligature_rectangles(chars, font, clusters):
    """Reuse the real base glyph's box only after an unambiguous trace match."""
    import pymupdf
    repaired = {}
    for index, first in enumerate(chars):
        key = (face_name(font), *rounded(first['origin']))
        candidates = clusters.get(key, ())
        if len(candidates) != 1:
            continue
        text, _trace_box = next(iter(candidates))
        group = chars[index:index + len(text)]
        base = pymupdf.Rect(first['bbox'])
        if ''.join(c['c'] for c in group) != text or base.is_empty or base.is_infinite:
            continue
        for offset, char in enumerate(group[1:], 1):
            rect = pymupdf.Rect(char['bbox'])
            if ((rect.width == 0 and rect.height > 0) or (rect.height == 0 and rect.width > 0)) and not rect.is_infinite:
                repaired[index + offset] = first['bbox']
    return repaired


def page_glyphs(page, fonts):
    import pymupdf
    result = []
    clusters = ligature_clusters(page)
    flags = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    for block in page.get_text('rawdict', flags=flags, sort=False)['blocks']:
        if block.get('type') != 0:
            continue
        for line in block.get('lines', []):
            line_id = len(result)
            glyphs = []
            for span in line['spans']:
                font_id = fonts.get(page, span)
                chars = span.get('chars', [])
                repaired = ligature_rectangles(chars, span.get('font', ''), clusters)
                for index, char in enumerate(chars):
                    glyphs.append({'c': char['c'], 'bbox': repaired.get(index, char['bbox']), 'origin': char['origin'],
                                   'line': line_id, 'fontId': font_id, 'size': float(span['size']),
                                   'flags': span.get('flags', 0), 'font': span.get('font', ''),
                                   'dir': line.get('dir', (1, 0))})
            result.append(glyphs)
    return result


def in_box(glyph, box):
    rect = glyph['bbox']
    # Center inclusion avoids swallowing neighbouring lines while tolerating
    # differences between the original extractor's span and raw glyph heights.
    return box[0] - .6 <= (rect[0] + rect[2]) / 2 <= box[2] + .6 and box[1] - .6 <= (rect[1] + rect[3]) / 2 <= box[3] + .6


def map_block(block, lines, transform):
    import pymupdf
    original = block.get('original', '')
    result = {'textHash': digest(original), 'baseSize': 0, 'mapped': False, 'coverage': 0, 'runs': [], 'chars': [], 'rects': []}
    box = block.get('bbox')
    if not original.strip() or not box or len(box) != 4:
        return result
    selected = [[g for g in line if in_box(g, box)] for line in lines]
    selected = [line for line in selected if line]
    source, references = [], []
    for line in selected:
        for glyph in line:
            normalized = norm(glyph['c'])
            source.extend(normalized)
            references.extend([glyph] * len(normalized))
    target, positions = [], []
    offset = 0
    for index, character in enumerate(original):
        length = len(character.encode('utf-16-le')) // 2
        normalized = norm(character)
        target.extend(normalized)
        positions.extend([(index, offset, offset + length)] * len(normalized))
        offset += length
    if not target or not source:
        return result
    # Exact matching first; then allow only source-only line-final hyphens.
    a, b = ''.join(source), ''.join(target)
    matcher = SequenceMatcher(None, a, b, autojunk=False)
    pairs, invalid = [], False
    for operation, i, j, k, l in matcher.get_opcodes():
        if operation == 'equal':
            pairs.extend((s, t) for s, t in zip(range(i, j), range(k, l)))
        elif operation == 'delete':
            # A paragraph's union bbox can also contain the start/end of an
            # adjacent column or figure label. A unique exact interior match
            # remains safe; unmatched text inside a match is never discarded.
            if k == 0 or k == len(b):
                continue
            for s in range(i, j):
                if a[s] not in '-\u2010\u2011' or s + 1 >= len(a) or references[s]['line'] == references[s + 1]['line']:
                    invalid = True
        else:
            invalid = True
    result['coverage'] = round(len(pairs) / len(target), 4)
    if len(b) < len(a) and a.count(b) > 1:
        invalid = True
    line_hyphens = {index for index, char in enumerate(a) if char in '-\u2010\u2011' and index + 1 < len(a)
                    and references[index]['line'] != references[index + 1]['line']}
    target_hyphens = {target_index for source_index, target_index in pairs if source_index in line_hyphens}
    unwrapped_source = ''.join(char for index, char in enumerate(a) if index not in line_hyphens)
    unwrapped_target = ''.join(char for index, char in enumerate(b) if index not in target_hyphens)
    if unwrapped_target and unwrapped_source.count(unwrapped_target) > 1:
        invalid = True
    if invalid or len(pairs) != len(target):
        return result
    assigned = defaultdict(list)
    for source_index, target_index in pairs:
        assigned[positions[target_index]].append(references[source_index])
    weighted = Counter(round(g['size'], 3) for group in assigned.values() for g in group if g['c'].strip())
    base = weighted.most_common(1)[0][0]
    result['baseSize'] = base
    line_baselines = {}
    for line in selected:
        horizontal = [g for g in line if abs(g['dir'][1]) < .15 and g['size'] >= base * .9]
        if horizontal:
            line_baselines[line[0]['line']] = median(g['origin'][1] for g in horizontal)
    styles = {}
    for (index, start, end), glyphs in sorted(assigned.items()):
        glyph = glyphs[0]
        rect = pymupdf.Rect(union([g['bbox'] for g in glyphs])) * transform
        if rect.is_empty or rect.is_infinite:
            return {**result, 'chars': [], 'runs': [], 'rects': [], 'mapped': False}
        result['chars'].append({'start': start, 'end': end, 'rect': rounded(rect), 'line': glyph['line']})
        delta = glyph['origin'][1] - line_baselines.get(glyph['line'], glyph['origin'][1])
        script = 'normal'
        if glyph['flags'] & 1 or glyph['size'] < base * .9 and delta < -base * .12:
            script = 'super'
        elif glyph['size'] < base * .9 and delta > base * .12:
            script = 'sub'
        name = glyph['font']
        styles[index] = {'fontId': glyph['fontId'], 'size': round(glyph['size'], 3),
                         'bold': bool(glyph['flags'] & 16 or re.search(r'bold|black|heavy|[_-]b$|^Adv.*(?:sb|b\d*o?)$', name, re.I)),
                         'italic': bool(glyph['flags'] & 2 or re.search(r'italic|oblique|_It$|^AdvTg.*o$', name, re.I)), 'script': script}
    # The PDF may omit whitespace glyphs. Give those source characters their
    # adjacent style, but never invent a rectangle for them.
    prior = next(iter(styles.values()))
    offset = 0
    for index, character in enumerate(original):
        style = styles.get(index, prior)
        end = offset + len(character.encode('utf-16-le')) // 2
        if result['runs'] and all(result['runs'][-1][key] == value for key, value in style.items()):
            result['runs'][-1]['end'] = end
        else:
            result['runs'].append({'start': offset, 'end': end, **style})
        offset, prior = end, style
    groups = defaultdict(list)
    for char in result['chars']:
        groups[char['line']].append(char['rect'])
    result['rects'] = [{'rect': rounded(union(rectangles)), 'line': line} for line, rectangles in groups.items()]
    result['mapped'] = True
    return result


def enrich(document, blocks, out, fingerprint='', signature=None):
    import pymupdf
    signature = signature or content_hash(blocks)
    result = {'version': VERSION, 'mappingVersion': MAPPING_VERSION, 'status': 'ready', 'fingerprint': fingerprint,
              'contentHash': signature, 'revision': f'{signature}:mapping-{MAPPING_VERSION}', 'coordinateSystem': 'pdf-unrotated-bottom-left',
              'pages': {}, 'blocks': {}, 'fonts': [], 'warnings': []}
    fonts = Fonts(document, out / 'fonts')
    for page in document:
        fonts.inspect_page(page)
    for page in document:
        rotation = page.rotation
        try:
            # MuPDF 1.26 drops CropBox translation from transformation_matrix
            # on rotated pages. Temporarily unrotate in memory; never save PDF.
            if rotation:
                page.set_rotation(0)
            transform = ~page.transformation_matrix
            result['pages'][str(page.number + 1)] = {'width': round(page.mediabox.width, 3), 'height': round(page.mediabox.height, 3),
                'mediaBox': rounded(page.mediabox), 'cropBox': rounded(page.rect * transform), 'rotation': rotation}
            lines = page_glyphs(page, fonts)
            for block in blocks:
                if block.get('page') == page.number + 1:
                    result['blocks'][block['id']] = map_block(block, lines, transform)
        finally:
            if rotation:
                page.set_rotation(rotation)
    result['fonts'], result['warnings'] = fonts.export()
    failed = sum(bool(b.get('original', '').strip()) and not result['blocks'].get(b['id'], {}).get('mapped') for b in blocks)
    if failed:
        result['warnings'].append(f'{failed} text blocks have ambiguous or unavailable PDF character mapping; selection annotations are disabled for them.')
    return result


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--blocks', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fingerprint', default='')
    parser.add_argument('--content-hash', default='')
    args = parser.parse_args()
    import pymupdf
    data = json.loads(args.blocks.read_text(encoding='utf-8-sig'))
    blocks = data if isinstance(data, list) else (data.get('reading') or data.get('source') or data)['blocks']
    with pymupdf.open(args.pdf) as document:
        result = enrich(document, blocks, args.out, args.fingerprint, args.content_hash)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
