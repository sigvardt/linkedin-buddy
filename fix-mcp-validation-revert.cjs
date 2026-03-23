const fs = require('fs');

const indexStr = 'packages/mcp/src/index.ts';
let idxContent = fs.readFileSync(indexStr, 'utf8');

const mcpStr = 'packages/mcp/src/bin/linkedin-mcp.ts';
let mcpContent = fs.readFileSync(mcpStr, 'utf8');

const helpersStr = 'packages/core/src/__tests__/e2e/helpers.ts';
let helpersContent = fs.readFileSync(helpersStr, 'utf8');

if (!idxContent.includes('export const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";')) {
  idxContent = idxContent.replace('export const LINKEDIN_NEWSLETTER_LIST_TOOL = "linkedin.newsletter.list";', 'export const LINKEDIN_NEWSLETTER_LIST_TOOL = "linkedin.newsletter.list";\nexport const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";');
  fs.writeFileSync(indexStr, idxContent, 'utf8');
}

if (!helpersContent.includes('LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL')) {
  helpersContent = helpersContent.replace('  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,', '  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,\n  LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,');
  helpersContent = helpersContent.replace('  newsletterPreparePublishIssue:\n    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,', '  newsletterPreparePublishIssue:\n    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,\n  newsletterListEditions: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,');
  fs.writeFileSync(helpersStr, helpersContent, 'utf8');
}

console.log("Fixed missing index definition from revert.");
