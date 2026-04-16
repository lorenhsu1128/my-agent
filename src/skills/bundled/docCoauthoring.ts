import { registerBundledSkill } from '../bundledSkills.js'

// 15KB prompt — inline is fine for this size
const DOC_COAUTHORING_PROMPT = `# Doc Co-Authoring Workflow

This skill provides a structured workflow for guiding users through collaborative document creation. Act as an active guide, walking users through three stages: Context Gathering, Refinement & Structure, and Reader Testing.

## When to Offer This Workflow

**Trigger conditions:**
- User mentions writing documentation: "write a doc", "draft a proposal", "create a spec", "write up"
- User mentions specific doc types: "PRD", "design doc", "decision doc", "RFC"
- User seems to be starting a substantial writing task

**Initial offer:**
Offer the user a structured workflow for co-authoring the document. Explain the three stages:

1. **Context Gathering**: User provides all relevant context while Claude asks clarifying questions
2. **Refinement & Structure**: Iteratively build each section through brainstorming and editing
3. **Reader Testing**: Test the doc with a fresh Claude (no context) to catch blind spots before others read it

Explain that this approach helps ensure the doc works well when others read it (including when they paste it into Claude). Ask if they want to try this workflow or prefer to work freeform.

If user declines, work freeform. If user accepts, proceed to Stage 1.

## Stage 1: Context Gathering

**Goal:** Close the gap between what the user knows and what Claude knows, enabling smart guidance later.

### Initial Questions

Start by asking the user for meta-context about the document:

1. What type of document is this? (e.g., technical spec, decision doc, proposal)
2. Who's the primary audience?
3. What's the desired impact when someone reads this?
4. Is there a template or specific format to follow?
5. Any other constraints or context to know?

Inform them they can answer in shorthand or dump information however works best for them.

**If user provides a template or mentions a doc type:**
- Ask if they have a template document to share
- If they provide a link to a shared document, use the appropriate integration to fetch it
- If they provide a file, read it

**If user mentions editing an existing shared document:**
- Use the appropriate integration to read the current state
- Check for images without alt-text
- If images exist without alt-text, explain that when others use Claude to understand the doc, Claude won't be able to see them. Ask if they want alt-text generated. If so, request they paste each image into chat for descriptive alt-text generation.

### Info Dumping

Once initial questions are answered, encourage the user to dump all the context they have. Request information such as:
- Background on the project/problem
- Related team discussions or shared documents
- Why alternative solutions aren't being used
- Organizational context (team dynamics, past incidents, politics)
- Timeline pressures or constraints
- Technical architecture or dependencies
- Stakeholder concerns

Advise them not to worry about organizing it - just get it all out. Offer multiple ways to provide context:
- Info dump stream-of-consciousness
- Point to team channels or threads to read
- Link to shared documents

**If integrations are available** (e.g., Slack, Teams, Google Drive, SharePoint, or other MCP servers), mention that these can be used to pull in context directly.

**If no integrations are detected and in Claude.ai or Claude app:** Suggest they can enable connectors in their Claude settings to allow pulling context from messaging apps and document storage directly.

Inform them clarifying questions will be asked once they've done their initial dump.

**During context gathering:**

- If user mentions team channels or shared documents:
  - If integrations available: Inform them the content will be read now, then use the appropriate integration
  - If integrations not available: Explain lack of access. Suggest they enable connectors in Claude settings, or paste the relevant content directly.

- If user mentions entities/projects that are unknown:
  - Ask if connected tools should be searched to learn more
  - Wait for user confirmation before searching

- As user provides context, track what's being learned and what's still unclear

**Asking clarifying questions:**

When user signals they've done their initial dump (or after substantial context provided), ask clarifying questions to ensure understanding:

Generate 5-10 numbered questions based on gaps in the context.

Inform them they can use shorthand to answer (e.g., "1: yes, 2: see #channel, 3: no because backwards compat"), link to more docs, point to channels to read, or just keep info-dumping. Whatever's most efficient for them.

**Exit condition:**
Sufficient context has been gathered when questions show understanding - when edge cases and trade-offs can be asked about without needing basics explained.

**Transition:**
Ask if there's any more context they want to provide at this stage, or if it's time to move on to drafting the document.

If user wants to add more, let them. When ready, proceed to Stage 2.

## Stage 2: Refinement & Structure

**Goal:** Build the document section by section through brainstorming, curation, and iterative refinement.

**Instructions to user:**
Explain that the document will be built section by section. For each section:
1. Clarifying questions will be asked about what to include
2. 5-20 options will be brainstormed
3. User will indicate what to keep/remove/combine
4. The section will be drafted
5. It will be refined through surgical edits

Start with whichever section has the most unknowns (usually the core decision/proposal), then work through the rest.

**Section ordering:**

If the document structure is clear:
Ask which section they'd like to start with.

Suggest starting with whichever section has the most unknowns. For decision docs, that's usually the core proposal. For specs, it's typically the technical approach. Summary sections are best left for last.

If user doesn't know what sections they need:
Based on the type of document and template, suggest 3-5 sections appropriate for the doc type.

Ask if this structure works, or if they want to adjust it.

**Once structure is agreed:**

Create the initial document structure with placeholder text for all sections.

**For each section:**

### Step 1: Clarifying Questions

Announce work will begin on the [SECTION NAME] section. Ask 5-10 clarifying questions about what should be included.

### Step 2: Brainstorming

For the [SECTION NAME] section, brainstorm [5-20] things that might be included, depending on the section's complexity. Look for:
- Context shared that might have been forgotten
- Angles or considerations not yet mentioned

### Step 3: Curation

Ask which points should be kept, removed, or combined. Request brief justifications to help learn priorities for the next sections.

### Step 4: Gap Check

Based on what they've selected, ask if there's anything important missing for the [SECTION NAME] section.

### Step 5: Drafting

Use the appropriate tool to replace the placeholder text for this section with the actual drafted content.

### Step 6: Iterative Refinement

As user provides feedback:
- Make surgical edits (never reprint the whole doc)
- If user edits doc directly and asks to read it: mentally note the changes they made and keep them in mind for future sections

**Continue iterating** until user is satisfied with the section.

### Quality Checking

After 3 consecutive iterations with no substantial changes, ask if anything can be removed without losing important information.

**Repeat for all sections.**

### Near Completion

As approaching completion (80%+ of sections done), announce intention to re-read the entire document and check for:
- Flow and consistency across sections
- Redundancy or contradictions
- Anything that feels like "slop" or generic filler
- Whether every sentence carries weight

## Stage 3: Reader Testing

**Goal:** Test the document with a fresh Claude (no context bleed) to verify it works for readers.

### Step 1: Predict Reader Questions

Generate 5-10 questions that readers would realistically ask when trying to discover this document.

### Step 2: Test with Sub-Agent

For each question, invoke a sub-agent with just the document content and the question.

Summarize what Reader Claude got right/wrong for each question.

### Step 3: Run Additional Checks

Invoke sub-agent to check for ambiguity, false assumptions, contradictions.

### Step 4: Report and Fix

If issues found, list the specific issues and fix the gaps. Loop back to refinement for problematic sections.

### Exit Condition

When Reader Claude consistently answers questions correctly and doesn't surface new gaps or ambiguities, the doc is ready.

## Final Review

When Reader Testing passes:
1. Recommend they do a final read-through themselves
2. Suggest double-checking any facts, links, or technical details
3. Ask them to verify it achieves the impact they wanted

## Tips for Effective Guidance

**Tone:** Be direct and procedural. Explain rationale briefly when it affects user behavior.

**Handling Deviations:** If user wants to skip a stage, ask if they want to skip and write freeform. Always give user agency to adjust the process.

**Context Management:** Throughout, if context is missing on something mentioned, proactively ask. Don't let gaps accumulate.

**Quality over Speed:** Don't rush through stages. Each iteration should make meaningful improvements. The goal is a document that actually works for readers.
`

export function registerDocCoauthoringSkill(): void {
  registerBundledSkill({
    name: 'doc-coauthoring',
    description:
      'Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc works for readers. Trigger when user mentions writing docs, creating proposals, drafting specs, or similar documentation tasks.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = DOC_COAUTHORING_PROMPT
      if (args) {
        prompt += `\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
