const fs = require('fs');

const mcpBinPath = 'packages/mcp/src/bin/linkedin-mcp.ts';
let mcpContent = fs.readFileSync(mcpBinPath, 'utf8');

const mcpIndexPath = 'packages/mcp/src/index.ts';
let indexContent = fs.readFileSync(mcpIndexPath, 'utf8');

if (!indexContent.includes('LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL')) {
  indexContent = indexContent.replace(
    'export const LINKEDIN_NEWSLETTER_LIST_TOOL = "linkedin.newsletter.list";',
    'export const LINKEDIN_NEWSLETTER_LIST_TOOL = "linkedin.newsletter.list";\nexport const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";'
  );
  fs.writeFileSync(mcpIndexPath, indexContent, 'utf8');
}

if (!mcpContent.includes('LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL')) {
  mcpContent = mcpContent.replace(
    'LINKEDIN_NEWSLETTER_LIST_TOOL,',
    'LINKEDIN_NEWSLETTER_LIST_TOOL,\n  LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,'
  );

  const listEditionsHandler = `
async function handleNewsletterListEditions(args: ToolArgs): Promise<ToolResult> {
  return withPublishingRuntime(async (runtime) => {
    runtime.logger.log("info", "mcp.newsletter.list_editions.start", {
      newsletter: args.newsletter
    });
    
    const newsletter = readRequiredString(args, "newsletter");

    const result = await runtime.newsletters.listEditions({
      profileName: readOptionalString(args, "profileName"),
      newsletter
    });

    runtime.logger.log("info", "mcp.newsletter.list_editions.done", {
      count: result.count
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  });
}
`;
  
  const endOfListHandler = mcpContent.indexOf('async function handleNewsletterPrepareUpdate');
  mcpContent = [
    mcpContent.slice(0, endOfListHandler),
    listEditionsHandler,
    mcpContent.slice(endOfListHandler)
  ].join('\n');

  const toolDef = `
    {
      name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,
      description: "List editions and stats for a specific LinkedIn newsletter.",
      inputSchema: {
        type: "object",
        required: ["newsletter"],
        properties: {
          profileName: {
            type: "string",
            description: "Optional profile to use. Defaults to the primary authenticated profile."
          },
          newsletter: {
            type: "string",
            description: "Newsletter title to list editions for."
          }
        }
      }
    },
`;

  mcpContent = mcpContent.replace(
    '{ name: LINKEDIN_NEWSLETTER_LIST_TOOL',
    toolDef + '{ name: LINKEDIN_NEWSLETTER_LIST_TOOL'
  );

  mcpContent = mcpContent.replace(
    '[LINKEDIN_NEWSLETTER_LIST_TOOL]: handleNewsletterList,',
    '[LINKEDIN_NEWSLETTER_LIST_TOOL]: handleNewsletterList,\n  [LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL]: handleNewsletterListEditions,'
  );

  fs.writeFileSync(mcpBinPath, mcpContent, 'utf8');
}

console.log("Successfully patched MCP tools.");
