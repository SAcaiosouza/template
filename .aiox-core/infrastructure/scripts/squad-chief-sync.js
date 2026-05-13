#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const GENERATED_MARKER = '<!-- AIOX-SQUAD-CHIEF-SYNC: generated -->';

function tryRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (_error) {
    return null;
  }
}

function loadYaml(projectRoot) {
  const candidates = [
    'js-yaml',
    path.join(projectRoot, 'node_modules', 'js-yaml'),
    path.join(projectRoot, '.aiox-core', 'node_modules', 'js-yaml'),
  ];

  for (const candidate of candidates) {
    const mod = tryRequire(candidate);
    if (mod && typeof mod.load === 'function') return mod;
  }

  throw new Error('Unable to load js-yaml');
}

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    dryRun: false,
    quiet: false,
    targets: new Set(['antigravity', 'gemini', 'kimi']),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else if (arg === '--project-root' && argv[i + 1]) {
      options.projectRoot = argv[++i];
    } else if (arg === '--target' && argv[i + 1]) {
      options.targets = new Set(argv[++i].split(',').map((item) => item.trim()).filter(Boolean));
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.projectRoot = path.resolve(options.projectRoot);
  return options;
}

function printHelp() {
  console.log(`Squad chief sync

Usage:
  node .aiox-core/infrastructure/scripts/squad-chief-sync.js [options]

Options:
  --target <list>       Comma-separated targets: antigravity,gemini,kimi
  --project-root <dir>  Project root. Defaults to current directory.
  --dry-run, -n         Preview writes.
  --quiet, -q           Minimal output.
  --help, -h            Show help.
`);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath, content, options, results) {
  const rel = path.relative(options.projectRoot, filePath);
  if (options.dryRun) {
    results.push({ status: fs.existsSync(filePath) ? 'would_update' : 'would_create', path: rel });
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const current = fs.existsSync(filePath) ? readText(filePath) : '';
  if (current === content) {
    results.push({ status: 'unchanged', path: rel });
    return;
  }

  fs.writeFileSync(filePath, content, 'utf8');
  results.push({ status: current ? 'updated' : 'created', path: rel });
}

function listDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .map((name) => path.join(dirPath, name))
    .filter((filePath) => fs.statSync(filePath).isDirectory())
    .sort();
}

function listFiles(dirPath, predicate) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .map((name) => path.join(dirPath, name))
    .filter((filePath) => fs.statSync(filePath).isFile() && (!predicate || predicate(filePath)))
    .sort();
}

function slug(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function titleCaseSlug(value) {
  return slug(value)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function basenameNoExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function parseYamlText(text, yaml) {
  try {
    const parsed = yaml.load(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function extractYamlBlock(markdown) {
  const match = String(markdown || '').match(/```yaml\s*([\s\S]*?)```/i);
  return match ? match[1] : '';
}

function getNested(object, pathParts) {
  let current = object;
  for (const part of pathParts) {
    if (!current || typeof current !== 'object') return '';
    current = current[part];
  }
  return typeof current === 'string' ? current.trim() : '';
}

function findScalar(text, keys) {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(text || '').match(new RegExp(`^[ \\t]*${escaped}[ \\t]*:[ \\t]*['"]?([^'"\\n#]+)`, 'm'));
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

function parseAgentFile(filePath, yaml) {
  const raw = readText(filePath);
  const yamlBlock = extractYamlBlock(raw);
  const parsed = parseYamlText(yamlBlock, yaml);
  const agent = parsed.agent && typeof parsed.agent === 'object' ? parsed.agent : {};
  const id = slug(agent.id || basenameNoExt(filePath));
  const title = String(agent.title || '').trim() || findScalar(yamlBlock, ['title']) || basenameNoExt(filePath);
  const name = String(agent.name || '').trim() || findScalar(yamlBlock, ['name']) || title;
  const whenToUse =
    String(agent.whenToUse || '').trim() ||
    String(agent.when_to_use || '').trim() ||
    String(parsed.description || '').trim() ||
    `Use this squad chief to activate ${title}.`;
  const commands = collectCommands(parsed.commands).concat(collectCommandsFromText(yamlBlock));

  return { id, title, name, whenToUse, commands: uniqueCommands(commands), raw };
}

function collectCommands(node, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    node.forEach((item) => collectCommands(item, acc));
    return acc;
  }
  if (typeof node === 'string') {
    const parsed = parseCommandLine(node);
    if (parsed) acc.push(parsed);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  if (typeof node.command === 'string') {
    const parsed = parseCommandLine(node.command);
    if (parsed) {
      parsed.description = typeof node.description === 'string' && node.description.trim()
        ? node.description.trim()
        : parsed.description;
      acc.push(parsed);
    }
  }
  Object.keys(node).forEach((key) => collectCommands(node[key], acc));
  return acc;
}

function collectCommandsFromText(text) {
  const commands = [];
  const patterns = [
    /-\s+`?(\*[A-Za-z0-9:_-]+)`?\s+-\s+([^\n]+)/g,
    /-\s+['"]?(\*[A-Za-z0-9:_-]+)['"]?\s+-\s+([^\n]+)/g,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      commands.push({ name: match[1].trim(), description: (match[2] || 'Execute command').trim() });
      match = pattern.exec(text);
    }
  }

  return commands;
}

function parseCommandLine(value) {
  const match = String(value || '').trim().match(/^(\*[A-Za-z0-9:_-]+)(?:\s+[-:]\s+|\s+--\s+)?(.*)$/);
  if (!match) return null;
  return { name: match[1], description: match[2] || 'Execute command' };
}

function uniqueCommands(commands) {
  const seen = new Set();
  return commands.filter((command) => {
    const name = String(command.name || '').trim();
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function parseConfig(configPath, yaml) {
  const raw = readText(configPath);
  return { raw, parsed: parseYamlText(raw, yaml) };
}

function resolveEntryAgent(configData, squadDir) {
  const parsed = configData.parsed || {};
  const raw = configData.raw || '';
  const direct =
    getNested(parsed, ['entry_agent']) ||
    getNested(parsed, ['squad', 'entry_agent']) ||
    getNested(parsed, ['pack', 'entry_agent']) ||
    getNested(parsed, ['orchestrator', 'agent']) ||
    getNested(parsed, ['tier_system', 'orchestrator']) ||
    findScalar(raw, ['entry_agent', 'orchestrator', 'owner']);
  if (direct) return slug(direct);

  const agentsDir = path.join(squadDir, 'agents');
  const agentFiles = listFiles(agentsDir, (filePath) => path.extname(filePath) === '.md');
  const preferred = agentFiles.find((filePath) => /(^|-)chief$/i.test(basenameNoExt(filePath)));
  if (preferred) return slug(basenameNoExt(preferred));

  const anyChief = agentFiles.find((filePath) => /chief/i.test(basenameNoExt(filePath)));
  if (anyChief) return slug(basenameNoExt(anyChief));

  const orchestrator = agentFiles.find((filePath) => /orchestrator|lead/i.test(basenameNoExt(filePath)));
  if (orchestrator) return slug(basenameNoExt(orchestrator));

  return agentFiles[0] ? slug(basenameNoExt(agentFiles[0])) : '';
}

function resolveAgentFile(squadDir, configData, entryAgent) {
  const parsed = configData.parsed || {};

  if (Array.isArray(parsed.agents)) {
    const match = parsed.agents.find((agent) => agent && slug(agent.id) === entryAgent);
    if (match && typeof match.file === 'string' && match.file.trim()) {
      const candidate = path.join(squadDir, match.file.trim());
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const direct = path.join(squadDir, 'agents', `${entryAgent}.md`);
  if (fs.existsSync(direct)) return direct;

  const agentFiles = listFiles(path.join(squadDir, 'agents'), (filePath) => path.extname(filePath) === '.md');
  return agentFiles.find((filePath) => slug(basenameNoExt(filePath)) === entryAgent) || '';
}

function resolveSquadAlias(configData, squadName) {
  const parsed = configData.parsed || {};
  const raw = configData.raw || '';
  const alias =
    getNested(parsed, ['slashPrefix']) ||
    getNested(parsed, ['slash_prefix']) ||
    getNested(parsed, ['squad', 'slashPrefix']) ||
    getNested(parsed, ['squad', 'slash_prefix']) ||
    getNested(parsed, ['pack', 'slashPrefix']) ||
    getNested(parsed, ['pack', 'slash_prefix']) ||
    findScalar(raw, ['slashPrefix', 'slash_prefix']);
  return slug(alias || squadName);
}

function squadSkillId(squadName, entryAgent, squadAlias) {
  const alias = slug(squadAlias || '').replace(/^aiox-/, '');
  const squadBase = slug(squadName).replace(/^aiox-/, '');
  const entry = slug(entryAgent).replace(/^aiox-/, '');
  const entryRoot = entry.replace(/-(chief|master|orchestrator)$/i, '');
  const genericEntryRoots = new Set(['agent', 'chief', 'master', 'orchestrator', 'squad']);

  if (!entry) return `aiox-${squadBase || alias}`;
  if (entry === squadBase || entry.startsWith(`${squadBase}-`)) return `aiox-${entry}`;
  if (alias && (entry === alias || entry.startsWith(`${alias}-`))) return `aiox-${entry}`;
  if (entryRoot && !genericEntryRoots.has(entryRoot) && squadBase.startsWith(`${entryRoot}-`)) return `aiox-${entry}`;
  if (entryRoot && !genericEntryRoots.has(entryRoot) && entry.includes('-chief')) return `aiox-${entry}`;
  return `aiox-${squadBase || alias}-${entry}`;
}

function discoverSquadChiefs(projectRoot, yaml) {
  const squadsDir = path.join(projectRoot, 'squads');
  const usedTargetIds = new Set();
  const warnings = [];
  const chiefs = [];

  for (const squadDir of listDirs(squadsDir)) {
    const squadName = path.basename(squadDir);
    const configPath = path.join(squadDir, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      warnings.push(`Skipped ${squadName}: missing config.yaml`);
      continue;
    }

    const configData = parseConfig(configPath, yaml);
    const entryAgent = resolveEntryAgent(configData, squadDir);
    const sourceFile = entryAgent ? resolveAgentFile(squadDir, configData, entryAgent) : '';
    if (!entryAgent || !sourceFile) {
      warnings.push(`Skipped ${squadName}: entry agent not found`);
      continue;
    }

    const alias = resolveSquadAlias(configData, squadName);
    const skillId = squadSkillId(squadName, entryAgent, alias);
    let targetId = skillId.replace(/^aiox-/, '');
    if (usedTargetIds.has(targetId)) targetId = `${targetId}-${slug(squadName)}`;
    usedTargetIds.add(targetId);

    const agent = parseAgentFile(sourceFile, yaml);
    chiefs.push({
      squadName,
      alias,
      entryAgent,
      targetId,
      skillId: `aiox-${targetId}`,
      sourceFile,
      sourcePath: path.relative(projectRoot, sourceFile).replace(/\\/g, '/'),
      squadPath: path.relative(projectRoot, squadDir).replace(/\\/g, '/'),
      agent,
    });
  }

  return { chiefs, warnings };
}

function starterCommands(commands) {
  if (!commands.length) return '- `*help` - Show available commands';
  return commands.slice(0, 12).map((command) => `- \`${command.name}\` - ${command.description}`).join('\n');
}

function buildActivator(chief, targetName) {
  const commands = starterCommands(chief.agent.commands);
  return `# ${chief.agent.title} (${chief.squadName})

${GENERATED_MARKER}

## Source Of Truth
Read \`${chief.sourcePath}\` before activating this squad chief.

## Activation
1. Adopt the persona, command system, and activation instructions from \`${chief.sourcePath}\`.
2. Resolve squad dependencies relative to \`${chief.squadPath}\`.
3. Stay in this squad chief persona until the user asks to switch or exits.

## Invocation
- Squad: \`${chief.squadName}\`
- Entry agent: \`${chief.entryAgent}\`
- ${targetName} id: \`${chief.targetId}\`

## Starter Commands
${commands}

---
Generated by \`.aiox-core/infrastructure/scripts/squad-chief-sync.js\`.
`;
}

function buildKimiSkill(chief) {
  const description = `${chief.agent.title} for the ${chief.squadName} AIOX squad. ${chief.agent.whenToUse}`;
  const commands = chief.agent.commands.length
    ? chief.agent.commands.map((command) => `| \`${command.name}\` | ${command.description} |`).join('\n')
    : '| `*help` | Show available commands |';

  return `---
name: ${JSON.stringify(chief.skillId)}
description: ${JSON.stringify(description.slice(0, 240))}
---

# ${chief.agent.title} (${chief.squadName})

${GENERATED_MARKER}

## Activation Protocol

When this skill is invoked:

1. Read \`${chief.sourcePath}\` completely as the source of truth.
2. Adopt the squad chief persona and command system from that file.
3. Resolve dependencies relative to \`${chief.squadPath}\`.
4. Wait for user input unless a star command was provided.

## Star Commands

| Command | Description |
|---------|-------------|
${commands}

---

## Full Squad Chief Definition

${chief.agent.raw.trimEnd()}
`;
}

function writeChief(chief, options, results) {
  if (options.targets.has('antigravity')) {
    writeText(
      path.join(options.projectRoot, '.antigravity', 'agents', `${chief.targetId}.md`),
      chief.agent.raw,
      options,
      results,
    );
    writeText(
      path.join(options.projectRoot, '.antigravity', 'rules', 'agents', `${chief.targetId}.md`),
      buildActivator(chief, 'Antigravity'),
      options,
      results,
    );
  }

  if (options.targets.has('gemini')) {
    const content = `${buildActivator(chief, 'Gemini')}\n## Full Source\n\n${chief.agent.raw.trimEnd()}\n`;
    writeText(
      path.join(options.projectRoot, '.gemini', 'rules', 'AIOX', 'agents', `${chief.targetId}.md`),
      content,
      options,
      results,
    );
    writeText(
      path.join(options.projectRoot, '.gemini', 'rules', 'AIOX', 'squads', titleCaseSlug(chief.alias), 'agents', `${chief.targetId}.md`),
      content,
      options,
      results,
    );
  }

  if (options.targets.has('kimi')) {
    writeText(
      path.join(options.projectRoot, '.kimi', 'skills', chief.skillId, 'SKILL.md'),
      buildKimiSkill(chief),
      options,
      results,
    );
  }
}

function summarize(results) {
  return results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
}

function main() {
  const options = parseArgs(process.argv);
  const yaml = loadYaml(options.projectRoot);
  const { chiefs, warnings } = discoverSquadChiefs(options.projectRoot, yaml);
  const results = [];

  for (const chief of chiefs) writeChief(chief, options, results);

  if (!options.quiet) {
    console.log(`Project root: ${options.projectRoot}`);
    console.log(`Mode:         ${options.dryRun ? 'dry-run' : 'write'}`);
    console.log(`Targets:      ${Array.from(options.targets).join(', ')}`);
    console.log(`Chiefs:       ${chiefs.length}`);
    const summary = summarize(results);
    console.log(`Results:      ${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
    if (warnings.length) {
      console.log('\nWarnings:');
      warnings.forEach((warning) => console.log(`- ${warning}`));
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
