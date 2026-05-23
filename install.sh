#!/bin/bash
set -e

# Configuration
DEST_DIR="$HOME/.config/opencode/plugins"
DEST_FILE="$DEST_DIR/ledger.ts"
RAW_URL="https://raw.githubusercontent.com/notfixingit3/ledger/dev/index.ts"

echo "============================================="
echo "   OpenCode Ledger Plugin Installer v0.0.1"
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

  # Run inline Node.js script to modify opencode.json and opencode.jsonc
  node -e "
const fs = require('fs');
const path = require('path');
const os = require('os');

const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
const configFiles = ['opencode.json', 'opencode.jsonc'];
const newItem = './plugins/ledger.ts';

configFiles.forEach(file => {
  const filePath = path.join(opencodeDir, file);
  if (!fs.existsSync(filePath)) return;

  try {
    // Create a backup file
    const backupPath = filePath + '.bak';
    fs.copyFileSync(filePath, backupPath);
    console.log('✅ Created backup: ' + backupPath);

    // Read and modify the configuration file
    let content = fs.readFileSync(filePath, 'utf8');
    const pluginRegex = /(\"plugin\"\\s*:\\s*\\[)([\\s\\S]*?)(\\])/;
    
    if (pluginRegex.test(content)) {
      content = content.replace(pluginRegex, (match, prefix, list, suffix) => {
        if (list.includes(newItem)) {
          return match;
        }
        const trimmedList = list.trim();
        const separator = trimmedList.length > 0 && !trimmedList.endsWith(',') ? ',\n    ' : '\n    ';
        const formattedNewItem = '\"' + newItem + '\"';
        let updatedList = list;
        if (trimmedList.length === 0) {
          updatedList = '\\n    ' + formattedNewItem + '\\n  ';
        } else {
          updatedList = list.replace(/(\\s*)$/, separator + formattedNewItem + '$1');
        }
        return prefix + updatedList + suffix;
      });
    } else {
      const braceRegex = /^(\\s*\\{)/;
      if (braceRegex.test(content)) {
        content = content.replace(braceRegex, '$1\\n  \"plugin\": [\\n    \"' + newItem + '\"\\n  ],');
      }
    }
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('✅ Enabled ledger plugin in ' + file);
  } catch (err) {
    console.error('❌ Failed to update ' + file + ': ' + err.message);
  }
});
"
  echo ""
  echo "🎉 Setup complete! Restart OpenCode to start tracking token costs."
else
  echo ""
  echo "Skipped auto-configuration."
  echo "To enable the plugin manually, add \"./plugins/ledger.ts\" to the \"plugin\" array in your ~/.config/opencode/opencode.json or opencode.jsonc:"
  echo ""
  echo "  \"plugin\": ["
  echo "    \"./plugins/ledger.ts\""
  echo "  ]"
  echo ""
  echo "Restart OpenCode once configured."
fi
