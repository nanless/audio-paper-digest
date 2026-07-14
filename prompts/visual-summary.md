# GPT Image 2 论文视觉摘要

```text
Use case: scientific-educational
Asset type: one tall portrait infographic for a research-paper digest

Create one exceptionally polished, fresh, tall portrait scientific infographic that summarizes the entire paper in a single image. Use a clearly vertical reading path and a long-poster composition (prefer approximately 1:2 portrait when supported). The result should feel like a premium contemporary science-magazine spread: calm, airy, precise, friendly, and editorial—not like a software dashboard or a promotional technology poster.

Organize the content from top to bottom into exactly four visually connected chapters: (1) research question and core contribution, (2) method architecture and signal/data flow, (3) key experimental findings, and (4) conclusion and limitations. Use one dominant explanatory illustration or diagram per chapter, supported by only a few short labels. This is an explanatory image, not a fabricated paper figure.

Reference figures supplied with the task are verified figures extracted from this exact paper. When at least one reference figure is supplied, use the highest-priority method overview, architecture, pipeline, or structure figure as the structural source of truth for chapter 2. Preserve its real module relationships, grouping, arrow direction, and information hierarchy, then redraw and simplify it into this infographic's fresh editorial visual language. If a second verified reference is supplied and it is a key result figure, use it only to support chapter 3. Do not paste an illegible screenshot, trace decorative details, copy the paper's visual style blindly, or infer any value that is not readable in the verified evidence. If no reliable reference figure is supplied, construct the diagram only from the verified text.

At the very top of the image, render the original English paper title below verbatim as a prominent, highly legible one- or two-line header. Preserve its English spelling, capitalization, punctuation, and technical terms exactly; never translate the title into Chinese.

Paper title: {title}
Document type: {documentType}
Primary task: {primaryTask}
Primary method: {primaryMethod}
Verified paper summary: {summary}
Verified method evidence: {method}
Verified experiment evidence: {experiments}
Verified limitations: {limitations}
Required coverage: {focus}

Visual direction: {direction}

Art direction and palette:
- Use a warm off-white or very pale oatmeal paper-like background, with large clean areas of negative space.
- Use deep slate-blue for primary type, plus a restrained low-saturation palette of mist blue, sage green, soft coral, pale apricot, and muted lavender. Gentle tonal gradients are allowed only as subtle depth; keep contrast accessible.
- Combine crisp flat-vector editorial illustration with restrained paper-cut shapes, thin technical linework, simple data marks, and very soft natural shadows. Use consistent corner radii and stroke weights throughout.
- Audio waveforms, spectrograms, microphones, instruments, or neural-network motifs may appear only when genuinely relevant to this paper. Treat them as elegant explanatory symbols, not decorative filler.
- Give every chapter its own lightly tinted surface or open composition, while keeping the whole poster visually coherent. Alternate diagram-led and text-led balance to create rhythm.

Typography and layout:
- Reserve roughly the top 12–16% for the exact English title, set in a clean bold editorial sans-serif with comfortable line spacing. Do not add a dark banner behind it.
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

Strict negative style constraints: no dark navy or black full-page background; no neon glow; no cyberpunk or sci-fi HUD; no luminous outlines; no metallic beveled frames; no gamer-interface panels; no trophy, medal, star-rating, or giant numbered badge; no photorealistic stock people; no glassmorphism overload; no cluttered icon collection; no repeated decorative waveform; no dense grid of equal-sized boxes; no tiny text; no fake UI chrome.
```
