import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `# Internal Communications

## When to use this skill
To write internal communications, use this skill for:
- 3P updates (Progress, Plans, Problems)
- Company newsletters
- FAQ responses
- Status reports
- Leadership updates
- Project updates
- Incident reports

## How to use this skill

To write any internal communication:

1. **Identify the communication type** from the request
2. **Load the appropriate guideline file** from the reference files:
    - \`examples/3p-updates.md\` - For Progress/Plans/Problems team updates
    - \`examples/company-newsletter.md\` - For company-wide newsletters
    - \`examples/faq-answers.md\` - For answering frequently asked questions
    - \`examples/general-comms.md\` - For anything else that doesn't explicitly match one of the above
3. **Follow the specific instructions** in that file for formatting, tone, and content gathering

If the communication type doesn't match any existing guideline, ask for clarification or more context about the desired format.

## Keywords
3P updates, company newsletter, company comms, weekly update, faqs, common questions, updates, internal comms
`

const EXAMPLE_FILES: Record<string, string> = {
  'examples/3p-updates.md': `## Instructions
You are being asked to write a 3P update. 3P updates stand for "Progress, Plans, Problems." The main audience is for executives, leadership, other teammates, etc. They're meant to be very succinct and to-the-point: think something you can read in 30-60sec or less. They're also for people with some, but not a lot of context on what the team does.

3Ps can cover a team of any size, ranging all the way up to the entire company. The bigger the team, the less granular the tasks should be. For example, "mobile team" might have "shipped feature" or "fixed bugs," whereas the company might have really meaty 3Ps, like "hired 20 new people" or "closed 10 new deals."

They represent the work of the team across a time period, almost always one week. They include three sections:
1) Progress: what the team has accomplished over the next time period. Focus mainly on things shipped, milestones achieved, tasks created, etc.
2) Plans: what the team plans to do over the next time period. Focus on what things are top-of-mind, really high priority, etc. for the team.
3) Problems: anything that is slowing the team down. This could be things like too few people, bugs or blockers that are preventing the team from moving forward, some deal that fell through, etc.

Before writing them, make sure that you know the team name. If it's not specified, you can ask explicitly what the team name you're writing for is.

## Tools Available
Whenever possible, try to pull from available sources to get the information you need:
- Slack: posts from team members with their updates
- Google Drive: docs written from critical team members
- Email: emails with lots of responses or relevant content
- Calendar: non-recurring meetings with importance, like product reviews, etc.

## Workflow
1. **Clarify scope**: Confirm the team name and time period
2. **Gather information**: Use available tools or ask the user directly
3. **Draft the update**: Follow the strict formatting guidelines
4. **Review**: Ensure it's concise (30-60 seconds to read) and data-driven

## Formatting
The format is always the same, very strict formatting:

[pick an emoji] [Team Name] (Dates Covered, usually a week)
Progress: [1-3 sentences of content]
Plans: [1-3 sentences of content]
Problems: [1-3 sentences of content]

Each section should be no more than 1-3 sentences: clear, to the point. It should be data-driven, and generally include metrics where possible.`,

  'examples/company-newsletter.md': `## Instructions
You are being asked to write a company-wide newsletter update. Summarize the past week/month of a company in the form of a newsletter that the entire company will read. It should be maybe ~20-25 bullet points long. It will be sent via Slack and email, so make it consumable for that.

Attributes:
- Lots of links: pulling documents from Google Drive, linking to prominent Slack messages, referencing emails
- Short and to-the-point: each bullet should be no longer than ~1-2 sentences
- Use the "we" tense, as you are part of the company

## Sections
The company is pretty big: 1000+ people. Break into clusters like {product development, go to market, finance} or {recruiting, execution, vision}, etc.

## Prioritization
Focus on:
- Company-wide impact
- Announcements from leadership
- Major milestones and achievements
- Information that affects most employees
- External recognition or press

## Example Formats

:megaphone: Company Announcements
- Announcement 1, 2, 3

:dart: Progress on Priorities
- Area 1 with sub-areas

:pillar: Leadership Updates
- Post 1, 2, 3

:thread: Social Updates
- Update 1, 2, 3`,

  'examples/faq-answers.md': `## Instructions
You are an assistant for answering questions being asked across the company. Every week, there are lots of questions, and your goal is to summarize what those questions are and attempt to answer them.

Your job:
- Find questions that are big sources of confusion for lots of employees
- Attempt to give a nice summarized answer to minimize confusion

## Formatting
- *Question*: [insert question - 1 sentence]
- *Answer*: [insert answer - 1-2 sentence]

## Answer Guidelines
- Base answers on official company communications when possible
- If information is uncertain, indicate that clearly
- Link to authoritative sources (docs, announcements, emails)
- Keep tone professional but approachable
- Flag if a question requires executive input or official response`,

  'examples/general-comms.md': `## Instructions
You are being asked to write internal company communication that doesn't fit into the standard formats (3P updates, newsletters, or FAQs).

Before proceeding:
1. Ask the user about their target audience
2. Understand the communication's purpose
3. Clarify the desired tone (formal, casual, urgent, informational)
4. Confirm any specific formatting requirements

Use these general principles:
- Be clear and concise
- Use active voice
- Put the most important information first
- Include relevant links and references
- Match the company's communication style`,
}

export function registerInternalCommsSkill(): void {
  registerBundledSkill({
    name: 'internal-comms',
    description:
      'A set of resources to help write all kinds of internal communications. Use this skill whenever asked to write internal communications (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident reports, project updates, etc.).',
    userInvocable: true,
    files: EXAMPLE_FILES,
    async getPromptForCommand(args) {
      let prompt = SKILL_PROMPT
      if (args) {
        prompt += `\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
