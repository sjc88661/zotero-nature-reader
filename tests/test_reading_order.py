import json
import sys
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from extract import reading_order

class ReadingOrderTests(unittest.TestCase):

    def test_full_width_bands_and_single_column_remain_ordered(self):

        def b(id, box):
            return {'id': id, 'type': 'paragraph', 'bbox': box}
        rows = [b('title', [40, 20, 550, 60]), b('l1', [40, 80, 289, 150]), b('r1', [301, 80, 550, 170]), b('l2', [40, 160, 289, 200]), b('banner', [40, 230, 550, 260]), b('l3', [40, 280, 289, 330]), b('r2', [301, 280, 550, 340])]
        self.assertEqual([b['id'] for b in reading_order(rows, 594)], ['title', 'l1', 'l2', 'r1', 'banner', 'l3', 'r2'])
        single = [b('a', [40, 50, 550, 100]), b('b', [60, 110, 550, 160]), b('c', [40, 170, 550, 220])]
        self.assertEqual(reading_order(single, 594), single)

    def test_isolated_footer_crossing_gutter_does_not_reverse_columns(self):
        rows = [dict(id='heading', type='heading', bbox=[38, 471, 100, 484]), dict(id='right', type='paragraph', bbox=[307, 471, 560, 610]), dict(id='left', type='paragraph', bbox=[38, 492, 291, 610]), dict(id='footer', type='paragraph', bbox=[38, 696, 344, 717])]
        self.assertEqual([b['id'] for b in reading_order(rows, 595)], ['heading', 'left', 'right', 'footer'])

    def test_column_consensus_wins_over_short_heading_whitespace(self):
        rows = [dict(id='right-tail', type='paragraph', bbox=[307, 648, 560, 745]), dict(id='right-head', type='paragraph', bbox=[307, 543, 560, 619]), dict(id='figure', type='figure', bbox=[90, 51, 506, 313]), dict(id='right-heading', type='paragraph', bbox=[307, 627, 375, 640]), dict(id='left-body', type='paragraph', bbox=[38, 574, 291, 744]), dict(id='caption', type='caption', bbox=[38, 310, 560, 532]), dict(id='left-heading', type='paragraph', bbox=[38, 543, 252, 566])]
        self.assertEqual([b['id'] for b in reading_order(rows, 595)], ['figure', 'caption', 'left-heading', 'left-body', 'right-head', 'right-heading', 'right-tail'])
if __name__ == '__main__':
    unittest.main()
