const fs = require('fs');
const path = 'packages/mcp/src/bin/linkedin-mcp.ts';
let content = fs.readFileSync(path, 'utf8');

if (!content.includes('name: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,')) {
  const sendDef = `
  {
    name: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,
    description: "Prepare to send/share a specific LinkedIn newsletter edition (two-phase: returns confirm token). Use linkedin.actions.confirm to send it.",
    inputSchema: {
      type: "object",
      required: ["newsletter", "edition"],
      properties: {
        profileName: {
          type: "string",
          description: "Optional profile to use."
        },
        newsletter: {
          type: "string",
          description: "Newsletter title."
        },
        edition: {
          type: "string",
          description: "Edition title to send/share."
        },
        recipients: {
          type: "string",
          description: "Optional recipients. 'all' or specific segment."
        }
      },
      additionalProperties: false
    }
  },
`;

  const targetSpot = content.indexOf('    name: LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL');
  const braceStart = content.lastIndexOf('  {', targetSpot);
  content = content.slice(0, braceStart) + sendDef + content.slice(braceStart);
} else {
  // Add additionalProperties: false to it to fix the second test
  const defStart = content.indexOf('name: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,');
  const propEnd = content.indexOf('        }', defStart) + 9;
  
  if (!content.slice(defStart, propEnd + 50).includes('additionalProperties')) {
    content = content.slice(0, propEnd) + ',\n      additionalProperties: false\n    ' + content.slice(propEnd);
  }
}

// Add additionalProperties: false to List Editions
const listDefStart = content.indexOf('name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,');
if (listDefStart !== -1) {
  const propEnd = content.indexOf('        }', listDefStart) + 9;
  if (!content.slice(listDefStart, propEnd + 50).includes('additionalProperties')) {
    content = content.slice(0, propEnd) + ',\n      additionalProperties: false\n    ' + content.slice(propEnd);
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log("Fixed MCP definitions again.");
