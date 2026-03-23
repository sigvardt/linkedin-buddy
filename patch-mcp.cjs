const fs = require('fs');

const mcpIndexPath = 'packages/mcp/src/index.ts';
let indexContent = fs.readFileSync(mcpIndexPath, 'utf8');

const mcpMarker = 'export const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";';

if (indexContent.includes(mcpMarker)) {
  indexContent = indexContent.replace(
    mcpMarker,
    mcpMarker + '\nexport const LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL = "linkedin.newsletter.prepare_send";'
  );
  fs.writeFileSync(mcpIndexPath, indexContent, 'utf8');
  console.log("MCP index patched successfully.");
} else {
  console.log("MCP index marker not found.");
}
