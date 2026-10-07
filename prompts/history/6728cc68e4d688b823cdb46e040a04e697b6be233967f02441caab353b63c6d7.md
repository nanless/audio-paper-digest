# GPT Image 2 论文视觉摘要

```text
Use case: scientific-educational
Asset type: one high-resolution tall portrait infographic for a research-paper digest

Production mode: full image generation. Built-in image generation creates the complete final poster, including the exact English title, Simplified-Chinese explanations, verified numbers, diagrams, captions, and paper-collage artwork as one integrated composition. Do not send the result through the legacy deterministic text-card compositor. Prefer the highest available portrait resolution and a tall approximately 1:2 composition. After generation, visually verify every title, Chinese statement, technical label, arrow relationship, metric direction, and supplied value; regenerate any asset with unreadable or materially incorrect text.

Create one exceptionally polished, fresh, tall portrait scientific infographic that summarizes the entire paper in a single image. Use a clearly vertical reading path and a long-poster composition (prefer approximately 1:2 portrait when supported). The result should feel like a premium contemporary science-magazine spread: calm, airy, precise, friendly, and editorial—not like a software dashboard or a promotional technology poster.

Organize the content from top to bottom into exactly four visually connected chapters: (1) research question and core contribution, (2) method architecture and signal/data flow, (3) key experimental findings, and (4) conclusion and limitations. Use one dominant explanatory illustration or diagram per chapter, supported by only a few short labels. This is an explanatory image, not a fabricated paper figure.

Reference figures supplied with the task are verified figures extracted from this exact paper. Use the highest-priority method overview, architecture, pipeline, or structure figure as the structural source of truth for chapter 2, then redraw or integrate it into the same editorial composition with adjacent Chinese explanation. If a second verified reference is a key result figure, use it only in chapter 3 with an accurate caption. Preserve real parallel branches, grouping, merge points, arrow direction, information hierarchy, and values. Do not force branches or alternative methods into a false linear chain. Do not paste an unreadable thumbnail, blindly copy decorative styling, or infer missing values.

At the very top, render the original English paper title below verbatim as a prominent, highly legible header. Preserve its English spelling, capitalization, punctuation, accented characters, hyphenated terms, and technical names exactly; never translate the title into Chinese.

Paper title: {title}
Document type: {documentType}
Primary task: {primaryTask}
Primary method: {primaryMethod}
Verified paper summary: {summary}
Verified method evidence: {method}
Verified experiment evidence: {experiments}
Verified limitations: {limitations}
Required coverage: {focus}

For modern beginner-researcher-v3 tasks, these fields come only from the signed Reader: summary is its exact oneSentenceThesis; method, experiments and limitations retain complete Reader sections, including comparison conditions and counterexamples. Use the accompanying readerBackground field, when present, for the research question. Never substitute canonical analysis, parsed summary/results/limitations, or roast commentary. QA claim entries are section-index/heading/body-SHA references to these complete sections, not new claims to invent or shorten into contradictory slogans. Preserve metric direction, dataset, deployment versus oracle conditions, and absolute values versus changes when selecting a few findings.

Only the referenceImages actually supplied as prepared image paths are pixel references for this task. Their ordinal, source URL, source DOM SHA and asset SHA identify the signed Reader images. Do not claim to see a Reader figure omitted from this task's reference list. If the list is empty, use an explicitly explanatory illustration based on the signed text, never an invented reconstruction of a paper figure. A prior Reader signature is not a new image-generation pixel-seen attestation.

Visual direction: {direction}

Art direction and palette:
- Use a warm off-white or very pale oatmeal paper-like background, with large clean areas of negative space.
- Use deep slate-blue for primary type, plus a restrained low-saturation palette of mist blue, sage green, soft coral, pale apricot, and muted lavender. Gentle tonal gradients are allowed only as subtle depth; keep contrast accessible.
- Use a refined contemporary paper-editorial language: crisp flat-vector editorial illustration, layered paper-cut shapes, subtle deckled or precisely torn edges, one or two small translucent paper-tape accents, thin technical linework, simple data marks, restrained risograph-like grain, and very soft natural shadows. It should feel like a premium science magazine assembled from beautiful stationery—not a busy scrapbook. Use consistent corner radii and stroke weights throughout.
- Audio waveforms, spectrograms, microphones, instruments, or neural-network motifs may appear only when genuinely relevant to this paper. Treat them as elegant explanatory symbols, not decorative filler.
- Give every chapter its own lightly tinted surface or open composition, while keeping the whole poster visually coherent. Alternate diagram-led and text-led balance to create rhythm.

Typography and layout:
- Reserve roughly the top 12–16% for the exact English title in a clean bold editorial style with comfortable line spacing. Do not add a dark banner behind it.
- Use a disciplined 12-column editorial grid, generous outer margins, aligned edges, and at least one module-height of whitespace between chapters.
- Chapter numbers should be small, elegant index markers—not oversized badges. Chapter headings should be the strongest Chinese text after the title.
- Keep the body concise but substantively informative. Across the whole poster, target roughly 220–360 Simplified-Chinese characters excluding the English title and technical names. Each chapter should contain 2–4 complete explanatory statements, usually 18–42 Chinese characters each, rather than isolated slogan fragments.
- Chapter 1 must state the concrete research problem, why existing approaches are insufficient, and the paper's central contribution.
- Chapter 2 must name the main modules and explain how data flows between them. Use 4–8 short module labels plus 2–3 explanatory statements around the redrawn reference structure.
- Chapter 3 must name the dataset or evaluation setting, comparison target, metric direction, and what the supplied numbers demonstrate. Never display an unlabeled number or invent a comparison value.
- Chapter 4 must separate conclusion from limitations. Include one 1–2 sentence takeaway and 2–4 specific limitation statements with causes or scope boundaries.
- Never use a dense prose paragraph. Break complete statements into readable callouts, captions, or short bullet lines with comfortable leading.
- Make the method chapter the largest and most informative area. Use clear left-to-right or top-to-bottom arrows, few nodes, and no crossing connectors.
- Show experiments with one or two honest, easy-to-read comparison graphics or metric cards. Show limitations in a calm neutral callout, not an alarming red warning box.
- Keep all text comfortably readable on a phone. Allocate more vertical height when needed; if information still does not fit, omit low-priority detail rather than shrinking the font or crowding the layout.

All body section headings, module labels, flow explanations, findings, conclusions, and limitation notes must be in Simplified Chinese. Keep established model names, dataset names, acronyms, symbols, and equations in their original technical form. Include labels only if they can be rendered clearly. Apart from the required English title header, do not put author names, arXiv ID, exact scores, unverifiable benchmark numbers, logos, watermarks, or dense paragraphs inside the image. Do not invent claims, datasets, equations, or measured gains beyond the verified evidence. Leave a calm area around the edge for the publishing system's HTML caption.

Strict negative style constraints: no illegible pseudo-text or random characters; no dark navy or black full-page background; no neon glow; no cyberpunk or sci-fi HUD; no luminous outlines; no metallic beveled frames; no gamer-interface panels; no trophy, medal, star-rating, or giant numbered badge; no photorealistic stock people; no glassmorphism overload; no cluttered icon collection; no repeated decorative waveform; no dense grid of equal-sized boxes; no tiny text; no fake UI chrome; no dirty vintage paper, heavy stains, excessive torn edges, or crowded scrapbook decoration.
```
