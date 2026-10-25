(function (root) {
  'use strict';
  // Shared with the Obsidian bridge at package time. Presentation only: never
  // change source IDs, strings, order or PDF coordinates.
  function classify(blocks, title = '', authors = []) {
    const normalize = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const first = blocks[0], firstPage = first?.page;
    const titleId = first?.type === 'heading' && normalize(first.original) === normalize(title) ? first.id : null;
    const next = titleId && blocks[1];
    const names = Array.isArray(authors) ? authors.filter(name => typeof name === 'string' && name.length > 3) : [];
    const authorId = next?.type === 'paragraph' && next.original.length < 700 && names.length
      && names.filter(name => normalize(next.original).includes(normalize(name))).length >= Math.min(2, names.length) ? next.id : null;
    const ids = blocks.filter(block => {
      if (block.id === authorId) return true;
      if (block.page !== firstPage || block.asset || !['paragraph', 'note'].includes(block.type)) return false;
      const text = String(block.original || '').trim();
      const unnumbered = text.replace(/^(?:\[?\d{1,2}\]?|[¹²³⁴⁵⁶⁷⁸⁹⁰]+)[.)]?\s*/, '');
      if (/^(?:these authors|the following authors|both authors)\b.{0,100}\bcontributed equally\b/i.test(unnumbered)) return true;
      if (/^(?:correspondence\b|corresponding author\b)/i.test(unnumbered)
        && /@|addressed to|should be|\bto\b|e-?mail/i.test(unnumbered)) return true;
      const institution = /^(?:unit|department|division|school|faculty|institute|university|laboratory|laboratories|centre|center)\b/i.test(unnumbered);
      // Require address structure and exclude narrative research prose. Do not
      // infer affiliations from institution names mentioned inside a paragraph.
      return institution && (text.match(/,/g) || []).length >= 2
        && !/\b(?:we|our|performed|measured|demonstrated|showed|found|tested|provided)\b/i.test(text)
        && (unnumbered !== text || /\b(?:university|institute|hospital)\b/i.test(text));
    }).map(block => block.id);
    return { titleId, authorId, ids };
  }
  const api = { classify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperMetadata = api;
})(globalThis);
