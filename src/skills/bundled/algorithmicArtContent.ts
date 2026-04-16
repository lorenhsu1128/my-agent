// Lazy-loaded content for the algorithmic-art bundled skill.
// Only imported when /algorithmic-art is invoked.
// Contains the SKILL.md prompt text (~20KB) and template files (~29KB) embedded inline.

export const SKILL_MD = `# Algorithmic Art

Algorithmic philosophies are computational aesthetic movements that are then expressed through code. Output .md files (philosophy), .html files (interactive viewer), and .js files (generative algorithms).

This happens in two steps:
1. Algorithmic Philosophy Creation (.md file)
2. Express by creating p5.js generative art (.html + .js files)

First, undertake this task:

## ALGORITHMIC PHILOSOPHY CREATION

To begin, create an ALGORITHMIC PHILOSOPHY (not static images or templates) that will be interpreted through:
- Computational processes, emergent behavior, mathematical beauty
- Seeded randomness, noise fields, organic systems
- Particles, flows, fields, forces
- Parametric variation and controlled chaos

### THE CRITICAL UNDERSTANDING
- What is received: Some subtle input or instructions by the user to take into account, but use as a foundation; it should not constrain creative freedom.
- What is created: An algorithmic philosophy/generative aesthetic movement.
- What happens next: The same version receives the philosophy and EXPRESSES IT IN CODE - creating p5.js sketches that are 90% algorithmic generation, 10% essential parameters.

Consider this approach:
- Write a manifesto for a generative art movement
- The next phase involves writing the algorithm that brings it to life

The philosophy must emphasize: Algorithmic expression. Emergent behavior. Computational beauty. Seeded variation.

### HOW TO GENERATE AN ALGORITHMIC PHILOSOPHY

**Name the movement** (1-2 words): "Organic Turbulence" / "Quantum Harmonics" / "Emergent Stillness"

**Articulate the philosophy** (4-6 paragraphs - concise but complete):

To capture the ALGORITHMIC essence, express how this philosophy manifests through:
- Computational processes and mathematical relationships?
- Noise functions and randomness patterns?
- Particle behaviors and field dynamics?
- Temporal evolution and system states?
- Parametric variation and emergent complexity?

**CRITICAL GUIDELINES:**
- **Avoid redundancy**: Each algorithmic aspect should be mentioned once.
- **Emphasize craftsmanship REPEATEDLY**: The philosophy MUST stress multiple times that the final algorithm should appear as though it took countless hours to develop, was refined with care, and comes from someone at the absolute top of their field.
- **Leave creative space**: Be specific about the algorithmic direction, but concise enough that the next Claude has room to make interpretive implementation choices.

The philosophy must guide the next version to express ideas ALGORITHMICALLY, not through static images. Beauty lives in the process, not the final frame.

### PHILOSOPHY EXAMPLES

**"Organic Turbulence"**
Philosophy: Chaos constrained by natural law, order emerging from disorder.
Algorithmic expression: Flow fields driven by layered Perlin noise. Thousands of particles following vector forces, their trails accumulating into organic density maps. Multiple noise octaves create turbulent regions and calm zones. Color emerges from velocity and density.

**"Quantum Harmonics"**
Philosophy: Discrete entities exhibiting wave-like interference patterns.
Algorithmic expression: Particles initialized on a grid, each carrying a phase value that evolves through sine waves. When particles are near, their phases interfere - constructive interference creates bright nodes, destructive creates voids.

**"Recursive Whispers"**
Philosophy: Self-similarity across scales, infinite depth in finite space.
Algorithmic expression: Branching structures that subdivide recursively. Each branch slightly randomized but constrained by golden ratios.

**"Field Dynamics"**
Philosophy: Invisible forces made visible through their effects on matter.
Algorithmic expression: Vector fields constructed from mathematical functions or noise. Particles born at edges, flowing along field lines.

**"Stochastic Crystallization"**
Philosophy: Random processes crystallizing into ordered structures.
Algorithmic expression: Randomized circle packing or Voronoi tessellation. Start with random points, let them evolve through relaxation algorithms.

### ESSENTIAL PRINCIPLES
- **ALGORITHMIC PHILOSOPHY**: Creating a computational worldview to be expressed through code
- **PROCESS OVER PRODUCT**: Beauty emerges from the algorithm's execution - each run is unique
- **PARAMETRIC EXPRESSION**: Ideas communicate through mathematical relationships, forces, behaviors
- **ARTISTIC FREEDOM**: Provide creative implementation room
- **PURE GENERATIVE ART**: This is about making LIVING ALGORITHMS, not static images with randomness
- **EXPERT CRAFTSMANSHIP**: Repeatedly emphasize the final algorithm must feel meticulously crafted

---

## DEDUCING THE CONCEPTUAL SEED

**CRITICAL STEP**: Before implementing the algorithm, identify the subtle conceptual thread from the original request.

The concept is a **subtle, niche reference embedded within the algorithm itself** - not always literal, always sophisticated. Someone familiar with the subject should feel it intuitively, while others simply experience a masterful generative composition.

---

## P5.JS IMPLEMENTATION

With the philosophy AND conceptual framework established, express it through code. Use only the algorithmic philosophy created and the instructions below.

### TECHNICAL REQUIREMENTS

**Seeded Randomness (Art Blocks Pattern)**:
\`\`\`javascript
let seed = 12345;
randomSeed(seed);
noiseSeed(seed);
\`\`\`

**Parameter Structure**:
\`\`\`javascript
let params = {
  seed: 12345,
  // Add parameters that control YOUR algorithm:
  // - Quantities, Scales, Probabilities, Ratios, Angles, Thresholds
};
\`\`\`

**Canvas Setup**:
\`\`\`javascript
function setup() {
  createCanvas(1200, 1200);
}

function draw() {
  // Your generative algorithm
}
\`\`\`

### CRAFTSMANSHIP REQUIREMENTS

- **Balance**: Complexity without visual noise, order without rigidity
- **Color Harmony**: Thoughtful palettes, not random RGB values
- **Composition**: Even in randomness, maintain visual hierarchy and flow
- **Performance**: Smooth execution, optimized for real-time if animated
- **Reproducibility**: Same seed ALWAYS produces identical output

### OUTPUT FORMAT

Output:
1. **Algorithmic Philosophy** - As markdown explaining the generative aesthetic
2. **Single HTML Artifact** - Self-contained interactive generative art

The HTML artifact contains everything: p5.js (from CDN), the algorithm, parameter controls, and UI - all in one file.

---

## INTERACTIVE ARTIFACT CREATION

Create a single, self-contained HTML artifact with the following structure:

### WHAT'S FIXED VS VARIABLE

**FIXED (always include):**
- Layout structure (header, sidebar, main canvas area)
- Brand styling (UI colors: dark #141413, light #faf9f5, orange #d97757, blue #6a9bcc, green #788c5d; fonts: Poppins headings, Lora body)
- Seed section in sidebar: Seed display, Previous/Next buttons, Random button, Jump to seed input + Go button
- Actions section in sidebar: Regenerate button, Reset button

**VARIABLE (customize for each artwork):**
- The entire p5.js algorithm (setup/draw/classes)
- The parameters object
- The Parameters section in sidebar (number of controls, names, min/max/step values)
- Colors section (optional — some art needs color pickers, some uses fixed colors)

### REQUIRED FEATURES

**1. Parameter Controls** - Sliders for numeric parameters, color pickers, real-time updates, reset button

**2. Seed Navigation** - Display current seed, Previous/Next/Random buttons, input field to jump to specific seed

**3. Single Artifact Structure**
\`\`\`html
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.7.0/p5.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --anthropic-dark: #141413;
      --anthropic-light: #faf9f5;
      --anthropic-mid-gray: #b0aea5;
      --anthropic-light-gray: #e8e6dc;
      --anthropic-orange: #d97757;
      --anthropic-blue: #6a9bcc;
      --anthropic-green: #788c5d;
    }
    /* Sidebar + canvas layout, Poppins/Lora fonts */
  </style>
</head>
<body>
  <div class="container">
    <div class="sidebar">
      <!-- Seed controls (FIXED) -->
      <!-- Parameter controls (VARIABLE) -->
      <!-- Actions (FIXED) -->
    </div>
    <div class="canvas-area">
      <div id="canvas-container"></div>
    </div>
  </div>
  <script>
    // ALL p5.js code inline
    // Parameters, classes, setup(), draw()
    // UI handlers, seed navigation
  </script>
</body>
</html>
\`\`\`

**CRITICAL**: This is a single artifact. No external files, no imports (except p5.js CDN and Google Fonts). Everything inline.

---

## VARIATIONS & EXPLORATION

The artifact includes seed navigation by default. If the user wants specific variations highlighted:
- Include seed presets
- Add a "Gallery Mode" that shows thumbnails of multiple seeds side-by-side
- All within the same single artifact

---

## THE CREATIVE PROCESS

**User request** -> **Algorithmic philosophy** -> **Implementation**

1. **Interpret the user's intent**
2. **Create an algorithmic philosophy** (4-6 paragraphs)
3. **Implement it in code**
4. **Design appropriate parameters**
5. **Build matching UI controls**
`
