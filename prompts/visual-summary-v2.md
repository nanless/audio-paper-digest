# 论文视觉摘要

```text
Create a high-resolution portrait infographic that explains one research paper.

Use the built-in tool to generate the full image. It renders the whole poster in one pass: the exact English title, the Simplified-Chinese explanations, the supplied numbers, the diagrams, the captions, and the paper-collage artwork all come out as a single composition. Do not send the result through the legacy deterministic text-card compositor. Prefer the highest available portrait resolution and a tall approximately 1:2 composition. After generation, visually check every title, Chinese statement, technical label, arrow relationship, metric direction, and supplied value; regenerate any asset whose text is unreadable or materially wrong.

Summarize the entire paper in one tall portrait image with a clear top-to-bottom reading order. Prefer an approximately 1:2 layout when supported. Use the readable typography, open spacing, and precise diagrams of a science magazine.

Organize the content from top to bottom into exactly four visually connected chapters: (1) research question and core contribution, (2) method architecture and signal/data flow, (3) key experimental findings, and (4) conclusion and limitations. Use one dominant explanatory illustration or diagram per chapter, supported by only a few short labels. This is an explanatory image, not a fabricated paper figure.

Reference figures supplied with the task are verified figures extracted from this exact paper. Use the highest-priority method overview, architecture, pipeline, or structure figure as the primary structural reference for chapter 2, then redraw or integrate it into the same editorial composition with adjacent Chinese explanation. If a second verified reference is a key result figure, use it only in chapter 3 with an accurate caption. Preserve real parallel branches, grouping, merge points, arrow direction, information hierarchy, and values. Do not force branches or alternative methods into a false linear chain. Do not paste an unreadable thumbnail, blindly copy decorative styling, or infer missing values.

At the very top, render the original English paper title given below verbatim as a prominent, highly legible header. Preserve its English spelling, capitalization, punctuation, accented characters, hyphenated terms, and technical names exactly; never translate the title into Chinese.

Paper title: {title}
Document type: {documentType}
Primary task: {primaryTask}
Primary method: {primaryMethod}
Supplied paper summary: {summary}
Supplied method evidence: {method}
Supplied experiment evidence: {experiments}
Supplied limitations: {limitations}
Required coverage: {focus}

For beginner-researcher-v3 tasks, use only the fields supplied by the verified Reader output. The summary is its exact oneSentenceThesis; method, experiments, and limitations contain complete Reader sections, including comparison conditions and counterexamples. Use readerBackground, when supplied, to explain the research question. Do not replace these inputs with the stored analysis or review commentary. QA entries identify the complete source sections by index, heading, and body SHA. They do not provide additional claims. When selecting findings, preserve the metric direction and dataset, distinguish deployment results from oracle results, and keep absolute values separate from changes.

Use pixels only from the referenceImages supplied as prepared image paths for this task. Their ordinal, source URL, source DOM SHA, and asset SHA identify the images the verified Reader output actually used. Do not describe a Reader figure that is absent from the current reference list. If the list is empty, create a clearly explanatory illustration from the verified Reader output rather than reconstructing a paper figure. A previous Reader verification does not establish that this image-generation task received the pixels.

Visual direction: {direction}

Art direction and palette:
- Use a warm off-white or very pale oatmeal paper-like background, with large clean areas of negative space.
- Use deep slate-blue for primary type, plus a restrained low-saturation palette of mist blue, sage green, soft coral, pale apricot, and muted lavender. Gentle tonal gradients are allowed only as subtle depth; keep contrast accessible.
- Use paper-collage details: crisp flat-vector editorial illustration, layered paper-cut shapes, subtle deckled or precisely torn edges, one or two small translucent paper-tape accents, thin technical linework, simple data marks, restrained risograph-like grain, and very soft natural shadows. Keep these details subtle so they do not compete with the explanation. Use consistent corner radii and stroke weights throughout.
- Audio waveforms, spectrograms, microphones, instruments, or neural-network motifs may appear only when genuinely relevant to this paper. Treat them as elegant explanatory symbols, not decorative filler.
- Give every chapter its own lightly tinted surface or open composition, while keeping the whole poster visually coherent. Alternate diagram-led and text-led balance to create rhythm.

Typography and layout:
- Reserve roughly the top 12–16% for the exact English title in a clean bold editorial style with comfortable line spacing. Do not add a dark banner behind it.
- Use a disciplined 12-column editorial grid, generous outer margins, aligned edges, and at least one module-height of whitespace between chapters.
- Keep chapter numbers small. Chapter headings should be the strongest Chinese text after the title.
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

Render legible text without random characters or pseudo-text. Do not use a dark navy or black full-page background, neon glow, cyberpunk or sci-fi HUD elements, luminous outlines, metallic beveled frames, or gamer-interface panels. Avoid trophies, medals, star ratings, giant numbered badges, and photorealistic stock people. Keep glass effects subtle, and avoid cluttered icons, repeated decorative waveforms, a dense grid of equal-sized boxes, tiny text, and fake UI chrome. Paper textures must not include dirty vintage paper, heavy stains, excessive torn edges, or crowded scrapbook decoration.
```
