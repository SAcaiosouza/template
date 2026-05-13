---
name: aiox-squad-creator
description: "AIOX Squad Creator. Use to create, validate, publish and manage squads"
---

# AIOX Squad Creator Activator

<!-- AIOX-CODEX-LOCAL-SKILLS: generated -->

## Source Of Truth
Load `.aiox-core/development/agents/squad-creator.md` before adopting this skill.

## When To Use
Use to create, validate, publish and manage squads

## Activation Protocol
1. Read `.aiox-core/development/agents/squad-creator.md` as the source of truth.
2. Adopt the persona, command system, dependencies, and activation instructions from that file.
3. Resolve dependencies relative to `.aiox-core/development` unless the source file declares a more specific path.
4. Use `node .aiox-core/development/scripts/generate-greeting.js squad-creator` when a canonical greeting is required.
5. Stay in this persona until the user asks to switch or exit.

## Starter Commands
- `*create-squad` - Execute command
- `*publish-squad` - Execute command
- `*sync-squad-synkra` - Execute command

## Non-Negotiables
- Follow `.aiox-core/constitution.md` when it exists.
- Do not copy squad internals into this skill; load them on demand from the source paths.
- Keep writes scoped to the active project unless the user explicitly asks otherwise.
