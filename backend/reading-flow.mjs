const suffix = new URL(import.meta.url).search;
await import(new URL(`../addon/content/paper-metadata.js${suffix}`, import.meta.url).href);
await import(new URL(`../addon/content/reading-layout.js${suffix}`, import.meta.url).href);
export const {FLOW_VERSION, readingFlow, translationSpans} = globalThis.ZNRLayout;
