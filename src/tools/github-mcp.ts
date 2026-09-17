import type {SuperAgentConfig} from '../config/schema';
import {MCPClient, MockMCPClient} from './mcp-client';
import type {ToolRegistry} from './registry';


export async function connectGithubMCP(registry: ToolRegistry, github: SuperAgentConfig[ 'mcp' ][ 'github' ]) {
  const githubToken = github.token;

  let canSpawn = true;
  try {
    const {execSync} = await import('node:child_process');
    execSync('echo test', {stdio: 'ignore'});
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log('连接 GitHub MCP Server...');
    try {
      const client = new MCPClient(
        'npx', [ '-y', '@modelcontextprotocol/server-github' ],
        {GITHUB_PERSONAL_ACCESS_TOKEN: githubToken},
      );
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具\n`);
      return;
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
      console.log('  降级为 Mock MCP...\n');
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
  }

  const mockClient = new MockMCPClient();
  const tools = await registry.registerMCPServer('github', mockClient);
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}