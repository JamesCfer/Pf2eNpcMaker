# PF2E NPC Auto-Builder

A [Foundry VTT](https://foundryvtt.com/) module for the [Pathfinder 2e](https://foundryvtt.com/packages/pf2e) system that generates complete NPCs using AI. Describe the NPC you want, and the builder creates a fully statted actor with abilities, equipment, and spells — ready to drag into your encounter.

## Features

- **AI-Powered Generation** — Provide a name, level, and freeform description. The builder handles stats, feats, equipment, and abilities.
- **Spell Compendium Integration** — Optionally maps generated spells to your installed Foundry compendium entries for proper linking.
- **Automatic Data Validation** — Sanitizes generated data, fixes invalid traits, converts incompatible item types, and retries on validation errors.
- **JSON Export** — Export any generated NPC as a JSON file for sharing or backup.
- **Patreon Authentication** — Access is managed through Patreon tiers with monthly generation limits.

## Requirements

- Foundry VTT **v13** or higher
- PF2e system module installed and active
- A [Patreon](https://www.patreon.com/c/CelestiaTools/membership) account for authentication

## Installation

### From Manifest URL

1. In Foundry VTT, go to **Add-on Modules** > **Install Module**
2. Paste the following manifest URL:
   ```
   https://github.com/JamesCfer/Pf2eNpcMaker/releases/latest/download/module.json
   ```
3. Click **Install**

### Manual Installation

1. Download the [latest release](https://github.com/JamesCfer/Pf2eNpcMaker/releases/latest)
2. Extract into your Foundry `Data/modules/pf2e-npc-auto-builder/` directory
3. Restart Foundry VTT

## Usage

1. **Enable the module** in your world's Module Management settings
2. **Open the builder** — Click the robot icon in the Actor Directory or Compendium Directory header
3. **Sign in with Patreon** — Click "Sign in with Patreon" and complete the OAuth flow
4. **Describe your NPC** — Enter a name, level (0–25), and a description of the NPC's role, fighting style, and abilities
5. **Generate** — Click "Generate NPC" and wait for the actor to be created (typically 30–60 seconds)
6. The generated NPC actor will open automatically and appear in your Actor Directory

### Tips for Better Results

- Be specific about combat role (e.g., "heavily armored frontline fighter" vs. "sneaky ambush predator")
- Mention special abilities or equipment you want (e.g., "wields a flaming greatsword", "can cast healing spells")
- Describe personality or tactics if relevant to the stat block

## Patreon Tiers

NPC generation is rate-limited per calendar month:

| Tier | NPCs / Month |
|------|-------------|
| Free | 3 |
| Local Adventurer | 15 |
| Standard | 50 |
| Champion | 80 |

[Support the project on Patreon](https://www.patreon.com/c/CelestiaTools/membership)

## License

This project is licensed under the [MIT License](LICENSE).

## Contributing

Contributions are welcome! Please open an issue to discuss proposed changes before submitting a pull request.

## Support

If you encounter bugs or have feature requests, please [open an issue](https://github.com/JamesCfer/Pf2eNpcMaker/issues).
