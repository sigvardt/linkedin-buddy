const fs = require('fs');
const path = require('path');

const mcpTestFile = path.join(__dirname, '../packages/mcp/src/__tests__/linkedinMcp.test.ts');
if (fs.existsSync(mcpTestFile)) {
  let content = fs.readFileSync(mcpTestFile, 'utf8');
  
  // Also we need to mock the prepareUpdate function in the fakeRuntime
  const fakeRuntimeStr = `  newsletters: {
    list: vi.fn(),
    prepareCreate: vi.fn(),
    prepareUpdate: vi.fn(),
    preparePublishIssue: vi.fn()
  },`;
  content = content.replace(`  newsletters: {
    list: vi.fn(),
    prepareCreate: vi.fn(),
    preparePublishIssue: vi.fn()
  },`, fakeRuntimeStr);
  
  // Also the test uses the tool array, let's make sure it's in the EXPECTED_TOOL_NAMES
  const expectedToolsStr = `  LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_UPDATE_TOOL,`;
  content = content.replace(`  LINKEDIN_NEWSLETTER_PREPARE_CREATE_TOOL,
  LINKEDIN_NEWSLETTER_PREPARE_PUBLISH_ISSUE_TOOL,`, expectedToolsStr);

  fs.writeFileSync(mcpTestFile, content);
}
console.log('Fixed MCP fake runtime mocking');
