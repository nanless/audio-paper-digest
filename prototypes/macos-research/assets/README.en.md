# Local paper sample assets

[简体中文](README.md)

This directory holds the original MiCLA PDF and three scientific figure crops used by client tests. They are not tracked in Git. The explanation and public metadata are in the parent `sample.json`. Copyright in the original PDF and figures remains with the authors.

- Original paper: [official MiCLA v1 page](https://arxiv.org/abs/2610.27491v1).
- PDF: [original MiCLA v1 PDF](https://arxiv.org/pdf/2610.27491v1.pdf).
- Explanation in Chinese: [MiCLA paper explanation](https://nanless.github.io/audio-paper-digest-blog/posts/2026-10-21-micla-mixture-to-constituent-latent-alignment-for-2610-27491/).

Obtain and explicitly select that PDF using the [parent preparation instructions](../README.en.md#prepare-the-local-sample). The script produces the three fixed crops. It only reads the supplied PDF, does not access the network or start paper production, and does not alter sealed source material.

Clients and tests compare the actual asset bytes with the expected SHA-256 checksums in the sample manifest. Missing files or mismatched bytes cannot be treated as verified materials. A file with the expected name alone does not establish completion.
