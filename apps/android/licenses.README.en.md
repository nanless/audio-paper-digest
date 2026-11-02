# Android offline open-source license material

[简体中文](licenses.README.md)

The application's Open-source Licenses page provides offline license texts and provenance for runtime dependencies, fonts, and data. The [license directory](licenses/index.html) contains the full texts; the [manifest](licenses/manifest.json) records materials and sources, and the [interface index](licenses/index.json) supplies display entries. Original texts are in `licenses/texts/`. The reading page does not access the network or run scripts.

`releaseRuntimeClasspath` is the dependency set needed by the formal application at runtime. It currently resolves to 123 records for 120 distinct artifacts. Three repeated occurrences are deliberately retained rather than removed for brevity. The manifest also binds KaTeX fonts, PDFBox resources, and public-suffix data. Provenance fields record original cached bytes, official acquisition records, source headers, and necessary extraction. Source URLs allow the material to be traced.

## Fixed material

The build first checks that actual dependencies still match the reviewed set, then verifies the complete license-file inventory and each file's size and SHA-256. SHA-256 is a content fingerprint that detects byte changes; a matching fingerprint does not itself establish licensing permission. Fixed values match the [asset preparation implementation](prepare-assets.mjs):

| Material | SHA-256 |
|---|---|
| [manifest.json](licenses/manifest.json) | `b00a26f828bf9ddbca32caa2078ec75ffc3b1d04b281812dcfd6c0d2c788ac9d` |
| [bundle-files.json](licenses/bundle-files.json) | `b112c4d21a03940be8b52b470412ee7e390d1b0c3985c8215e9cb623f8dcecf4` |
| Canonical runtime-dependency list fingerprint, retaining duplicates | `56423d42321b81dc83f6ff384b728d1b29e0ebe326e05faf5a5ec2980c392d3f` |

The license directory contains 632 files. The inventory itself is constrained by a fixed value in the build implementation. `runtimeMaterialFingerprint` in the manifest specifies the artifact fields, sorting, and duplicate-retention rules.

Updating a dependency therefore requires more than changing a version or calculating another fingerprint. Review the source and licensing of new binaries, fonts, or data, then update the reviewed manifest and build constants together. The rules below protect original authorization texts; translation or formatting must not alter them.

## Update rules

- Preserve original license texts, copyright notices, years, URLs, and line endings. Renaming the client changes application display text only.
- When dependency versions, binaries, fonts, or data change, review actual materials and licensing sources before updating reviewed materials and build constants. Recalculating only the manifest's own digest is insufficient.
- Added, missing, or modified files trigger verification. Investigation records, cached archives, and personal data do not belong in the license directory.

See [Android validation scope (Chinese)](../../docs/android-validation.md) for formal APK resource and license checks. This English document translates the explanatory README; it does not replace or translate the protected license texts.
