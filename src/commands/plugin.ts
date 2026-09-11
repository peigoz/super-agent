import type {CommandHandler} from './index.js';

export const pluginCommands: CommandHandler[] = [
  // /plugin 或 /plugin list
  (cmd, ctx) => {
    if (cmd !== '/plugin' && cmd !== '/plugin list') return false;

    const pluginManager = ctx.pluginManager;
    const loaded = pluginManager.list();
    const unloaded = Array.from(pluginManager.availablePlugins.entries())
      .filter(([ name ]) => !loaded.find(p => p.name === name));

    if (loaded.length === 0 && unloaded.length === 0) {
      console.log('\n[plugins] 没有可用的插件。\n');
      return true;
    }

    console.log('\n[plugins]');
    if (loaded.length > 0) {
      console.log('  已加载：');
      for (const p of loaded) {
        console.log(`    ${p.name} v${p.version} — ${p.description}`);
        console.log(`      工具: ${p.tools.join(', ')}`);
      }
    }
    if (unloaded.length > 0) {
      console.log('  可加载：');
      for (const [ name, def ] of unloaded) {
        console.log(`    ${name} v${def.version} — ${def.description}`);
      }
    }
    console.log('');
    return true;
  },

  // /plugin load <name>
  (cmd, ctx) => {
    if (!cmd.startsWith('/plugin load') && !cmd.startsWith('plugin load')) return false;

    const pluginManager = ctx.pluginManager;
    const match = cmd.match(/^\/plugin\s+load\s+(\S+)$/);
    if (!match) return false;
    const name = match[ 1 ];

    const def = pluginManager.availablePlugins.get(name);
    if (!def) {
      console.log(`\n[plugins] 找不到插件: ${name}\n`);
      return true;
    }

    if (pluginManager.get(name)) {
      console.log(`\n[plugins] ${name} 已经加载了\n`);
      return true;
    }

    pluginManager.load(def).then(tools => {
      console.log(`\n[plugins] 已加载 ${name}，注册了 ${tools.length} 个工具：`);
      for (const t of tools) console.log(`    ${t}`);
      console.log('');
    }).catch(err => {
      console.log(`\n[plugins] 加载 ${name} 失败: ${err.message}\n`);
    }).finally(() => {
      ctx.ask()
    })

    return 'async';
  },

  // /plugin unload <name>
  (cmd, ctx) => {
    if (!cmd.startsWith('/plugin unload') && !cmd.startsWith('plugin unload')) return false;

    const pluginManager = ctx.pluginManager;
    const match = cmd.match(/^\/plugin\s+unload\s+(\S+)$/);
    if (!match) return false;
    const name = match[ 1 ];

    pluginManager.unload(name).then(ok => {
      if (ok) {
        console.log(`\n[plugins] 已卸载 ${name}，相关工具已移除\n`);
      } else {
        console.log(`\n[plugins] ${name} 未加载\n`);
      }

      ctx.ask()
    });

    return 'async';
  },
];