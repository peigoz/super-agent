import fs from 'node:fs';
import path from 'node:path';

// 整个 skill 系统最关键的设计——渐进式加载。实现分三层：
// Level 1 启动时只加载 frontmatter（name + description + when_to_use，每个 skill 大概 100 token）；
// Level 2 用户激活后才加载完整内容；
// Level 3 skill 目录下的参考文件按需用 Read 工具读取。
export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  dirPath: string;
}

const SKILLS_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
  private readonly baseDir: string;
  private skills = new Map<string, SkillDefinition>();

  public activeSkills = new Set<string>();

  constructor(baseDir = '.') {
    this.baseDir = baseDir;
  }

  load(): SkillDefinition[] {
    this.skills.clear();
    const skillsDir = path.join(this.baseDir, SKILLS_DIR);
    if (!fs.existsSync(skillsDir)) return [];

    const entries = fs.readdirSync(skillsDir, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = this.findSkillFile(path.join(skillsDir, entry.name));
      if (!skillFile) continue;

      const raw = fs.readFileSync(skillFile, 'utf-8');
      const parsed = this.parseFrontmatter(raw);
      if (!parsed) continue;

      this.skills.set(entry.name, {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        dirPath: path.join(skillsDir, entry.name),
      });
    }
    return this.list();
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  buildPromptSection(): string | null {
    if (this.skills.size === 0) return null;
    const lines: string[] = [];

    for (const name of this.activeSkills) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      lines.push(`[激活的 Skill: ${skill.name}]`);
      lines.push(skill.content);
      lines.push('');
    }

    const available = this.list()
      .filter(s => !this.activeSkills.has(s.name))
      .map(s => {
        const hint = s.whenToUse ? ` (适用场景: ${s.whenToUse})` : '';
        return `  /${s.name} — ${s.description}${hint}`
      })

    if (available.length > 0) {
      lines.push('可用的 Skills（输入 /skill load <name> 激活）：');
      lines.push(...available);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  // 大小写不敏感地查找 skill 文件（SKILL.md / skill.md / Skill.md ...）
  private findSkillFile(dirPath: string): string | null {
    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      return null;
    }
    const matched = files.find(f => f.toLowerCase() === SKILL_FILE.toLowerCase());
    return matched ? path.join(dirPath, matched) : null;
  }

  // 生产环境可以换成 gray-matter 解析
  private parseFrontmatter(raw: string): {description: string; whenToUse?: string; content: string} | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return {description: '', content: raw};
    const meta: Record<string, string> = {};
    for (const line of match[ 1 ].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        meta[ key ] = value;
      }
    }
    return {description: meta.description || '', whenToUse: meta.when_to_use || undefined, content: match[ 2 ].trim()};
  }
}

export function skillRepoter(skillLoader: SkillLoader) {
  const loadedSkills = skillLoader.list()

  if (loadedSkills.length > 0) {
    console.log(`发现 ${loadedSkills.length} 个 skill：`);
    for (const s of loadedSkills) console.log(`    /${s.name} — ${s.description}`);
    console.log('');
  }
}