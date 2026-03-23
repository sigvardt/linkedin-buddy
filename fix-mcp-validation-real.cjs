const fs = require('fs');

const path = 'packages/mcp/src/bin/linkedin-mcp.ts';
let content = fs.readFileSync(path, 'utf8');

// The issue is my previous patch put the SEND tool definition right before the function map, 
// outside the export const LINKEDIN_MCP_TOOL_DEFINITIONS = [ ... ] array!

const startArr = content.indexOf('export const LINKEDIN_MCP_TOOL_DEFINITIONS');
const endArr = content.indexOf('];', startArr);

// Remove the badly placed tool definition
const badToolDefStart = content.indexOf('    {\n      name: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL');
const badToolDefEnd = content.indexOf('    },', badToolDefStart) + 6;

if (badToolDefStart !== -1 && (badToolDefStart < startArr || badToolDefStart > endArr)) {
  const badDef = content.slice(badToolDefStart, badToolDefEnd);
  content = content.replace(badDef, '');
  
  // Now place it correctly inside the array!
  const targetSpot = content.indexOf('    name: LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL', startArr);
  if (targetSpot !== -1) {
    const braceStart = content.lastIndexOf('  {', targetSpot);
    content = content.slice(0, braceStart) + badDef + '\n' + content.slice(braceStart);
  } else {
    // just put it at the end of the array
    content = content.slice(0, endArr) + '  ' + badDef.trim() + '\n' + content.slice(endArr);
  }
}

// Ensure list editions is in the array too!
if (!content.includes('name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,')) {
  const listEditionsDef = `
  {
    name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,
    description: "List newsletter editions with performance statistics.",
    inputSchema: {
      type: "object",
      required: ["newsletter"],
      properties: {
        profileName: {
          type: "string",
          description: "Optional profile to use."
        },
        newsletter: {
          type: "string",
          description: "Newsletter title to list editions for."
        },
        includeStats: {
          type: "boolean",
          description: "Include open/click stats (takes longer)."
        }
      }
    }
  },
`;
  content = content.slice(0, endArr) + listEditionsDef + content.slice(endArr);
}

fs.writeFileSync(path, content, 'utf8');
console.log("Fixed MCP definitions array.");
