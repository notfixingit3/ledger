#!/bin/bash
set -e

VERSION="0.0.7"
DEST_DIR="$HOME/.config/opencode/plugins"
DEST_FILE="$DEST_DIR/ledger.ts"
REPO="notfixingit3/ledger"
CHANNEL="${LEDGER_CHANNEL:-stable}"
YES=0
NO_CONFIG=0
DRY_RUN=0
FORCE=0
UNINSTALL=0

usage() {
  cat <<'EOF'
OpenCode Ledger installer/upgrader

Usage:
  install.sh [options]

Options:
  -y, --yes              Update OpenCode config without prompting
      --no-config        Only install/update the plugin file
      --channel VALUE    Install from stable, main, dev, or a tag such as v0.0.6
      --dry-run          Show planned changes without writing files
      --force            Reinstall even when the installed version matches the target
      --uninstall        Remove Ledger config entries; leaves plugin files and backups in place
  -h, --help             Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes)
      YES=1
      ;;
    --no-config)
      NO_CONFIG=1
      ;;
    --channel)
      if [ "$#" -lt 2 ]; then
        echo "Error: --channel requires a value." >&2
        exit 1
      fi
      CHANNEL="$2"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --force)
      FORCE=1
      ;;
    --uninstall)
      UNINSTALL=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

case "$CHANNEL" in
  stable|main)
    REF="main"
    ;;
  dev)
    REF="dev"
    ;;
  *)
    REF="$CHANNEL"
    ;;
esac

RAW_BASE="https://raw.githubusercontent.com/$REPO/$REF"
RAW_URL="$RAW_BASE/index.ts"
PACKAGE_URL="$RAW_BASE/package.json"

timestamp="$(date +%Y%m%d%H%M%S)"

fetch_to_file() {
  url="$1"
  out="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    echo "Error: neither curl nor wget was found." >&2
    exit 1
  fi
}

fetch_text() {
  url="$1"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO - "$url"
  else
    echo "Error: neither curl nor wget was found." >&2
    exit 1
  fi
}

detect_installed_version() {
  if [ ! -f "$DEST_FILE" ]; then
    echo "not installed"
    return
  fi

  version="$(sed -n 's/.*LEDGER_VERSION[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$DEST_FILE" | head -1)"
  if [ -n "$version" ]; then
    echo "$version"
  else
    echo "unknown"
  fi
}

detect_target_version() {
  package_json="$(fetch_text "$PACKAGE_URL" 2>/dev/null || true)"
  version="$(printf '%s\n' "$package_json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  if [ -n "$version" ]; then
    echo "$version"
  else
    echo "unknown"
  fi
}

run_config_node() {
  action="$1"

  LEDGER_DEST_FILE="$DEST_FILE" \
  LEDGER_ACTION="$action" \
  LEDGER_DRY_RUN="$DRY_RUN" \
  node <<'NODE'
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
const configFiles = ['config.json', 'config.jsonc', 'opencode.json', 'opencode.jsonc'];
const destFile = process.env.LEDGER_DEST_FILE || path.join(opencodeDir, 'plugins', 'ledger.ts');
const newItem = pathToFileURL(destFile).href;
const obsoleteItems = new Set(['./plugins/ledger.ts', destFile]);
const action = process.env.LEDGER_ACTION || 'install';
const dryRun = process.env.LEDGER_DRY_RUN === '1';
const backupStamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

const commands = {
  ledger: {
    template: 'Use ledger tool. If command arguments ask for summary, set mode to summary; otherwise set mode to detail. Return only output.',
    description: 'Save multi-agent token and cost ledger',
  },
  'ledger-json': {
    template: 'Use ledger_json tool. Return only output.',
    description: 'Save multi-agent token and cost ledger as JSON',
  },
};

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
          propertyIndex: match.index,
          openIndex,
          closeIndex: index,
        };
      }
    }
  }

  throw new Error('Could not find the end of the ' + property + ' value.');
}

function findPluginArray(content) {
  return findTopLevelProperty(content, 'plugin', '[');
}

function findCommandObject(content) {
  return findTopLevelProperty(content, 'command', '{');
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

function removePluginFromList(list) {
  const kept = [];

  for (const item of splitTopLevelItems(list)) {
    const value = stringValue(item);
    if (value && (obsoleteItems.has(value) || value === newItem)) continue;
    kept.push(item.trim());
  }

  return '\n    ' + kept.filter(Boolean).join(',\n    ') + (kept.length > 0 ? '\n  ' : '\n  ');
}

function commandEntry(name, indent) {
  const command = commands[name];
  return [
    indent + quoted(name) + ': {',
    indent + '  "template": ' + quoted(command.template) + ',',
    indent + '  "description": ' + quoted(command.description),
    indent + '}',
  ].join('\n');
}

function replaceOrAddCommand(body, name) {
  if (new RegExp('"' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:').test(body)) {
    const existing = findTopLevelProperty(body, name, '{');
    if (!existing) return body;

    const lineStart = body.lastIndexOf('\n', existing.propertyIndex) + 1;
    const indent = body.slice(lineStart, existing.propertyIndex).match(/^\s*/)?.[0] || '    ';
    return body.slice(0, existing.propertyIndex)
      + commandEntry(name, indent)
      + body.slice(existing.closeIndex + 1);
  }

  return body.trim().length === 0
    ? '\n' + commandEntry(name, '    ') + '\n  '
    : body.replace(/\s*$/, '') + ',\n' + commandEntry(name, '    ') + '\n  ';
}

function removeCommand(body, name) {
  const existing = findTopLevelProperty(body, name, '{');
  if (!existing) return body;

  let start = existing.propertyIndex;
  let end = existing.closeIndex + 1;

  while (start > 0 && /\s/.test(body[start - 1])) start -= 1;
  if (body[end] === ',') {
    end += 1;
  } else {
    while (start > 0 && /\s/.test(body[start - 1])) start -= 1;
    if (body[start - 1] === ',') start -= 1;
  }

  return body.slice(0, start) + body.slice(end);
}

function ensureCommands(content) {
  const commandObject = findCommandObject(content);

  if (commandObject) {
    let body = content.slice(commandObject.openIndex + 1, commandObject.closeIndex);
    body = replaceOrAddCommand(body, 'ledger');
    body = replaceOrAddCommand(body, 'ledger-json');

    return content.slice(0, commandObject.openIndex + 1)
      + body
      + content.slice(commandObject.closeIndex);
  }

  return content.replace(
    /^(\s*\{)/,
    '$1\n  "command": {\n' + commandEntry('ledger', '    ') + ',\n' + commandEntry('ledger-json', '    ') + '\n  },',
  );
}

function removeCommands(content) {
  const commandObject = findCommandObject(content);
  if (!commandObject) return content;

  let body = content.slice(commandObject.openIndex + 1, commandObject.closeIndex);
  body = removeCommand(body, 'ledger');
  body = removeCommand(body, 'ledger-json');

  return content.slice(0, commandObject.openIndex + 1)
    + body
    + content.slice(commandObject.closeIndex);
}

function backupFile(filePath) {
  let backupPath = filePath + '.bak.' + backupStamp;
  let counter = 1;

  while (fs.existsSync(backupPath)) {
    backupPath = filePath + '.bak.' + backupStamp + '.' + counter;
    counter += 1;
  }

  if (!dryRun) fs.copyFileSync(filePath, backupPath);
  console.log((dryRun ? 'Would create backup: ' : 'Created backup: ') + backupPath);
}

function updateConfig(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;
  const pluginArray = findPluginArray(content);

  if (pluginArray) {
    const list = content.slice(pluginArray.openIndex + 1, pluginArray.closeIndex);
    const updatedList = action === 'uninstall' ? removePluginFromList(list) : normalizePluginList(list);
    content = content.slice(0, pluginArray.openIndex + 1)
      + updatedList
      + content.slice(pluginArray.closeIndex);
  } else if (action !== 'uninstall' && /^\s*\{/.test(content)) {
    content = content.replace(/^(\s*\{)/, '$1\n  "plugin": [\n    ' + quoted(newItem) + '\n  ],');
  } else if (action !== 'uninstall') {
    throw new Error('Config file does not look like a JSON object.');
  }

  content = action === 'uninstall' ? removeCommands(content) : ensureCommands(content);

  if (content === original) {
    console.log('No config changes needed in ' + path.basename(filePath));
    return;
  }

  backupFile(filePath);
  if (!dryRun) fs.writeFileSync(filePath, content, 'utf8');

  if (action === 'uninstall') {
    console.log((dryRun ? 'Would remove' : 'Removed') + ' Ledger config entries from ' + path.basename(filePath));
  } else {
    console.log((dryRun ? 'Would enable' : 'Enabled') + ' ledger plugin in ' + path.basename(filePath) + ' as ' + newItem);
    console.log((dryRun ? 'Would enable' : 'Enabled') + ' /ledger and /ledger-json commands in ' + path.basename(filePath));
  }
}

function createConfig() {
  const filePath = path.join(opencodeDir, 'config.json');
  const content = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    plugin: [newItem],
    command: commands,
  }, null, 2) + '\n';

  if (!dryRun) {
    fs.mkdirSync(opencodeDir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  console.log((dryRun ? 'Would create' : 'Created') + ' config.json and enabled ledger plugin as ' + newItem);
  console.log((dryRun ? 'Would enable' : 'Enabled') + ' /ledger and /ledger-json commands in config.json');
}

function verifyConfig(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  return content.includes(newItem) && /"ledger"\s*:/.test(content) && /"ledger-json"\s*:/.test(content);
}

if (!dryRun) fs.mkdirSync(opencodeDir, { recursive: true });

const existingConfigs = configFiles
  .map((file) => path.join(opencodeDir, file))
  .filter((filePath) => fs.existsSync(filePath));

if (existingConfigs.length === 0) {
  if (action === 'uninstall') {
    console.log('No OpenCode config files found; nothing to uninstall from config.');
  } else {
    createConfig();
  }
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
      if (action !== 'uninstall' && !dryRun) {
        console.log(verifyConfig(filePath)
          ? 'Verified config: ' + path.basename(filePath)
          : 'Warning: could not verify Ledger entries in ' + path.basename(filePath));
      }
    } catch (err) {
      console.error('Failed to update ' + path.basename(filePath) + ': ' + err.message);
    }
  });
}
NODE
}

echo "============================================="
echo "   OpenCode Ledger Plugin Installer/Upgrader v$VERSION"
echo "============================================="
echo ""
echo "Channel: $CHANNEL ($REF)"
echo "Plugin path: $DEST_FILE"

installed_version="$(detect_installed_version)"
echo "Installed version: $installed_version"
if [ "$UNINSTALL" -eq 0 ]; then
  target_version="$(detect_target_version)"
  echo "Target version: $target_version"
else
  target_version="uninstall"
fi
echo ""

if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$NO_CONFIG" -eq 1 ]; then
    echo "--uninstall with --no-config has nothing to do; Ledger plugin files are left in place."
    exit 0
  fi
  run_config_node uninstall
  echo ""
  echo "Uninstall complete. Plugin files and backups were left in place."
  exit 0
fi

mkdir -p "$DEST_DIR"

if [ "$installed_version" = "$target_version" ] && [ "$target_version" != "unknown" ] && [ "$FORCE" -eq 0 ]; then
  echo "Ledger is already at version $target_version. Use --force to reinstall."
else
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "Would download $RAW_URL"
    if [ -f "$DEST_FILE" ]; then
      echo "Would back up existing plugin to $DEST_FILE.bak.$timestamp"
    fi
    echo "Would write plugin to $DEST_FILE"
  else
    echo "Downloading or updating ledger plugin at $DEST_FILE..."
    tmp_file="$(mktemp "$DEST_DIR/ledger.ts.tmp.XXXXXX")"
    trap 'rm -f "$tmp_file"' EXIT

    fetch_to_file "$RAW_URL" "$tmp_file"

    if [ -f "$DEST_FILE" ]; then
      plugin_backup="$DEST_FILE.bak.$timestamp"
      cp "$DEST_FILE" "$plugin_backup"
      echo "Backed up existing plugin: $plugin_backup"
    fi

    mv "$tmp_file" "$DEST_FILE"
    trap - EXIT
    echo "Downloaded/updated ledger plugin successfully."

    if [ -f "$DEST_FILE" ]; then
      echo "Verified plugin file: $DEST_FILE"
    fi
  fi
fi

if [ "$NO_CONFIG" -eq 1 ]; then
  echo ""
  echo "Skipped config update because --no-config was set."
  echo "Restart OpenCode after updating your config manually if needed."
  exit 0
fi

if [ "$YES" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then
  confirm="y"
elif [ -t 2 ]; then
  if [ -t 0 ]; then
    read -p "Do you want to automatically enable/update the ledger plugin in your OpenCode configuration files? (y/n): " confirm
  elif [ -c /dev/tty ] && { true < /dev/tty; } 2>/dev/null; then
    read -p "Do you want to automatically enable/update the ledger plugin in your OpenCode configuration files? (y/n): " confirm < /dev/tty
  else
    read -p "Do you want to automatically enable/update the ledger plugin in your OpenCode configuration files? (y/n): " confirm
  fi
else
  read -p "Do you want to automatically enable/update the ledger plugin in your OpenCode configuration files? (y/n): " confirm
fi

if [[ "$confirm" =~ ^[Yy]$ ]]; then
  echo ""
  echo "Configuring OpenCode..."
  run_config_node install
  echo ""
  echo "Setup/upgrade complete. Restart OpenCode to use the latest ledger."
else
  echo ""
  echo "Skipped auto-configuration."
  echo "To enable the plugin manually, add the installed plugin file URL to the plugin array and add commands for ledger and ledger-json."
  echo "Restart OpenCode once configured."
fi
