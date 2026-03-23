import { validateToolArguments, LINKEDIN_MCP_TOOL_DEFINITIONS } from './packages/mcp/dist/bin/linkedin-mcp.js';

for (const tool of LINKEDIN_MCP_TOOL_DEFINITIONS) {
  if (tool.name.includes('NEWSLETTER')) {
    try {
      validateToolArguments(tool.name, {
        newsletter: "Test",
        title: "Test",
        body: "Test",
        cadence: "daily",
        description: "Test",
        edition: "Test",
        unexpectedProp: "Boom"
      });
      console.log("FAILED to reject on:", tool.name);
    } catch (e) {
      // Expected
    }
  }
}
