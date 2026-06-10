# Blinkora Codex agent assets

这里放 Codex 项目级可复用资产。

- `.agents/skills/`: 项目级 skills，目录格式为 `<skill-name>/SKILL.md`。
- `AGENTS.md` 不放这里，继续保留在项目根目录，用来声明项目级长期指令。

如果 skill 里需要访问外部服务，密钥只从环境变量读取，不要写进仓库。
