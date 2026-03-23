const fs = require('fs');
const path = require('path');

const helperFile = path.join(__dirname, '../packages/core/src/__tests__/e2e/helpers.ts');
let content = fs.readFileSync(helperFile, 'utf8');

const importStr = `  LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL,`;

content = content.replace(`  LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,`, importStr);

const mappingStr = `  newsletterPrepareCreate: LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
  newsletterPreparePublishIssue:
    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,
  newsletterPrepareUpdate: LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL,`;

content = content.replace(`  newsletterPrepareCreate: LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
  newsletterPreparePublishIssue:
    LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,`, mappingStr);

fs.writeFileSync(helperFile, content);

const mcpTestFile = path.join(__dirname, '../packages/mcp/src/__tests__/linkedinMcp.test.ts');
if (fs.existsSync(mcpTestFile)) {
  let mcpContent = fs.readFileSync(mcpTestFile, 'utf8');
  
  const mcpImportStr = `  LINKEDIN_NEWSLETTER_LIST_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL,`;
  
  mcpContent = mcpContent.replace(`  LINKEDIN_NEWSLETTER_LIST_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,`, mcpImportStr);
  
  fs.writeFileSync(mcpTestFile, mcpContent);
}

console.log('Fixed helper test mappings');
