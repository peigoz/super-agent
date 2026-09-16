import type {SkillLoader} from "../skills/loader";
import type {ToolDefinition} from "./registry";

export function createSkillTool(
  skillLoader: SkillLoader,
): ToolDefinition {
  return {
    name: 'skill',
    description: '管理 Skill ，当使用场景需要时，可激活或卸载 skill。',
    parameters: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: [ 'load', 'unload' ]},
        name: {
          type: 'string',
          description: '想要激活或卸载的 skill 名称',
        },
        required: [ 'action', 'name' ],
      },
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({action, name}: {action: 'load' | 'unload', name: string}) => {
      if (!action) return '请输入 action 参数'
      if (!name) return '请输入 name 参数'

      const skill = skillLoader.get(name);
      if (!skill) {
        return `找不到 skill: ${name},请检查名称是否有误。当前未激活的 skill 如下：
        ${skillLoader.availableList().map((skill, idx) => {
          return `${idx + 1} : ${skill.name}`
        })}`;
      }

      if (action === 'load') {
        skillLoader.activeSkills.add(name);
        return `[skill] 已激活: ${name} — ${skill.description}
        ${skill.content}
        `;
      }

      // unload
      if (!skillLoader.activeSkills.has(name)) {
        return `[skill] ${name} 未激活`;
      }

      skillLoader.activeSkills.delete(name);
      return `[skill] 已卸载: ${name}`;
    },
  };
}
