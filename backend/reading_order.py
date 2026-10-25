"""Reorder existing stable blocks using PDF column geometry; never re-extract text."""
import argparse
import json
import sys

import pymupdf
from extract import reading_order


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', required=True)
    args = parser.parse_args()
    blocks = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    ids = []
    with pymupdf.open(args.pdf) as document:
        for number in sorted({b['page'] for b in blocks}):
            if not isinstance(number, int) or not 1 <= number <= len(document):
                raise ValueError('Invalid source page; original cache retained')
            page_blocks = [b for b in blocks if b['page'] == number]
            ids.extend(b['id'] for b in reading_order(page_blocks, document[number - 1].cropbox.width))
    print(json.dumps({'version': 2, 'ids': ids}))


if __name__ == '__main__':
    main()
