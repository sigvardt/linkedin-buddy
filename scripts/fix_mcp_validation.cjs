const fs = require('fs');
const path = require('path');

const valFile = path.join(__dirname, '../packages/mcp/src/__tests__/linkedinMcp.validation.test.ts');
if (fs.existsSync(valFile)) {
  let content = fs.readFileSync(valFile, 'utf8');

  // We need to add LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL to validation tools tests
  const toolNameArray = `      LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
      LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL,
      LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,`;

  content = content.replace(`      LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
      LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,`, toolNameArray);

  fs.writeFileSync(valFile, content);
}
console.log('Fixed validation mappings');
