const fs = require('fs');
const path = 'packages/mcp/src/bin/linkedin-mcp.ts';
let content = fs.readFileSync(path, 'utf8');

// I need to make sure additionalProperties: false is properly added to the schemas.
// Looking for LIST_EDITIONS
const listStr = 'name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,';
const listIdx = content.indexOf(listStr);
if (listIdx !== -1) {
  const inputSchemaIdx = content.indexOf('inputSchema', listIdx);
  const endBrace = content.indexOf('      }\n    }', inputSchemaIdx);
  if (endBrace !== -1 && !content.slice(inputSchemaIdx, endBrace + 15).includes('additionalProperties: false')) {
    content = content.slice(0, endBrace) + '      },\n      additionalProperties: false\n    }' + content.slice(endBrace + 12);
  }
}

const sendStr = 'name: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,';
const sendIdx = content.indexOf(sendStr);
if (sendIdx !== -1) {
  const inputSchemaIdx = content.indexOf('inputSchema', sendIdx);
  const endBrace = content.indexOf('      }\n    }', inputSchemaIdx);
  if (endBrace !== -1 && !content.slice(inputSchemaIdx, endBrace + 15).includes('additionalProperties: false')) {
    content = content.slice(0, endBrace) + '      },\n      additionalProperties: false\n    }' + content.slice(endBrace + 12);
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log("Fixed additionalProperties");
