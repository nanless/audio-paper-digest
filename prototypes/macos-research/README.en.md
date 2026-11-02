# Shared client samples and display resources

[中文](README.md)

This directory contains the fixed paper sample, original-figure preparation script, and third-party display resources used by the Mac and Android applications. Its name comes from an earlier interaction prototype. For installation and use, read the [Mac guide](../../apps/macos/README.en.md) or [Android guide](../../apps/android/README.en.md).

The browser demo, its standalone web server, and its PDF.js dependency have been retired. This directory no longer provides a separate application. The Mac application displays original papers with PDFKit; Android uses its own PDF components. Both applications still consume the necessary materials here for resource preparation and testing.

## What each item provides

| Path | Contents | Actual use |
|---|---|---|
| `sample.json` | Fixed MiCLA explanation, bibliography, formulas, tables, original-figure coordinates, and expected checksums | Scientific layout, source navigation, and package-isolation tests on both platforms |
| `assets/` | Locally prepared original PDF and three fixed crops | Local application tests; these files are neither committed to Git nor included in formal releases |
| `prepare_assets.py` | Preparation script using fixed PDF pages and coordinates | Reads an explicitly supplied PDF and writes verified local sample assets |
| `vendor/marked.esm.js` | Markdown display library | Consumed by both build processes, with its MIT license retained |
| `vendor/lucide.min.js` | Interface icon library | Used by the Mac web display layer, with its license retained |

`sample.json` is not the website synchronization interface. It contains no model configuration, credentials, costs, or internal requests. Passing fixed-sample tests does not establish that full-site synchronization, real model requests, or Zotero writes work.

## Prepare the local sample

Obtain the specified PDF using the [original-file guide](assets/README.en.md). Use the same public original: a matching filename does not establish matching contents. The preparation script first checks the complete PDF checksum and page count, then crops figures using fixed pages, point coordinates, and a scale of three. It verifies each output checksum before copying any prepared asset.

Run in this directory:

```bash
python3 -m pip install PyMuPDF==1.26.5
python3 prepare_assets.py --pdf /absolute/path/to/2610.27491v1.pdf
```

Replace the example path with the real absolute path of the original PDF. `2610.27491v1` identifies the published arXiv revision and must match the sample. The PyMuPDF release fixes the crop tool; changing it does not establish that its output bytes will be identical.

The script does not access the network, read `.env`, search internal runtime materials, or alter the supplied original. It prepares and verifies every output in a temporary directory before replacing local sample files. If a check fails, investigate the original and the tool rather than changing expected checksums to hide the failure.

## Build and verification boundaries

The Mac `build_resources.py` and Android `prepare-assets.mjs` consume these shared materials. Formal packages include the display libraries needed by the application. Packaging checks exclude the fixed paper sample, original PDF, crops, and test records. Each platform README describes the prerequisites for its full test suite.

SHA-256 is a checksum computed from file bytes. Here it confirms that the PDF, crops, and sample have not been substituted. It does not replace scientific review or give an old draft new analysis or publication eligibility.

Third-party programs retain their original licenses. Copyright in the paper and its figures remains with the authors. For current website synchronization and proposed data extensions, see the [Mac data guide](../../docs/mac-app-data.md) and [client data design](../../docs/desktop-data-contract.md), both in Chinese.
