const fs = require('fs');
const { execSync } = require('child_process');

const path = 'packages/mcp/src/bin/linkedin-mcp.ts';
let content = fs.readFileSync(path, 'utf8');

const definitionsArr = content.split('export const LINKEDIN_MCP_TOOL_DEFINITIONS')[1];
const listToolIdx = definitionsArr.indexOf('LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL');
const sendToolIdx = definitionsArr.indexOf('LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL');

console.log("List Tool Definition:", definitionsArr.substring(listToolIdx - 15, definitionsArr.indexOf('  },', listToolIdx) + 4));
console.log("Send Tool Definition:", definitionsArr.substring(sendToolIdx - 15, definitionsArr.indexOf('  },', sendToolIdx) + 4));
