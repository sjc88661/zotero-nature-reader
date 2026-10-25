"""Prepare complete images for an existing reading, without changing any text."""
import argparse
import hashlib
import json
from pathlib import Path
import pymupdf
from extract import native_text, classify_text, body_font_size, heading_fonts, complete_visual_regions


def prepare(document_path, output):
    data = json.loads(document_path.read_text(encoding='utf-8'))
    reading = data['reading']
    output.mkdir(parents=True, exist_ok=True)
    changes, assets = [], []
    ids = {b['id'] for b in reading['blocks']}
    with pymupdf.open(data['pdfPath']) as pdf:
        fonts = heading_fonts(pdf)
        all_records = {n:native_text(p, fonts) for n,p in enumerate(pdf)}
        body_size = body_font_size([r for rows in all_records.values() for r in rows])
        pages = sorted({b['page'] for b in reading['blocks'] if b.get('asset') or b['type']=='caption'})
        for number in pages:
            page = pdf[number-1]
            records = all_records[number-1]; classify_text(records, page, body_size)
            visuals = [b for b in reading['blocks'] if b['page']==number and b.get('asset') and not b.get('visualParentId')]
            for group in complete_visual_regions(page, records, visuals, body_size):
                captions = [b for b in reading['blocks'] if b['page']==number and b['type']=='caption' and b['original']==group['captionOriginal']]
                if not captions:
                    raise ValueError('Caption does not match the preserved source; no text was changed.')
                members = sorted((visuals[i] for i in group['memberIndexes']), key=lambda b:b['order'])
                if members:
                    identifier = members[0]['id']
                else:
                    prefix = 'T' if group['type']=='table' else 'F'
                    counter = 1
                    while f'{prefix}{counter:03d}' in ids:
                        counter += 1
                    identifier = f'{prefix}{counter:03d}'; ids.add(identifier)
                rotation = page.rotation
                try:
                    if rotation: page.set_rotation(0)
                    png = page.get_pixmap(matrix=pymupdf.Matrix(2,2), clip=pymupdf.Rect(group['bbox']), alpha=False).tobytes('png')
                finally:
                    if rotation: page.set_rotation(rotation)
                name = identifier + '-' + hashlib.sha256(png).hexdigest()[:12] + '.png'
                target = output/name; target.write_bytes(png)
                patch = {'id':identifier,'type':group['type'],'page':number,'bbox':[round(float(n),3) for n in group['bbox']],
                         'asset':name,'captionIds':[b['id'] for b in captions], 'confidence':'high'}
                if not members:
                    patch.update(original='',translation='',status='complete',insertBefore=captions[0]['id'])
                changes.append(patch)
                for member in members[1:]:
                    changes.append({'id':member['id'], 'visualParentId':identifier, 'asset':None})
                assets.append({'name':name,'sourcePath':str(target.resolve())})
    manifest = {'key':data['key'],'fingerprint':data['fingerprint'],'baseReadingRevision':reading['revision'],
                'changes':changes,'assets':assets}
    (output/'repair.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'manifest':str((output/'repair.json').resolve()),'images':len(assets),
                      'groups':[{'id':p['id'],'page':p['page'],'bbox':p['bbox'],'captions':p['captionIds']} for p in changes if p.get('asset')]},ensure_ascii=False))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--document',required=True,type=Path);parser.add_argument('--out',required=True,type=Path)
    args=parser.parse_args();prepare(args.document.resolve(),args.out.resolve())
