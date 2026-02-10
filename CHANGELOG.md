# Changelog

All notable changes to the PF2E NPC Auto-Builder will be documented in this file.

## [1.2.0] - 2026-02-08

### Added
- Patreon OAuth authentication for access control
- Tier-based rate limiting (Free, Local Adventurer, Standard, Champion)
- Spell ID mapping from Foundry compendiums for proper spell linking
- Automatic validation error recovery with retry logic
- NPC data sanitization (invalid traits, item types, feat-to-action conversion)
- JSON export for generated NPCs
- Sidebar button injection for Actor and Compendium directories
- Header control registration across Foundry V13 hook variants

### Features
- AI-powered NPC generation via external service
- Support for name, level, and freeform description input
- Automatic spell compendium indexing when spell inclusion is enabled
- Truncated JSON response recovery for large payloads
- Invalid trait filtering for weapon strikes and items
- Feat-to-action conversion for NPC compatibility
