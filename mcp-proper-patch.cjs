const fs = require('fs');

const indexFile = 'packages/mcp/src/index.ts';
let indexCode = fs.readFileSync(indexFile, 'utf8');

indexCode = indexCode.replace(
  'export const LINKEDIN_EVENTS_SEARCH_TOOL = "linkedin.events.search";',
  'export const LINKEDIN_GROUPS_CREATE_TOOL = "linkedin.groups.create";\nexport const LINKEDIN_EVENTS_CREATE_TOOL = "linkedin.events.create";\nexport const LINKEDIN_EVENTS_SEARCH_TOOL = "linkedin.events.search";'
);
fs.writeFileSync(indexFile, indexCode);

const mcpFile = 'packages/mcp/src/bin/linkedin-mcp.ts';
let mcpCode = fs.readFileSync(mcpFile, 'utf8');

// Add imports
mcpCode = mcpCode.replace(
  'LINKEDIN_EVENTS_SEARCH_TOOL,',
  'LINKEDIN_GROUPS_CREATE_TOOL,\n  LINKEDIN_EVENTS_CREATE_TOOL,\n  LINKEDIN_EVENTS_SEARCH_TOOL,'
);

// Add to tool definitions array
const mcpTools = `  {
    name: LINKEDIN_GROUPS_CREATE_TOOL,
    description: "Create a new LinkedIn group",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: LINKEDIN_EVENTS_CREATE_TOOL,
    description: "Create a new LinkedIn event",
    inputSchema: {
      type: "object",
      properties: {
        profileName: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
      },
      required: ["name", "description"],
    },
  },`;

mcpCode = mcpCode.replace(
  '  { name: LINKEDIN_EVENTS_SEARCH_TOOL,',
  mcpTools + '\n  { name: LINKEDIN_EVENTS_SEARCH_TOOL,'
);

// Handlers
const mcpHandlers = `    case LINKEDIN_GROUPS_CREATE_TOOL: {
      const result = await runtime.groups.createGroup({
        profileName: String(request.params.arguments?.profileName || "default"),
        name: String(request.params.arguments?.name),
        description: String(request.params.arguments?.description),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case LINKEDIN_EVENTS_CREATE_TOOL: {
      const result = await runtime.events.createEvent({
        profileName: String(request.params.arguments?.profileName || "default"),
        name: String(request.params.arguments?.name),
        description: String(request.params.arguments?.description),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }`;

mcpCode = mcpCode.replace(
  '    case LINKEDIN_EVENTS_SEARCH_TOOL: {',
  mcpHandlers + '\n    case LINKEDIN_EVENTS_SEARCH_TOOL: {'
);

fs.writeFileSync(mcpFile, mcpCode);
