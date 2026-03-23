const fs = require('fs');

const mcpBin = 'packages/mcp/src/bin/linkedin-mcp.ts';
let content = fs.readFileSync(mcpBin, 'utf8');

// I need to find the tool definitions array and ensure the send tool is inside it.
if (!content.includes('LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,')) {
  console.log("Adding SEND tool to definitions...");
}

// wait, the problem is that SEND and LIST_EDITIONS are in the index.ts but missing from LINKEDIN_MCP_TOOL_DEFINITIONS in linkedin-mcp.ts!
// Let me look at where list tool is defined
const listPattern = '    name: LINKEDIN_NEWSLETTER_LIST_TOOL,';
const idx = content.indexOf(listPattern);

if (idx === -1) {
  console.log("Could not find list tool.");
} else {
  // We added the send tool earlier. Where did we put it?
  const sendToolPattern = '    {      name: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,';
  console.log("Send tool exists in file:", content.includes('LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,'));
  
  // Did we put it inside the array or outside?
  const arrayStart = content.indexOf('export const LINKEDIN_MCP_TOOL_DEFINITIONS');
  const sendIdx = content.indexOf('LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,', arrayStart);
  
  console.log("Is send in array?", sendIdx !== -1 && sendIdx > arrayStart);
}
