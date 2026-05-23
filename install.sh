#!/bin/bash
set -e

# Configuration
DEST_DIR="$HOME/.config/opencode/plugins"
DEST_FILE="$DEST_DIR/ledger.ts"
RAW_URL="https://raw.githubusercontent.com/notfixingit3/ledger/dev/index.ts"

echo "============================================="
echo "   OpenCode Ledger Plugin Installer v0.0.4"
echo "============================================="
echo ""

# 1. Ensure plugins directory exists
mkdir -p "$DEST_DIR"

# 2. Download index.ts to plugins/ledger.ts
echo "Downloading ledger plugin to $DEST_FILE..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$RAW_URL" -o "$DEST_FILE"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$DEST_FILE" "$RAW_URL"
else
  echo "❌ Error: Neither curl nor wget was found. Cannot download plugin."
  exit 1
fi

echo "✅ Downloaded ledger plugin successfully."
echo ""

# 3. Prompt user to enable the plugin automatically
# If stderr is a terminal, we have a user. Check if we should read from stdin or /dev/tty (for piped curl | sh)
if [ -t 2 ]; then
  if [ -t 0 ]; then
    read -p "Do you want to automatically enable the ledger plugin in your OpenCode configuration files? (y/n): " confirm
  elif [ -c /dev/tty ] && { true < /dev/tty; } 2>/dev/null; then
    read -p "Do you want to automatically enable the ledger plugin in your OpenCode configuration files? (y/n): " confirm < /dev/tty
  else
    read -p "Do you want to automatically enable the ledger plugin in your OpenCode configuration files? (y/n): " confirm
  fi
else
  # Non-interactive execution (CI/tests/background runner), read from stdin
  read -p "Do you want to automatically enable the ledger plugin in your OpenCode configuration files? (y/n): " confirm
fi

if [[ "$confirm" =~ ^[Yy]$ ]]; then
  echo ""
  echo "Attempting to auto-configure..."

  LEDGER_DEST_FILE="$DEST_FILE" node <<'NODE'
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
const configFiles = ['config.json', 'config.jsonc', 'opencode.json', 'opencode.jsonc'];
const destFile = process.env.LEDGER_DEST_FILE || path.join(opencodeDir, 'plugins', 'ledger.ts');
const newItem = pathToFileURL(destFile).href;
const obsoleteItems = new Set(['./plugins/ledger.ts', destFile]);
const ledgerCommandTemplate = 'Use ledger tool. Return only output.';

function quoted(value) {
  return JSON.stringify(value);
}

function splitTopLevelItems(list) {
  const items = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of list) {
    current += char;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '[' || char === '{' || char === '(') depth += 1;
    if (char === ']' || char === '}' || char === ')') depth -= 1;

    if (char === ',' && depth === 0) {
      items.push(current.slice(0, -1));
      current = '';
    }
  }

  if (current.trim()) items.push(current);
  return items;
}

function stringValue(raw) {
  const match = raw.trim().match(/^"([^"\\]*(?:\\.[^"\\]*)*)"\s*(?:(?:\/\/.*)|(?:\/\*[\s\S]*?\*\/))?$/);
  return match ? JSON.parse(match[0].match(/^"([^"\\]*(?:\\.[^"\\]*)*)"/)[0]) : null;
}

function normalizePluginList(list) {
  const kept = [];

  for (const item of splitTopLevelItems(list)) {
    const value = stringValue(item);
    if (value && (obsoleteItems.has(value) || value === newItem)) continue;
    kept.push(item.trim());
  }

  kept.push(quoted(newItem));
  return '\n    ' + kept.filter(Boolean).join(',\n    ') + '\n  ';
}

function findPluginArray(content) {
  return findTopLevelProperty(content, 'plugin', '[');
}

function findCommandObject(content) {
  return findTopLevelProperty(content, 'command', '{');
}

function findTopLevelProperty(content, property, openChar) {
  const match = new RegExp('"' + property + '"\\s*:\\s*\\' + openChar).exec(content);
  if (!match) return null;

  const closeChar = openChar === '[' ? ']' : '}';
  const openIndex = content.indexOf(openChar, match.index);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          openIndex,
          closeIndex: index,
        };
      }
    }
  }

  throw new Error('Could not find the end of the ' + property + ' value.');
}

function ledgerCommandEntry(indent) {
  return [
    indent + '"ledger": {',
    indent + '  "template": ' + quoted(ledgerCommandTemplate) + ',',
    indent + '  "description": "Show multi-agent token and cost ledger",',
    indent + '  "subtask": true',
    indent + '}',
  ].join('\n');
}

function ensureLedgerCommand(content) {
  const commandObject = findCommandObject(content);

  if (commandObject) {
    const body = content.slice(commandObject.openIndex + 1, commandObject.closeIndex);
    if (/"ledger"\s*:/.test(body)) return content;

    const updatedBody = body.trim().length === 0
      ? '\n' + ledgerCommandEntry('    ') + '\n  '
      : body.replace(/\s*$/, '') + ',\n' + ledgerCommandEntry('    ') + '\n  ';

    return content.slice(0, commandObject.openIndex + 1)
      + updatedBody
      + content.slice(commandObject.closeIndex);
  }

  return content.replace(/^(\s*\{)/, '$1\n  "command": {\n' + ledgerCommandEntry('    ') + '\n  },');
}

function updateConfig(filePath) {
  const backupPath = filePath + '.bak';
  fs.copyFileSync(filePath, backupPath);
  console.log('✅ Created backup: ' + backupPath);

  let content = fs.readFileSync(filePath, 'utf8');
  const pluginArray = findPluginArray(content);

  if (pluginArray) {
    const list = content.slice(pluginArray.openIndex + 1, pluginArray.closeIndex);
    content = content.slice(0, pluginArray.openIndex + 1)
      + normalizePluginList(list)
      + content.slice(pluginArray.closeIndex);
  } else if (/^\s*\{/.test(content)) {
    content = content.replace(/^(\s*\{)/, '$1\n  "plugin": [\n    ' + quoted(newItem) + '\n  ],');
  } else {
    throw new Error('Config file does not look like a JSON object.');
  }

  content = ensureLedgerCommand(content);

  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✅ Enabled ledger plugin in ' + path.basename(filePath) + ' as ' + newItem);
  console.log('✅ Enabled /ledger command in ' + path.basename(filePath));
}

fs.mkdirSync(opencodeDir, { recursive: true });

const existingConfigs = configFiles
  .map((file) => path.join(opencodeDir, file))
  .filter((filePath) => fs.existsSync(filePath));

if (existingConfigs.length === 0) {
  const filePath = path.join(opencodeDir, 'config.json');
  const content = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    plugin: [newItem],
    command: {
      ledger: {
        template: ledgerCommandTemplate,
        description: 'Show multi-agent token and cost ledger',
        subtask: true,
      },
    },
  }, null, 2) + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✅ Created config.json and enabled ledger plugin as ' + newItem);
  console.log('✅ Enabled /ledger command in config.json');
} else {
  const pluginConfigs = existingConfigs.filter((filePath) => {
    try {
      return Boolean(findPluginArray(fs.readFileSync(filePath, 'utf8')));
    } catch {
      return false;
    }
  });
  const targetConfigs = pluginConfigs.length > 0 ? pluginConfigs : [existingConfigs[0]];

  targetConfigs.forEach((filePath) => {
    try {
      updateConfig(filePath);
    } catch (err) {
      console.error('❌ Failed to update ' + path.basename(filePath) + ': ' + err.message);
    }
  });
}
NODE
  echo ""
  echo "🎉 Setup complete! Restart OpenCode to start tracking token costs."
else
  echo ""
  echo "Skipped auto-configuration."
  echo "To enable the plugin manually, add the installed plugin file URL to the \"plugin\" array in your ~/.config/opencode/config.json or config.jsonc:"
  echo ""
  echo "  \"plugin\": ["
  echo "    \"$(node -e "const { pathToFileURL } = require('url'); console.log(pathToFileURL(process.argv[1]).href)" "$DEST_FILE")\""
  echo "  ],"
  echo "  \"command\": {"
  echo "    \"ledger\": {"
  echo "      \"template\": \"Use ledger tool. Return only output.\","
  echo "      \"description\": \"Show multi-agent token and cost ledger\","
  echo "      \"subtask\": true"
  echo "    }"
  echo "  }"
  echo ""
  echo "Restart OpenCode once configured."
fi
