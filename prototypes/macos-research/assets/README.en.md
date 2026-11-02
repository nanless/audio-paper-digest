# Local paper sample assets

[简体中文](README.md)

This directory holds the prototype's original MiCLA PDF and three scientific figure crops. They are not tracked in Git. The explanation and public metadata are in the parent `sample.json`. Copyright in the original PDF and figures remains with the authors.

- Original paper: [official MiCLA v1 page](https://arxiv.org/abs/2610.27491v1).
- PDF: [original MiCLA v1 PDF](https://arxiv.org/pdf/2610.27491v1.pdf).
- Explanation in Chinese: [MiCLA paper explanation](https://nanless.github.io/audio-paper-digest-blog/posts/2026-10-21-micla-mixture-to-constituent-latent-alignment-for-2610-27491/).

Obtain and explicitly select that PDF using the [parent preparation instructions](../README.en.md#open-the-prototype). The script produces the three fixed crops. It only reads the supplied PDF, does not access the network or start paper production, and does not alter sealed source material.

The interface recalculates each asset's SHA-256 content fingerprint and compares it with the sample manifest. Missing or mismatched bytes are shown as unprepared. A file with the expected name alone does not establish completion.
