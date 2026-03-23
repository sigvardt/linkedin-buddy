const fs = require('fs');

// 1. Fix linkedinPublishing.test.ts
const testPath1 = 'packages/core/src/__tests__/linkedinPublishing.test.ts';
let content1 = fs.readFileSync(testPath1, 'utf8');

if (!content1.includes('SEND_NEWSLETTER_ACTION_TYPE')) {
  // Add import
  content1 = content1.replace('  PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,', '  PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,\n  SEND_NEWSLETTER_ACTION_TYPE,');
  
  // Add to test array
  content1 = content1.replace('      PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE\n    ]);', '      PUBLISH_NEWSLETTER_ISSUE_ACTION_TYPE,\n      SEND_NEWSLETTER_ACTION_TYPE\n    ]);');
  fs.writeFileSync(testPath1, content1, 'utf8');
}

// 2. Fix e2eHelpers.test.ts
const testPath2 = 'packages/core/src/__tests__/e2eHelpers.test.ts';
let content2 = fs.readFileSync(testPath2, 'utf8');

if (!content2.includes('LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL')) {
  // Add import
  content2 = content2.replace('  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,', '  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,\n  LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,\n  LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,');
  
  // Add to mapping
  content2 = content2.replace('  newsletterPreparePublishIssue:\n    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,', '  newsletterPreparePublishIssue:\n    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,\n  newsletterListEditions: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,\n  newsletterPrepareSend: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,');
  fs.writeFileSync(testPath2, content2, 'utf8');
}

// 3. Fix linkedinMcp.validation.test.ts - we also need to make sure the exports in the main index file are available
// Actually, e2eHelpers.test.ts exports tool names in packages/core/src/__tests__/e2e/helpers.ts 
// We should check that file too.
const helpersPath = 'packages/core/src/__tests__/e2e/helpers.ts';
if (fs.existsSync(helpersPath)) {
  let content3 = fs.readFileSync(helpersPath, 'utf8');
  if (!content3.includes('LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL')) {
    content3 = content3.replace('  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,', '  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,\n  LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,\n  LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,');
    
    content3 = content3.replace('  newsletterPreparePublishIssue:\n    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,', '  newsletterPreparePublishIssue:\n    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,\n  newsletterListEditions: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,\n  newsletterPrepareSend: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,');
    fs.writeFileSync(helpersPath, content3, 'utf8');
  }
}

// Check index exports for linkedinMcp.validation.test.ts
const mcpIndex = 'packages/mcp/src/index.ts';
let mcpIndexContent = fs.readFileSync(mcpIndex, 'utf8');
if (!mcpIndexContent.includes('export const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";')) {
  mcpIndexContent = mcpIndexContent.replace('export const LINKEDIN_NEWSLETTER_LIST_TOOL = "linkedin.newsletter.list";', 'export const LINKEDIN_NEWSLETTER_LIST_TOOL = "linkedin.newsletter.list";\nexport const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";\nexport const LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL = "linkedin.newsletter.prepare_send";');
  fs.writeFileSync(mcpIndex, mcpIndexContent, 'utf8');
}

console.log("Fixed tests and exports.");
