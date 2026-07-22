export type SuperpowersSkill = {
  name: string;
  description: string;
  skillPath: string;
};

export type LoadedSkill = SuperpowersSkill & {
  content: string;
};

export type SkillCatalog = {
  list(): readonly SuperpowersSkill[];
  load(name: string): Promise<LoadedSkill>;
  loadResource(name: string, relativePath: string): Promise<string>;
};
