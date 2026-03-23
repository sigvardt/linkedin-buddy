const fs = require('fs');

// Fix linkedinMcp.validation.test.ts issues by ensuring index.ts exports everything correctly
const mcpIndex = 'packages/mcp/src/index.ts';
let indexContent = fs.readFileSync(mcpIndex, 'utf8');

// Ensure both tools are exported correctly
const expectedListEditions = 'export const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";';
const expectedPrepareSend = 'export const LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL = "linkedin.newsletter.prepare_send";';

let indexChanged = false;
if (!indexContent.includes(expectedListEditions)) {
  indexContent += `\n${expectedListEditions}`;
  indexChanged = true;
}
if (!indexContent.includes(expectedPrepareSend)) {
  indexContent += `\n${expectedPrepareSend}`;
  indexChanged = true;
}

if (indexChanged) {
  fs.writeFileSync(mcpIndex, indexContent, 'utf8');
}

// In the validation test, let's see what it exports vs what's in mcp.ts
// Need to find where mcp validation gets its exportedToolNames
// It looks like it might pull from mcp bin or index.
console.log("Validation test fix attempted.");
