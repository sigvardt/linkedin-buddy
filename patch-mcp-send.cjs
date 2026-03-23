const fs = require('fs');

const mcpBinPath = 'packages/mcp/src/bin/linkedin-mcp.ts';
let mcpContent = fs.readFileSync(mcpBinPath, 'utf8');

const mcpIndexPath = 'packages/mcp/src/index.ts';
let indexContent = fs.readFileSync(mcpIndexPath, 'utf8');

if (!indexContent.includes('LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL')) {
  indexContent = indexContent.replace(
    'export const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";',
    'export const LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL = "linkedin.newsletter.list_editions";\nexport const LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL = "linkedin.newsletter.prepare_send";'
  );
  fs.writeFileSync(mcpIndexPath, indexContent, 'utf8');
}

if (!mcpContent.includes('LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL')) {
  mcpContent = mcpContent.replace(
    'LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,',
    'LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL,\n  LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,'
  );

  const sendHandler = `
async function handleNewsletterPrepareSend(args: ToolArgs): Promise<ToolResult> {
  return withPublishingRuntime(async (runtime) => {
    const newsletter = readRequiredString(args, "newsletter");
    const edition = readRequiredString(args, "edition");
    const recipients = readOptionalString(args, "recipients");
    
    runtime.logger.log("info", "mcp.newsletter.prepare_send.start", {
      newsletter, edition, recipients
    });

    const prepared = await runtime.newsletters.prepareSend({
      profileName: readOptionalString(args, "profileName"),
      newsletter,
      edition,
      recipients: recipients as any
    });

    runtime.logger.log("info", "mcp.newsletter.prepare_send.done", {
      newsletter, edition
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(prepared, null, 2)
        }
      ]
    };
  });
}
`;
  
  const endOfListHandler = mcpContent.indexOf('async function handleNewsletterListEditions');
  mcpContent = [
    mcpContent.slice(0, endOfListHandler),
    sendHandler,
    mcpContent.slice(endOfListHandler)
  ].join('\n');

  const toolDef = `
    {
      name: LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL,
      description: "Prepare to send/share a specific LinkedIn newsletter edition (two-phase: returns confirm token). Use linkedin.actions.confirm to send it.",
      inputSchema: {
        type: "object",
        required: ["newsletter", "edition"],
        properties: {
          profileName: {
            type: "string",
            description: "Optional profile to use. Defaults to the primary authenticated profile."
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
        }
      }
    },
`;

  mcpContent = mcpContent.replace(
    '{ name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL',
    toolDef + '{ name: LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL'
  );

  mcpContent = mcpContent.replace(
    '[LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL]: handleNewsletterListEditions,',
    '[LINKEDIN_NEWSLETTER_LIST_EDITIONS_TOOL]: handleNewsletterListEditions,\n  [LINKEDIN_NEWSLETTER_PREPARE_SEND_TOOL]: handleNewsletterPrepareSend,'
  );

  fs.writeFileSync(mcpBinPath, mcpContent, 'utf8');
}

console.log("Successfully patched MCP send tools.");
