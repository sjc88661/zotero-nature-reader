# Zotero Nature Reader

Bilingual paper reading in Zotero, with discussions and annotations archived to one Obsidian note per paper.

Features include source-linked English/Chinese text, a resizable figure workspace, in-window DSH chat, Zotero native annotations, and a single archival bridge for readings, discussions, and notes.

The first public package targets Windows and was exercised with Zotero 10. The manifest permits 10–11; other environments have not been validated. It requires a configured DeepSeek Harness, Python 3.11+, Node.js 22.19+, and separately installed `nature-reader` / `nature-shared` skills. No Obsidian plugin is required.

Install both XPIs from Releases, configure your vault in the Zotero bridge settings, and follow [INSTALL.md](docs/INSTALL.md) to set up the Python environment and Harness plugin.

```powershell
npm test
npm run test:bridge
npm run build
npm run demo
```

The local interactive demo uses original fictional material and prewritten responses, without model calls or access to personal data. Screenshots and video materials are in `media/`.

MIT license for project code and original demo/media. External dependencies and skills retain their own terms; see [THIRD_PARTY.md](THIRD_PARTY.md). Full Chinese documentation: [README.md](README.md).
