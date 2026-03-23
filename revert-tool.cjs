const fs = require('fs');
const path = 'packages/mcp/src/bin/linkedin-mcp.ts';
let content = fs.readFileSync(path, 'utf8');

// I also need to add the LIST_EDITIONS to the defined tool array
if (!content.includes('name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL')) {
  const startArr = content.indexOf('export const LINKEDIN_MCP_TOOL_DEFINITIONS');
  const endArr = content.indexOf('];', startArr);
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
      },
      additionalProperties: false
    }
  },
`;
  content = content.slice(0, endArr) + listEditionsDef + content.slice(endArr);
  fs.writeFileSync(path, content, 'utf8');
  console.log("Added LIST_EDITIONS to array");
}

