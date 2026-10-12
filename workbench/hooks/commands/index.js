// The slash commands the mod registers, with their help text.

export const COMMANDS = [
  { name: 'workbench', description: 'Open the Workbench: features, their agents, context and workflows', argumentHint: '[feature id]' },
  { name: 'wb', description: 'Alias of /workbench', argumentHint: '[feature id]' },
  {
    name: 'experience',
    description: 'Group features into Experiences with shared context',
    argumentHint: '[new <title>|list|show <id>|describe <id> <text>|runner <id> session|web|default|planfirst <id> on|off|add <experience> <feature>|remove <feature>|start <id>|delete <id>]',
  },
  {
    name: 'feature',
    description: 'Create, switch, start, answer and manage Features',
    argumentHint: '[new <title>|switch <id>|start [id]|describe [id] <text>|runner [id] session|web|approach [id] auto|plan|direct|approve [id] [note]|answer <id> <text>|say <id> <text>|interrupt [id]|stop [id]|reset [id]|status|notify [on|off|test]|list|remote [source]|pull <source>:<id>|archive <id>|delete <id>]',
  },
  {
    name: 'ctx',
    description: 'Manage context providers scoped to the active Feature',
    argumentHint: '[add <file|command|url|note|mcp> <value>|remove <id>|list]',
  },
  {
    name: 'workflow',
    description: 'Run shared registry workflows or manage the active Feature\'s own',
    argumentHint: '[run <id|name>|list|add <name> <skill|script> <target>|remove <name>]',
  },
]
